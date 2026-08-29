#!/usr/bin/env python3
"""Why do 28% of real coordinates get no name? Measure, don't guess."""
import json
import math
import random

PLACES = '/mnt/nas/wikidata/places.ndjson'
PARQUET = '/home/jlian/wingdex/ml/distill/groundtruth_heldout_distilled.parquet'

EXTENTS = {
    'Q46169': 15000, 'Q473972': 10000, 'Q179049': 6000, 'Q4421': 8000,
    'Q23397': 4000, 'Q170321': 3000, 'Q39594': 5000, 'Q23442': 8000,
    'Q40080': 2000, 'Q185113': 3000, 'Q8072': 8000, 'Q8502': 6000,
    'Q22698': 2000, 'Q167346': 1500, 'Q1107656': 1000,
}
EARTH_R = 6371000.0


def haversine_m(a_lat, a_lon, b_lat, b_lon):
    to_rad = math.pi / 180.0
    d_lat = (b_lat - a_lat) * to_rad
    d_lon = (b_lon - a_lon) * to_rad
    s = (math.sin(d_lat / 2) ** 2
         + math.cos(a_lat * to_rad) * math.cos(b_lat * to_rad) * math.sin(d_lon / 2) ** 2)
    return 2 * EARTH_R * math.asin(min(1.0, math.sqrt(s)))


def main():
    grid = {}
    with open(PLACES, encoding='utf-8') as fh:
        for line in fh:
            r = json.loads(line)
            grid.setdefault((int(math.floor(r['lat'])), int(math.floor(r['lon']))), []).append(r)

    import pandas as pd
    df = pd.read_parquet(PARQUET, columns=['latitude', 'longitude'])
    random.seed(1337)
    sample = [(float(df.latitude.iloc[i]), float(df.longitude.iloc[i]))
              for i in random.sample(range(len(df)), 20000)]

    # For every unnamed coordinate, how far IS the nearest place of any class?
    # That separates "empty region" from "place nearby but outside its extent".
    buckets = {'0-2km': 0, '2-5km': 0, '5-15km': 0, '15-50km': 0, '>50km': 0, 'nothing in 3deg': 0}
    unnamed = 0
    nearest_all = []

    for lat, lon in sample:
        la, lo = int(math.floor(lat)), int(math.floor(lon))
        near = []
        for dla in (-1, 0, 1):
            for dlo in (-1, 0, 1):
                near.extend(grid.get((la + dla, lo + dlo), ()))

        named = False
        best_d = None
        for c in near:
            d = haversine_m(lat, lon, c['lat'], c['lon'])
            if best_d is None or d < best_d:
                best_d = d
            if d <= EXTENTS.get(c['cls'], 2000):
                named = True
        if named:
            continue

        unnamed += 1
        if best_d is None:
            buckets['nothing in 3deg'] += 1
            continue
        nearest_all.append(best_d)
        if best_d < 2000:
            buckets['0-2km'] += 1
        elif best_d < 5000:
            buckets['2-5km'] += 1
        elif best_d < 15000:
            buckets['5-15km'] += 1
        elif best_d < 50000:
            buckets['15-50km'] += 1
        else:
            buckets['>50km'] += 1

    print('unnamed: %d of %d (%.1f%%)' % (unnamed, len(sample), 100.0 * unnamed / len(sample)))
    print()
    print('distance to the NEAREST place of any class, for unnamed coordinates:')
    for k in ('0-2km', '2-5km', '5-15km', '15-50km', '>50km', 'nothing in 3deg'):
        v = buckets[k]
        print('  %-18s %6d  %5.1f%% of unnamed' % (k, v, 100.0 * v / max(1, unnamed)))
    if nearest_all:
        nearest_all.sort()
        print()
        print('  median distance to nearest place: %.0f m' % nearest_all[len(nearest_all) // 2])


if __name__ == '__main__':
    main()
