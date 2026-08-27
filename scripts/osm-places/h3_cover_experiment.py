#!/usr/bin/env python3
"""Measure the H3-covering approach for serverless reverse geocoding.

The idea, which is the opposite of what failed: instead of storing polygon
GEOMETRY per cell and doing point-in-polygon at runtime, precompute at build time
which H3 cells each park covers, and store a flat map of

    h3_cell -> (name, score)

Runtime becomes ONE key lookup with zero geometry decode and zero floating-point
work. That sidesteps both failures of the previous attempt: no duplicated geometry
(a large park contributes many cheap cell IDs, not many copies of its ring), and no
per-request CPU cost for ray casting.

The question this answers: how many cells, and how many bytes, for real data.
"""
import gzip
import json
import os
import sys
from collections import defaultdict

import h3

GEOJSON = '/mnt/nas/wikidata/wa-parks.geojson'

SCORES = [
    (('leisure', 'park'), 100),
    (('boundary', 'protected_area'), 95),
    (('boundary', 'national_park'), 95),
    (('leisure', 'nature_reserve'), 95),
    (('leisure', 'garden'), 80),
    (('natural', None), 80),
    (('landuse', 'forest'), 72),
]


def score_of(tags):
    for (key, val), s in SCORES:
        if key in tags and (val is None or tags[key] == val):
            return s
    return 0


def main():
    res = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    print('H3 resolution %d (edge ~%.0f m)' % (res, h3.average_hexagon_edge_length(res, unit='m')), flush=True)

    # cell -> (score, name). Highest score wins; the tuned scorer already encodes
    # "a park beats the forest containing it".
    cover = {}
    polys = 0
    huge = 0

    with open(GEOJSON, encoding='utf-8') as fh:
        for line in fh:
            line = line.strip().rstrip(",")
            if not line or line[0] != '{':
                continue
            try:
                feat = json.loads(line)
            except Exception:
                continue
            geom = feat.get('geometry') or {}
            props = feat.get('properties') or {}
            name = props.get('name') or props.get('name:en')
            if not name:
                continue
            s = score_of(props)
            if s == 0:
                continue
            gtype = geom.get('type')
            if gtype == 'Polygon':
                rings = [geom['coordinates'][0]]
            elif gtype == 'MultiPolygon':
                rings = [p[0] for p in geom['coordinates']]
            else:
                continue

            for ring in rings:
                if len(ring) < 4:
                    continue
                # Guard: a huge ring at high resolution can produce millions of
                # cells. Skip and count, so the number is visible rather than
                # silently blowing up memory.
                lons = [p[0] for p in ring]
                lats = [p[1] for p in ring]
                span = max(lons) - min(lons) + max(lats) - min(lats)
                if span > 3.0:
                    huge += 1
                    continue
                try:
                    poly = h3.LatLngPoly([(p[1], p[0]) for p in ring])
                    cells = h3.polygon_to_cells(poly, res)
                except Exception:
                    continue
                polys += 1
                for c in cells:
                    prev = cover.get(c)
                    if prev is None or s > prev[0]:
                        cover[c] = (s, name[:60])

    print('polygons covered %d  (skipped %d oversized)' % (polys, huge))
    print('distinct H3 cells %d' % len(cover))

    # Size it the way it would actually ship: group cells by a coarse parent so a
    # Worker fetches one small object, exactly like the range-priors pattern.
    groups = defaultdict(dict)
    for c, (s, n) in cover.items():
        groups[h3.cell_to_parent(c, 5)][c] = n

    sizes = []
    for parent, mapping in groups.items():
        blob = gzip.compress(json.dumps(mapping, separators=(',', ':')).encode('utf-8'), 9)
        sizes.append(len(blob))
    sizes.sort()
    print('groups (res-5 parents) %d' % len(sizes))
    print('  median %7.1f KB   p90 %7.1f KB   max %7.1f KB   TOTAL %6.1f MB'
          % (sizes[len(sizes) // 2] / 1024, sizes[int(len(sizes) * 0.9)] / 1024,
             sizes[-1] / 1024, sum(sizes) / 1e6))

    # Does it get the real photo coordinates right?
    photos = [
        ('Discovery Park', 47.65976, -122.42877),
        ('Carkeek Park 1', 47.71170, -122.37706),
        ('Union Bay Natural Area 1', 47.65426, -122.29524),
        ('Union Bay Natural Area 2', 47.65597, -122.29697),
        ('Union Bay Natural Area 3', 47.65441, -122.29474),
        ('Seattle Arboretum', 47.64244, -122.29497),
        ('Magnolia backyard', 47.63467, -122.39825),
        ('Seattle waterfront', 47.60931, -122.34204),
    ]
    print()
    hit = 0
    for label, lat, lon in photos:
        c = h3.latlng_to_cell(lat, lon, res)
        v = cover.get(c)
        if v:
            hit += 1
            print('  %-26s %s' % (label, v[1]))
        else:
            print('  %-26s -- none --' % label)
    print('  named %d of %d' % (hit, len(photos)))


if __name__ == '__main__':
    main()
