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
from pathlib import Path
from typing import Iterator

# The birding-place contract is GENERATED from `functions/lib/place-rank.ts`
# into `place-contract.json`, not restated here.
#
# An earlier version of this file hand-copied `scoreOf()` and `kindOf()`. Review
# caught that copy already disagreeing with the real thing: `museum` scored 26
# instead of 19, `city` scored 20 instead of 14, whole fallback tiers were
# missing, and it emitted `kind` values that do not exist. A corpus built on
# those rules is not a measurement of the shipped contract, it is a measurement
# of a typo.
#
# `functions/lib/place-contract.test.ts` regenerates the artifact and fails if
# the committed copy is stale, so a rule change cannot silently leave the next
# corpus built on the previous rules.
CONTRACT_PATH = Path(__file__).with_name("place-contract.json")

# Alias boundary marker. Folding maps every punctuation character to a space,
# so a folded alias can never contain a pipe. Joining with spaces destroyed the
# boundaries: a two-word alias like `cap sainte anne` became indistinguishable
# from three single-word aliases, so the exact-match boost could never fire for
# any name containing a space, which is most of them.
ALIAS_SEPARATOR = "|"

WILDCARD = "*"


def load_contract(path: Path = CONTRACT_PATH) -> tuple[list, list]:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    return data["scoreRules"], data["kindRules"]


_SCORE_RULES: list = []
_KIND_RULES: list = []


def _first_match(rules: list, tags: dict):
    """Walk the exported chain and take the FIRST rule that matches.

    The rules are emitted in the order of the real if-chain, so this is the
    same decision the TypeScript makes. A lookup table keyed by tag cannot
    reproduce it, because precedence is interleaved across keys: a hotel in a
    park scores 25 from the park branch, while a zoo in a park scores 26 from
    the zoo branch. Score and kind are separate chains for the same reason,
    since that hotel scores as a park but is still KIND `lodging`.
    """
    for rule in rules:
        value = tags.get(rule["key"])
        if value is None:
            continue
        values = rule["values"]
        if WILDCARD in values or value in values:
            return rule
    return None


def score_of(t: dict) -> int:
    """Return the WingDex category score, or 0 for "not a birding place"."""
    rule = _first_match(_SCORE_RULES, t)
    return rule["score"] if rule else 0


def kind_of(t: dict) -> str:
    """A coarse label for grouping and for explaining a result in the UI."""
    rule = _first_match(_KIND_RULES, t)
    return rule["kind"] if rule else "other"


CONTROL_CHARS = {c: " " for c in range(0x20)}
CONTROL_CHARS[0x7F] = " "


def clean(s: str) -> str:
    """Strip control characters from a field before it enters the TSV.

    Replacing only tab and newline was not enough. OSM carries a bare CARRIAGE
    RETURN inside at least one name, `Little River\\r Gorge` (way237614464), and
    Python reads files in universal-newline mode, so a lone `\\r` starts a new
    line on the way back in. One such name split one record into two and the
    enrichment stage rejected the corpus.

    The whole C0 range plus DEL goes, rather than the specific characters that
    have bitten so far, because a display name has no legitimate use for any of
    them and the failure is silent until something downstream splits a row.

    Runs of whitespace collapse to one space, so removing a control character
    that sat next to a space does not leave a visible double space in a label.
    """
    return " ".join(s.translate(CONTROL_CHARS).split())


def fold(s: str) -> str:
    """Fold text for MATCHING only. Never used for display.

    NFKD then drop combining marks, so `Doñana` and `Donana` are the same
    token and a reader without the right keyboard can still find the place.
    Punctuation becomes a space rather than vanishing, so `Saint-Louis` yields
    two tokens and matches a `Saint Louis` query.

    Uses `str.lower`, NOT `str.casefold`, and that is deliberate.

    `casefold` is the linguistically better choice in isolation: it folds the
    German sharp s to `ss` and the Greek final sigma to an ordinary sigma. But
    this function has a TWIN, `foldQuery()` in `functions/lib/place-search.ts`,
    which folds the user's query at request time. JavaScript has no `casefold`,
    only `toLowerCase`, so choosing `casefold` here means the index and the
    query disagree, and the failure is silent: search returns nothing for a
    name that plainly contains the words.

    Auditing the whole BMP found 104 characters that reach this fold and differ under
    the two rules, mostly Cherokee plus the sharp s and final sigma. Patching
    the JavaScript to special-case them is a list that rots; matching the rule
    that BOTH languages implement natively does not. `place-search-folding.test.ts`
    runs this function and compares, so a future drift fails the build.
    """
    decomposed = unicodedata.normalize("NFKD", s)
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    out = []
    for ch in stripped.lower():
        if ch.isalnum():
            out.append(ch)
        elif unicodedata.category(ch).startswith(("P", "Z", "S")):
            out.append(" ")
    return " ".join("".join(out).split())


