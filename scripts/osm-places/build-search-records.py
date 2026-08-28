#!/usr/bin/env python3
"""Build canonical forward-search records from an exported OSM region.

Phase 1 of issue #343. Reads the GeoJSONSeq that `osmium export` writes from an
already-filtered regional PBF and emits one TSV row per OSM object, ready for
SQLite FTS5 import.

This is the OFFLINE half. It decides three things the runtime must not have to:

1. WHICH objects are searchable. The contract is shared with the reverse
   archive: `scoreOf()` in `functions/lib/place-rank.ts` decides what counts as
   a birding place, and anything it scores 0 is not one. Streets, house numbers
   and postcodes never enter, because the upstream `FILTER` never selects them.

2. WHERE a result points. A search hit needs ONE coordinate. For a node that is
   the node. For a way or relation it must be a point ON the feature, which a
   centroid is not: the centroid of a C-shaped bay or a ring-shaped reserve
   falls outside it, so "go here" would point at water or at a hole. This uses
   a point-on-surface for polygons and the midpoint VERTEX for lines.

3. HOW text is matched. Normalisation is deterministic and happens once here,
   never at query time, so the index and the query agree by construction.
   Display strings are preserved separately and are never folded.
"""
from __future__ import annotations

import json
import sys
import unicodedata
from typing import Iterator

# Mirrors scoreOf()/kindOf() in functions/lib/place-rank.ts. Kept as data rather
# than prose so a drift between forward and reverse search is a diff, not a
# discrepancy someone notices in production.
ATTRACTION = {"zoo", "aquarium", "theme_park", "museum"}
POI_MARKER = {"viewpoint", "attraction"}
LODGING = {"hotel", "motel", "guest_house", "hostel", "chalet", "camp_site", "caravan_site"}
NEARBY_LANDMARK = {"picnic_site", "artwork", "information"}
BIRD_WATER = {"water", "bay", "strait", "wetland", "beach", "coastline", "spring", "hot_spring"}
BIRD_LAND = {"wood", "scrub", "heath", "grassland", "sand", "mud", "cliff", "peak", "ridge", "valley"}
SETTLEMENT = {
    "city": 20, "town": 18, "village": 17, "hamlet": 16, "suburb": 16,
    "neighbourhood": 15, "borough": 15, "municipality": 15, "quarter": 14,
    "locality": 12, "isolated_dwelling": 12, "farm": 12,
}


def score_of(t: dict) -> int:
    """Return the WingDex category score, or 0 for "not a birding place"."""
    tourism, leisure = t.get("tourism"), t.get("leisure")
    natural, boundary = t.get("natural"), t.get("boundary")
    landuse, place = t.get("landuse"), t.get("place")

    if tourism in ATTRACTION:
        return 26
    if leisure in ("garden", "park", "nature_reserve"):
        return 25
    if natural in BIRD_WATER or boundary in ("protected_area", "national_park") or tourism in POI_MARKER:
        return 24
    if leisure == "golf_course" or landuse in ("forest", "recreation_ground") or natural in BIRD_LAND:
        return 22
    if place in ("island", "islet"):
        return 21
    if tourism in LODGING or tourism in NEARBY_LANDMARK:
        return 19
    if place in SETTLEMENT:
        return SETTLEMENT[place]
    return 0


def kind_of(t: dict) -> str:
    """A coarse label for grouping and for explaining a result in the UI."""
    tourism, leisure = t.get("tourism"), t.get("leisure")
    natural, boundary = t.get("natural"), t.get("boundary")
    landuse, place = t.get("landuse"), t.get("place")
    if leisure == "golf_course":
        return "golf-course"
    if leisure in ("park", "garden"):
        return "park"
    if leisure == "nature_reserve" or boundary in ("protected_area", "national_park"):
        return "reserve"
    if tourism in ATTRACTION:
        return "attraction"
    if tourism in LODGING:
        return "lodging"
    if tourism:
        return "poi"
    if natural in BIRD_WATER:
        return "water"
    if natural:
        return "natural-other"
    if landuse:
        return "landcover"
    if place:
        return "place"
    return "other"


def fold(s: str) -> str:
    """Fold text for MATCHING only. Never used for display.

    NFKD then drop combining marks, so `Doñana` and `Donana` are the same
    token and a reader without the right keyboard can still find the place.
    Case folding is `str.casefold`, not `lower`, because `lower` gets the
    German sharp s wrong. Punctuation becomes a space rather than vanishing, so
    `Saint-Louis` yields two tokens and matches a `Saint Louis` query.
    """
    decomposed = unicodedata.normalize("NFKD", s)
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    out = []
    for ch in stripped.casefold():
        if ch.isalnum():
            out.append(ch)
        elif unicodedata.category(ch).startswith(("P", "Z", "S")):
            out.append(" ")
    return " ".join("".join(out).split())


