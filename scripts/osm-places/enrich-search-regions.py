#!/usr/bin/env python3
"""Attach ISO 3166 region codes to search records offline.

Phase 1 step 4 of issue #343: "Runtime search should not need a PMTiles lookup
for every result." The reverse route resolves region codes by reading the
archive's `admin` layer for one coordinate. Forward search returns up to five
results from anywhere on earth, so doing the same at query time would mean up
to five extra R2 range reads per search. Resolving it once at build time makes
that cost zero.

Codes come from the SAME admin boundaries the reverse archive uses
(`boundary=administrative`, admin_level 2-4), so the two systems cannot report
a different country for the same place.

The naive form of this join is 3.5 million points against roughly 4,000
polygons, which is 14 billion point-in-ring tests. Instead this bins polygon
bounding boxes into a 1-degree grid, so each point tests only the handful of
polygons whose bounding box covers its cell.
"""
from __future__ import annotations

import json
import re
import sys
from collections import defaultdict

ISO_3166_2 = re.compile(r"^([A-Z]{2})-")


def rings_of(geom: dict) -> list[tuple[list, list]]:
    """Return [(outer, [holes...])] for a Polygon or MultiPolygon."""
    t, c = geom.get("type"), geom.get("coordinates")
    if not c:
        return []
    if t == "Polygon":
        return [(c[0], list(c[1:]))]
    if t == "MultiPolygon":
        return [(p[0], list(p[1:])) for p in c if p]
    return []


def point_in_ring(x: float, y: float, ring: list) -> bool:
    inside = False
    n = len(ring)
    for i in range(n - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        if (y1 > y) != (y2 > y):
            if x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
                inside = not inside
    return inside


def ring_area(ring: list) -> float:
    """Absolute shoelace area in square degrees.

    Only ever used to ORDER containing polygons by size, never as a real area,
    so the lack of a projection does not matter here.
    """
    s = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: enrich-search-regions.py <admin.geojsonseq> <records.tsv>", file=sys.stderr)
        return 1
    admin_path, records_path = sys.argv[1], sys.argv[2]

    polygons = []
    grid: dict[tuple[int, int], list[int]] = defaultdict(list)
    with open(admin_path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip().lstrip("\x1e")
            if not line:
                continue
            try:
                feat = json.loads(line)
            except json.JSONDecodeError:
                continue
            props = feat.get("properties") or {}
            state = props.get("ISO3166-2")
            country = props.get("ISO3166-1:alpha2") or props.get("ISO3166-1")
            if not state and not country:
                continue
            for outer, holes in rings_of(feat.get("geometry") or {}):
                if len(outer) < 4:
                    continue
                xs = [p[0] for p in outer]
                ys = [p[1] for p in outer]
                idx = len(polygons)
                polygons.append((min(xs), min(ys), max(xs), max(ys), outer, holes,
                                 state, country, ring_area(outer)))
                for gx in range(int(min(xs) // 1), int(max(xs) // 1) + 1):
                    for gy in range(int(min(ys) // 1), int(max(ys) // 1) + 1):
                        grid[(gx, gy)].append(idx)

    print(f"  admin polygons: {len(polygons):,} in {len(grid):,} grid cells", file=sys.stderr)

    total = 0
    with_state = 0
    with_country = 0
    out = sys.stdout
    with open(records_path, encoding="utf-8") as fh:
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if len(parts) != 9:
                continue
            total += 1
            lat, lon = float(parts[2]), float(parts[3])
            hits = []
            for idx in grid.get((int(lon // 1), int(lat // 1)), ()):
                minx, miny, maxx, maxy, outer, holes, state, country, area = polygons[idx]
                if not (minx <= lon <= maxx and miny <= lat <= maxy):
                    continue
                if not point_in_ring(lon, lat, outer):
                    continue
                if any(point_in_ring(lon, lat, h) for h in holes):
                    continue
                hits.append((area, state, country))
            state = country = ""
            if hits:
                # Smallest containing polygon wins: a subdivision is a more
                # precise answer than the country that contains it.
                hits.sort(key=lambda h: h[0])
                state = next((h[1] for h in hits if h[1]), "") or ""
                # Derive the country FROM the subdivision code rather than
                # trusting a country tag on the same polygon. Puerto Rico's
                # admin_level=4 boundary carries BOTH `ISO3166-2=US-PR` and
                # `ISO3166-1=PR`, so the tag yields `PR` while the checklist
                # belongs to `US`. This mirrors the identical fix in
                # `functions/lib/osm-places.ts`, deliberately, so forward and
                # reverse search cannot disagree.
                implied = ISO_3166_2.match(state).group(1) if ISO_3166_2.match(state) else ""
                country = implied or next((h[2] for h in hits if h[2]), "") or ""
            if state:
                with_state += 1
            if country:
                with_country += 1
            out.write("\t".join(parts + [state, country]))
            out.write("\n")

    print(f"  enriched: {total:,} records, {with_state:,} with a subdivision "
          f"({100 * with_state / max(total, 1):.1f}%), {with_country:,} with a country "
          f"({100 * with_country / max(total, 1):.1f}%)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
