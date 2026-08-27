#!/usr/bin/env python3
"""
Sweep class subsets and prominence filters for #308.

Two evals, because they answer different questions:

  CORRECTNESS  16 real photo coordinates whose filenames name the place the
               photographer was at. Small, but it is the only ground truth we
               have for "the name a birder would write".

  COVERAGE     a large sample of real iNat observation coordinates. No ground
               truth, so this measures only what fraction get named and how far
               away the match is. A high hit rate with absurd distances is worse
               than a lower hit rate with tight ones.

Runs on Tomahawk with the distill venv (pandas). Photo coordinates are hardcoded
rather than read from EXIF so this needs no PIL.
"""
import json
import math
import random
import sys
from collections import Counter

PLACES = '/mnt/nas/wikidata/places.ndjson'
PARQUET = '/home/jlian/wingdex/ml/distill/groundtruth_heldout_distilled.parquet'

CLS = {
    'Q46169': 'national park', 'Q473972': 'protected area', 'Q179049': 'nature reserve',
    'Q4421': 'forest', 'Q23397': 'lake', 'Q170321': 'marsh', 'Q39594': 'bay',
    'Q23442': 'island', 'Q40080': 'beach', 'Q185113': 'cape', 'Q8072': 'volcano',
    'Q8502': 'mountain', 'Q22698': 'park', 'Q167346': 'botanical garden',
    'Q1107656': 'garden',
}

EXTENTS = {
    'Q46169': 15000, 'Q473972': 10000, 'Q179049': 6000, 'Q4421': 8000,
    'Q23397': 4000, 'Q170321': 3000, 'Q39594': 5000, 'Q23442': 8000,
    'Q40080': 2000, 'Q185113': 3000, 'Q8072': 8000, 'Q8502': 6000,
    'Q22698': 2000, 'Q167346': 1500, 'Q1107656': 1000,
}

CLS_PRIOR = {
    'Q46169': 0.42, 'Q473972': 0.34, 'Q179049': 0.32, 'Q4421': 0.26,
    'Q23442': 0.26, 'Q8072': 0.30, 'Q8502': 0.24, 'Q39594': 0.24,
    'Q23397': 0.22, 'Q170321': 0.20, 'Q40080': 0.22, 'Q185113': 0.20,
    'Q22698': 0.24, 'Q167346': 0.24, 'Q1107656': 0.18,
}

# Class subsets to compare. LEISURE mirrors what production asks Geoapify for.
LEISURE = {'Q46169', 'Q473972', 'Q179049', 'Q22698', 'Q167346', 'Q1107656', 'Q4421'}
NATURAL_KEEP = {'Q8072', 'Q23442'}
WATER = {'Q23397', 'Q170321', 'Q39594', 'Q40080'}
NOISY = {'Q8502', 'Q185113'}

# Multiplicative weight per class. 1.0 is neutral; below 1 demotes without
# excluding. The point is that a demoted class can still win when it is the
# only thing nearby, which hard exclusion cannot do.
WEIGHTS_FLAT = {q: 1.0 for q in CLS}

WEIGHTS_MILD = dict(WEIGHTS_FLAT)
WEIGHTS_MILD.update({'Q8502': 0.6, 'Q185113': 0.6})

WEIGHTS_STRONG = dict(WEIGHTS_FLAT)
WEIGHTS_STRONG.update({'Q8502': 0.3, 'Q185113': 0.3, 'Q23397': 0.7, 'Q39594': 0.7})

# Leisure boosted rather than everything else demoted.
WEIGHTS_LEISURE_UP = dict(WEIGHTS_FLAT)
for _q in ('Q46169', 'Q473972', 'Q179049', 'Q22698', 'Q167346'):
    WEIGHTS_LEISURE_UP[_q] = 1.6

# Both directions at once.
WEIGHTS_BOTH = dict(WEIGHTS_LEISURE_UP)
WEIGHTS_BOTH.update({'Q8502': 0.4, 'Q185113': 0.4})