def _crossings(ring: list, y: float) -> list[float]:
    """X coordinates where the horizontal line at `y` crosses `ring`."""
    xs = []
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        if (y1 > y) != (y2 > y):
            xs.append(x1 + (y - y1) * (x2 - x1) / (y2 - y1))
    xs.sort()
    return xs


def _interior_spans(outer: list, holes: list, y: float) -> list[tuple[float, float]]:
    """Return (width, midpoint_x) for each span of `y` that is INSIDE the polygon.

    Holes are subtracted rather than ignored. Walking the merged crossing list
    and toggling depth means a span inside a hole is skipped, so a donut-shaped
    reserve yields the two spans of actual land and never the gap between them.
    """
    events = [(x, 0) for x in _crossings(outer, y)]
    for hole in holes:
        events.extend((x, 1) for x in _crossings(hole, y))
    if len(events) < 2:
        return []
    events.sort()
    spans = []
    inside_outer = False
    inside_hole = 0
    prev_x = None
    for x, kind in events:
        if prev_x is not None and inside_outer and inside_hole == 0 and x > prev_x:
            spans.append((x - prev_x, (prev_x + x) / 2.0))
        if kind == 0:
            inside_outer = not inside_outer
        else:
            inside_hole = 0 if inside_hole else 1
        prev_x = x
    return spans


def representative_point(geom: dict) -> tuple[float, float] | None:
    """Return (lat, lon) that lies ON the feature.

    A centroid is wrong here and the failure is not hypothetical: for a bay
    curved around a headland, or a reserve with a lake cut out of it, the
    centroid sits outside the polygon. Search results are "take me here"
    answers, so the point has to be on the thing.

    Polygons use a scanline point-on-surface: take a horizontal line, collect
    its crossings with the outer ring AND with every hole, and return the middle
    of the widest span that is inside the outer ring and outside every hole.
    Subtracting holes is load-bearing: for a ring-shaped reserve, the widest
    span between outer crossings alone is the hole itself. Lines use the
    midpoint VERTEX rather than an interpolated midpoint, so the point is always
    one the mapper actually placed, even on a coastline that doubles back.
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
        holes = [r for r in rings[1:] if len(r) >= 4]
        if len(outer) < 3:
            return None
        lats = [p[1] for p in outer]
        lo, hi = min(lats), max(lats)
        # Try several scanlines, not just the vertical midpoint.
        #
        # A single midpoint line is wrong for a donut: for a ring-shaped
        # reserve the midpoint crosses the hole, and taking the widest span
        # between OUTER crossings alone puts the point inside the hole,
        # violating the whole point of this function. Subtracting the hole
        # crossings fixes the common case; trying more offsets fixes shapes
        # where the midpoint line happens to be degenerate.
        for frac in (0.5, 0.25, 0.75, 0.1, 0.9):
            y = lo + (hi - lo) * frac
            spans = _interior_spans(outer, holes, y)
            if spans:
                width, x = max(spans)
                if width > 0:
                    return y, x
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

    The caller joins these with `ALIAS_SEPARATOR`, not with spaces, so a
    multi-word alias survives as one alias through loading.
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
        # Do NOT trust OSM's `importance` tag, even when it parses as a number.
        #
        # OSM carries its own free-text `importance` (`national`, `regional`,
        # and one entry reading `Bulgarian 100`), which collides with the
        # Wikipedia-derived score the reverse archive bakes in. Accepting a
        # numeric-looking OSM value here made it authoritative and BLOCKED the
        # QID join in the loader, so that record could rank differently from
        # reverse search for no reason a reader could see.
        #
        # Importance comes from one place only: the QID table, joined in
        # `build-search-db.py` against the same `qid-importance.tsv` the
        # archive uses. The column stays empty here.
        imp_out = ""
        yield (
            f"{otype}{oid}",
            clean(display),
            f"{lat:.6f}",
            f"{lon:.6f}",
            str(score),
            kind_of(tags),
            imp_out,
            tags.get("wikidata") or "",
            ALIAS_SEPARATOR.join(clean(a) for a in alias),
        )


def main() -> int:
    global _SCORE_RULES, _KIND_RULES
    _SCORE_RULES, _KIND_RULES = load_contract()
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
