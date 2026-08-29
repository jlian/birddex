#!/usr/bin/env python3
"""OSM polygon cells for R2, v3: finer grid + near-miss fallback.

Two fixes over v2:

GRID. v2 reused the 27 km range-priors grid and hit p90 132 KB per cell. Range
priors need a coarse grid because a species range IS coarse; park boundaries are
not. A 9 km grid cuts the payload without changing the R2 access pattern.

NEAR MISS. Two of three Union Bay coordinates landed inside the polygon and one
did not, because OSM boundaries do not always match where a birder stands. Strict
containment answers "no" there, which is worse than useless. v3 falls back to the
nearest polygon edge within a small buffer, and reports which mode answered so the
caller can tell an exact hit from a near miss.
"""
import gzip
import json
import math
import os
import sys
from collections import defaultdict

GEOJSON = '/mnt/nas/wikidata/wa-parks.geojson'
OUTDIR = '/mnt/nas/wikidata/cells3'

GRID_CELL_SIZE = 9000.0
GRID_COLS = 3828
GRID_ROWS = 1854

# Metres of slack allowed outside a polygon before we give up. Roughly the width
# of a path plus GPS error.
NEAR_MISS_M = 120.0

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


def lonlat_to_equal_earth(lon, lat):
    lam = math.radians(lon)
    phi = math.radians(lat)
    a1, a2, a3, a4 = 1.340264, -0.081106, 0.000893, 0.003796
    t = math.asin(math.sqrt(3) / 2 * math.sin(phi))
    t2 = t * t
    t6 = t2 * t2 * t2
    x = (2 * math.sqrt(3) * lam * math.cos(t)
         / (3 * (9 * a4 * t6 * t2 + 7 * a3 * t6 + 3 * a2 * t2 + a1)))
    y = t * (a1 + a2 * t2 + t6 * (a3 + a4 * t2))
    return x * 6371000.0, y * 6371000.0


X0, _A = lonlat_to_equal_earth(-180.0, 0.0)
_B, Y0 = lonlat_to_equal_earth(0.0, 90.0)