def representative_point(geom: dict) -> tuple[float, float] | None:
    """Return (lat, lon) that lies ON the feature.

    A centroid is wrong here and the failure is not hypothetical: for a bay
    curved around a headland, or a reserve with a lake cut out of it, the
    centroid sits outside the polygon. Search results are "take me here"
    answers, so the point has to be on the thing.

    Polygons use a scanline point-on-surface: take the horizontal line at the
    vertical midpoint, collect its crossings with the ring, and return the
    middle of the WIDEST interior span. That lands inside a C shape and inside
    a ring with a hole, which a centroid does not. Lines use the midpoint
    VERTEX rather than an interpolated midpoint, so the point is always one the
    mapper actually placed, even on a coastline that doubles back.
    """
    gtype, coords = geom.get("type"), geom.get("coordinates")
    if not coords:
        return None

    if gtype == "Point":
        return coords[1], coords[0]

    if gtype == "MultiPoint":
        return coords[0][1], coords[0][0]

    if gtype in ("LineString", "MultiLineString"):
        line = coords if gtype == "LineString" else max(coords, key=len)
        if not line:
            return None
        lon, lat = line[len(line) // 2]
        return lat, lon

    if gtype in ("Polygon", "MultiPolygon"):
        # Largest ring by vertex count stands in for largest by area: this only
        # picks WHICH part of a multipolygon to point at, and the detailed ring
        # is the significant one. Cheaper than computing area per ring over a
        # planet-scale corpus.
        rings = coords if gtype == "Polygon" else max(coords, key=lambda p: len(p[0]))
        outer = rings[0]
        if len(outer) < 3:
            return None
        lats = [p[1] for p in outer]
        y = (min(lats) + max(lats)) / 2.0
        xs = []
        for i in range(len(outer) - 1):
            x1, y1 = outer[i]
            x2, y2 = outer[i + 1]
            if (y1 > y) != (y2 > y):
                xs.append(x1 + (y - y1) * (x2 - x1) / (y2 - y1))
        xs.sort()
        if len(xs) >= 2:
            best, bx = 0.0, None
            for i in range(0, len(xs) - 1, 2):
                span = xs[i + 1] - xs[i]
                if span > best:
                    best, bx = span, (xs[i] + xs[i + 1]) / 2.0
            if bx is not None:
                return y, bx
        # Degenerate ring (all vertices on one line): fall back to a vertex,
        # which is still ON the feature, rather than to an averaged point.
        return outer[0][1], outer[0][0]

    return None


def aliases_for(tags: dict, display: str) -> list[str]:
    """Bounded alias set: the names a person might actually type.

    Deliberately NOT every `name:*`. A planet-wide corpus carries dozens of
    language variants per famous feature, and each one costs index bytes while
    only the local name, the English name and the mapper's own alternates get
    typed by this app's users. That bound is what keeps the 7 GB gate reachable.
    """
    seen, out = set(), []
    for key in ("name", "name:en", "int_name", "alt_name", "official_name", "short_name"):
        raw = tags.get(key)
        if not raw:
            continue
        for part in str(raw).split(";"):
            f = fold(part)
            if f and f not in seen:
                seen.add(f)
                out.append(f)
    f = fold(display)
    if f and f not in seen:
        out.insert(0, f)
    return out


def records(stream: Iterator[str]) -> Iterator[tuple]:
    for line in stream:
        line = line.strip().lstrip("\x1e")
        if not line:
            continue
        try:
            feat = json.loads(line)
        except json.JSONDecodeError:
            continue
        tags = feat.get("properties") or {}
        display = tags.get("name") or tags.get("name:en")
        if not display:
            continue
        score = score_of(tags)
        if score == 0:
            continue
        point = representative_point(feat.get("geometry") or {})
        if point is None:
            continue
        lat, lon = point
        if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
            continue
        meta = feat.get("properties") or {}
        # osmium writes identity INTO properties as `@type`/`@id` when the export
        # config asks for attributes, not as a top-level `id` member. Reading
        # the wrong place silently drops every record, because the guard below
        # then rejects all of them.
        otype, oid = meta.get("@type"), meta.get("@id")
        if otype is None or oid is None:
            continue
        alias = aliases_for(tags, display)
        if not alias:
            continue
        imp = tags.get("importance")
        yield (
            f"{otype}{oid}",
            display.replace("\t", " ").replace("\n", " "),
            f"{lat:.6f}",
            f"{lon:.6f}",
            str(score),
            kind_of(tags),
            str(imp) if imp not in (None, "") else "",
            tags.get("wikidata") or "",
            " ".join(alias),
        )


def main() -> int:
    n = 0
    out = sys.stdout
    for row in records(sys.stdin):
        out.write("\t".join(row))
        out.write("\n")
        n += 1
    print(f"  search records: {n:,}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