WEIGHT_SETS = [
    ('flat (all classes equal)', WEIGHTS_FLAT),
    ('mountain/cape x0.6', WEIGHTS_MILD),
    ('mountain/cape x0.3, water x0.7', WEIGHTS_STRONG),
    ('leisure x1.6', WEIGHTS_LEISURE_UP),
    ('leisure x1.6 + mtn/cape x0.4', WEIGHTS_BOTH),
]
# (label, lat, lon, substring the answer should contain)
PHOTOS = [
    ('Union Bay Natural Area 1', 47.65426, -122.29524, 'union bay'),
    ('Union Bay Natural Area 2', 47.65597, -122.29697, 'union bay'),
    ('Union Bay Natural Area 3', 47.65441, -122.29474, 'union bay'),
    ('Haleakala summit', 20.71485, -156.25017, 'haleak'),
    ('Discovery Park', 47.65976, -122.42877, 'discovery park'),
    ('Taipei Zoo', 24.99591, 121.58876, 'taipei zoo'),
    ('Carkeek Park 1', 47.71170, -122.37706, 'carkeek'),
    ('Carkeek Park 2', 47.71169, -122.37714, 'carkeek'),
    ('Smith Island', 48.32521, -122.84339, 'smith island'),
    ('Museumplein Amsterdam', 52.35713, 4.88008, 'museum'),
    ('Seattle Arboretum', 47.64244, -122.29497, 'arboretum|washington park'),
    ('Skagit Bay', 48.32620, -122.82199, 'skagit'),
    ('Drayton Harbor', 48.98006, -122.78874, 'drayton'),
    ('Monterey Harbor', 36.60753, -121.89471, 'monterey'),
    ('Lake Como', 45.81385, 9.08124, 'como'),
    ('Park Ridge fountain', 42.00874, -87.83084, 'hodges|park ridge'),
]

EARTH_R = 6371000.0


def haversine_m(a_lat, a_lon, b_lat, b_lon):
    to_rad = math.pi / 180.0
    d_lat = (b_lat - a_lat) * to_rad
    d_lon = (b_lon - a_lon) * to_rad
    s = (math.sin(d_lat / 2) ** 2
         + math.cos(a_lat * to_rad) * math.cos(b_lat * to_rad) * math.sin(d_lon / 2) ** 2)
    return 2 * EARTH_R * math.asin(min(1.0, math.sqrt(s)))


def load():
    grid = {}
    with open(PLACES, encoding='utf-8') as fh:
        for line in fh:
            r = json.loads(line)
            grid.setdefault((int(math.floor(r['lat'])), int(math.floor(r['lon']))), []).append(r)
    return grid


def nearby(grid, lat, lon):
    la, lo = int(math.floor(lat)), int(math.floor(lon))
    out = []
    for dla in (-1, 0, 1):
        for dlo in (-1, 0, 1):
            out.extend(grid.get((la + dla, lo + dlo), ()))
    return out


def pick(grid, lat, lon, weights, require_wiki):
    top = None
    for c in nearby(grid, lat, lon):
        w = weights.get(c['cls'], 1.0)
        if w <= 0:
            continue
        imp = c.get('importance', 0.0)
        if require_wiki and imp <= 0:
            continue
        extent = EXTENTS.get(c['cls'], 2000)
        d = haversine_m(lat, lon, c['lat'], c['lon'])
        if d > extent:
            continue
        prom = imp or CLS_PRIOR.get(c['cls'], 0.2)
        score = max(0.0, 1 - d / extent) * (1 + prom) * w
        if top is None or score > top[0]:
            top = (score, c, d)
    return top

def main():
    print('loading extract...', flush=True)
    grid = load()

    import pandas as pd
    df = pd.read_parquet(PARQUET, columns=['latitude', 'longitude'])
    random.seed(1337)
    idx = random.sample(range(len(df)), 20000)
    sample = [(float(df.latitude.iloc[i]), float(df.longitude.iloc[i])) for i in idx]
    print('coverage sample: %d real iNat coordinates' % len(sample), flush=True)
    print()

    header = '%-38s %-6s %6s %8s %8s %8s %7s'
    print(header % ('class subset', 'wiki?', 'photos', 'named', 'median', 'p90', '>5km'))
    print('-' * 92)

    for label, allowed in WEIGHT_SETS:
        for require_wiki in (False,):
            hits = 0
            for _, lat, lon, want in PHOTOS:
                r = pick(grid, lat, lon, allowed, require_wiki)
                if r and any(w in r[1]['name'].lower() for w in want.split('|')):
                    hits += 1

            dists = []
            named = 0
            for lat, lon in sample:
                r = pick(grid, lat, lon, allowed, require_wiki)
                if r:
                    named += 1
                    dists.append(r[2])
            dists.sort()
            med = dists[len(dists) // 2] if dists else 0
            p90 = dists[int(len(dists) * 0.9)] if dists else 0
            far = sum(1 for d in dists if d > 5000)
            print(header % (
                label,
                'yes' if require_wiki else 'no',
                '%d/%d' % (hits, len(PHOTOS)),
                '%.0f%%' % (100.0 * named / len(sample)),
                '%.0fm' % med,
                '%.0fm' % p90,
                '%.1f%%' % (100.0 * far / max(1, len(dists))),
            ), flush=True)


if __name__ == '__main__':
    main()