def cell_of(lon, lat):
    px, py = lonlat_to_equal_earth(lon, lat)
    col = int((px - X0) // GRID_CELL_SIZE)
    row = int((Y0 - py) // GRID_CELL_SIZE)
    if 0 <= col < GRID_COLS and 0 <= row < GRID_ROWS:
        return row, col
    return None


def cells_for_bbox(min_lon, min_lat, max_lon, max_lat):
    out = set()
    step = 0.05
    lat = min_lat
    while True:
        lon = min_lon
        while True:
            c = cell_of(lon, lat)
            if c:
                out.add(c)
            if lon >= max_lon:
                break
            lon = min(lon + step, max_lon)
        if lat >= max_lat:
            break
        lat = min(lat + step, max_lat)
    return out


def build():
    cells = defaultdict(list)
    kept = 0
    dup = 0

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
                rings = [poly[0] for poly in geom['coordinates']]
            else:
                continue

            for ring in rings:
                if len(ring) < 4:
                    continue
                lons = [p[0] for p in ring]
                lats = [p[1] for p in ring]
                simple = [ring[0]]
                for p in ring[1:]:
                    q = simple[-1]
                    if abs(p[0] - q[0]) > 0.0003 or abs(p[1] - q[1]) > 0.0003:
                        simple.append(p)
                if len(simple) < 4:
                    simple = ring[:: max(1, len(ring) // 8)]
                if len(simple) < 4:
                    continue
                rec = {
                    'n': name[:80],
                    's': s,
                    'b': [round(min(lons), 5), round(min(lats), 5),
                          round(max(lons), 5), round(max(lats), 5)],
                    'g': [[round(p[0], 5), round(p[1], 5)] for p in simple],
                }
                touched = cells_for_bbox(min(lons), min(lats), max(lons), max(lats))
                for c in touched:
                    cells[c].append(rec)
                kept += 1
                dup += len(touched)

    os.makedirs(OUTDIR, exist_ok=True)
    sizes = []
    for (row, col), feats in cells.items():
        feats.sort(key=lambda f: -f["s"])
        blob = gzip.compress(json.dumps(feats, separators=(',', ':')).encode('utf-8'), 9)
        with open(os.path.join(OUTDIR, '%d-%d.json.gz' % (row, col)), 'wb') as fh:
            fh.write(blob)
        sizes.append(len(blob))

    sizes.sort()
    print('polygons %d, cell-copies %d (%.2fx duplication)'
          % (kept, dup, dup / max(1, kept)))
    print('cells %d   median %.1f KB   p90 %.1f KB   max %.1f KB   TOTAL %.1f MB'
          % (len(sizes), sizes[len(sizes) // 2] / 1024,
             sizes[int(len(sizes) * 0.9)] / 1024, sizes[-1] / 1024,
             sum(sizes) / 1e6))


def point_in_ring(lon, lat, ring):
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if ((yi > lat) != (yj > lat)) and \
           (lon < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def dist_to_ring_m(lon, lat, ring):
    """Approximate metres from a point to the nearest polygon edge."""
    mlat = 111320.0
    mlon = 111320.0 * max(0.2, math.cos(math.radians(lat)))
    best = float("inf")
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        ax = (x1 - lon) * mlon
        ay = (y1 - lat) * mlat
        bx = (x2 - lon) * mlon
        by = (y2 - lat) * mlat
        dx = bx - ax
        dy = by - ay
        seg = dx * dx + dy * dy
        if seg <= 0:
            d = math.hypot(ax, ay)
        else:
            t = max(0.0, min(1.0, -(ax * dx + ay * dy) / seg))
            d = math.hypot(ax + t * dx, ay + t * dy)
        if d < best:
            best = d
    return best


def lookup(lat, lon):
    c = cell_of(lon, lat)
    if not c:
        return None
    path = os.path.join(OUTDIR, '%d-%d.json.gz' % c)
    if not os.path.exists(path):
        return None
    with gzip.open(path, 'rb') as fh:
        feats = json.load(fh)

    inside = []
    near = []
    pad = NEAR_MISS_M / 111320.0 * 1.5
    for f in feats:
        b = f['b']
        if not (b[0] - pad <= lon <= b[2] + pad and b[1] - pad <= lat <= b[3] + pad):
            continue
        area = (b[2] - b[0]) * (b[3] - b[1])
        if point_in_ring(lon, lat, f['g']):
            inside.append((f, area, 0.0))
        else:
            d = dist_to_ring_m(lon, lat, f['g'])
            if d <= NEAR_MISS_M:
                near.append((f, area, d))

    if inside:
        inside.sort(key=lambda t: (-t[0]['s'], t[1]))
        return {'mode': 'inside', 'f': inside[0][0], 'd': 0.0}
    if near:
        near.sort(key=lambda t: (t[2], -t[0]['s']))
        return {'mode': 'near', 'f': near[0][0], 'd': near[0][2]}
    return None


PHOTOS = [
    ('Discovery Park', 47.65976, -122.42877),
    ('Carkeek Park 1', 47.71170, -122.37706),
    ('Carkeek Park 2', 47.71169, -122.37714),
    ('Union Bay Natural Area 1', 47.65426, -122.29524),
    ('Union Bay Natural Area 2', 47.65597, -122.29697),
    ('Union Bay Natural Area 3', 47.65441, -122.29474),
    ('Seattle Arboretum', 47.64244, -122.29497),
    ('Magnolia backyard', 47.63467, -122.39825),
    ('Seattle waterfront', 47.60931, -122.34204),
    ('Smith Island', 48.32521, -122.84339),
    ('Skagit Bay', 48.32620, -122.82199),
    ('Drayton Harbor', 48.98006, -122.78874),
]


def test():
    print()
    print('%-28s %-34s %s' % ('photo coordinate', 'answer', 'mode'))
    print('-' * 78)
    named = 0
    for label, lat, lon in PHOTOS:
        r = lookup(lat, lon)
        if r:
            named += 1
            tag = 'inside' if r['mode'] == 'inside' else 'near %.0fm' % r['d']
            print('%-28s %-34s %s' % (label, r['f']['n'][:34], tag))
        else:
            print('%-28s %-34s' % (label, '-- none --'))
    print()
    print('  named %d of %d' % (named, len(PHOTOS)))


if __name__ == '__main__':
    if 'test' not in sys.argv:
        build()
    test()
