#!/usr/bin/env python3
"""Disagreement harness v2: adds a variant using Nominatim's REAL rank table.

v1 approximated rank_search as 1/extent, which inverted the truth. Nominatim's
settings/address-levels.json gives leisure=park 24 and natural=peak 18, so a park
is MORE specific than a mountain. My proxy said the opposite, because I had given
mountain a small hand-picked radius. That single sign error is why the nominatim
variant kept picking hills over parks.
"""
import json
import math
import random
from collections import Counter

PLACES = '/mnt/nas/wikidata/places.ndjson'
PARQUET = '/home/jlian/wingdex/ml/distill/groundtruth_heldout_distilled.parquet'
OUT = '/home/jlian/disagreements2.json'
SAMPLE = 20000

CLS_NAME = {
    'Q46169': 'national park', 'Q473972': 'protected area', 'Q179049': 'nature reserve',
    'Q4421': 'forest', 'Q23397': 'lake', 'Q170321': 'marsh', 'Q39594': 'bay',
    'Q23442': 'island', 'Q40080': 'beach', 'Q185113': 'cape', 'Q8072': 'volcano',
    'Q8502': 'mountain', 'Q22698': 'park', 'Q167346': 'botanical garden',
    'Q1107656': 'garden',
}

# Nominatim rank_search, read from settings/address-levels.json. Higher is more
# specific. The key facts: leisure=park 24 and leisure=nature_reserve 24 outrank
# natural=peak/volcano 18 and place=island 17. Parks beat hills, which is exactly
# the birder-checklist intuition, and the opposite of what 1/extent implied.
RANK = {
    'Q22698': 24,    # park            <- leisure=park
    'Q179049': 24,   # nature reserve  <- leisure=nature_reserve
    'Q473972': 24,   # protected area  <- leisure=nature_reserve
    'Q46169': 24,    # national park   <- leisure=nature_reserve (boundary=national_park)
    'Q167346': 25,   # botanical garden<- leisure=garden
    'Q1107656': 25,  # garden          <- leisure=garden
    'Q40080': 22,    # beach           <- natural default
    'Q170321': 22,   # marsh           <- natural default
    'Q4421': 22,     # forest          <- natural default
    'Q23397': 22,    # lake            <- natural default
    'Q39594': 22,    # bay             <- natural default
    'Q185113': 22,   # cape            <- natural default
    'Q8502': 18,     # mountain        <- natural=peak
    'Q8072': 18,     # volcano         <- natural=volcano
    'Q23442': 17,    # island          <- place=island
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

WEIGHTS_MILD = {q: 1.0 for q in CLS_NAME}
WEIGHTS_MILD['Q8502'] = 0.6
WEIGHTS_MILD['Q185113'] = 0.6

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
            key = (int(math.floor(r['lat'])), int(math.floor(r['lon'])))
            grid.setdefault(key, []).append(r)
    return grid


def in_range(grid, lat, lon):
    la, lo = int(math.floor(lat)), int(math.floor(lon))
    out = []
    for dla in (-1, 0, 1):
        for dlo in (-1, 0, 1):
            for c in grid.get((la + dla, lo + dlo), ()):
                d = haversine_m(lat, lon, c['lat'], c['lon'])
                if d <= EXTENTS.get(c['cls'], 2000):
                    out.append((d, c))
    return out


def v_current(cands):
    best = None
    for d, c in cands:
        extent = EXTENTS.get(c['cls'], 2000)
        prom = c.get('importance', 0.0) or CLS_PRIOR.get(c['cls'], 0.2)
        s = max(0.0, 1 - d / extent) * (1 + prom)
        if best is None or s > best[0]:
            best = (s, d, c)
    return best


def v_mild(cands):
    best = None
    for d, c in cands:
        extent = EXTENTS.get(c['cls'], 2000)
        prom = c.get('importance', 0.0) or CLS_PRIOR.get(c['cls'], 0.2)
        s = max(0.0, 1 - d / extent) * (1 + prom) * WEIGHTS_MILD.get(c['cls'], 1.0)
        if best is None or s > best[0]:
            best = (s, d, c)
    return best


def v_rank(cands):
    """Nominatim reverse ordering, done properly: rank DESC, distance ASC."""
    best = None
    for d, c in cands:
        key = (RANK.get(c['cls'], 22), -d)
        if best is None or key > best[0]:
            best = (key, d, c)
    return best


def v_hybrid(cands):
    """Rank as a soft boost rather than a hard sort key.

    Strict rank DESC ignores distance until it has already committed to a class,
    so a park 9 km away beats a lake next to you. Folding rank into the score
    keeps the park preference while letting distance still matter.
    """
    best = None
    for d, c in cands:
        extent = EXTENTS.get(c['cls'], 2000)
        prom = c.get('importance', 0.0) or CLS_PRIOR.get(c['cls'], 0.2)
        rank_boost = 1.0 + 0.12 * (RANK.get(c['cls'], 22) - 22)
        s = max(0.0, 1 - d / extent) * (1 + prom) * max(0.25, rank_boost)
        if best is None or s > best[0]:
            best = (s, d, c)
    return best


VARIANTS = [('current', v_current), ('mild', v_mild),
            ('rank', v_rank), ('hybrid', v_hybrid)]


def main():
    print('loading extract...', flush=True)
    grid = load()

    import pandas as pd
    df = pd.read_parquet(PARQUET, columns=['latitude', 'longitude'])
    random.seed(1337)
    idx = random.sample(range(len(df)), SAMPLE)
    sample = [(float(df.latitude.iloc[i]), float(df.longitude.iloc[i])) for i in idx]
    print('sample: %d real iNat coordinates' % len(sample), flush=True)

    rows = []
    agree = 0
    unnamed = 0
    pair = Counter()
    cls_pick = {name: Counter() for name, _ in VARIANTS}

    for lat, lon in sample:
        cands = in_range(grid, lat, lon)
        if not cands:
            unnamed += 1
            continue
        picks = {}
        for name, fn in VARIANTS:
            r = fn(cands)
            picks[name] = None if r is None else (r[2]['name'], r[2]['cls'], r[1])
            if r is not None:
                cls_pick[name][CLS_NAME.get(r[2]['cls'], '?')] += 1

        if len({v[0] if v else None for v in picks.values()}) == 1:
            agree += 1
            continue

        for a_name, _ in VARIANTS:
            for b_name, _ in VARIANTS:
                if a_name < b_name and picks[a_name] != picks[b_name]:
                    pair[a_name + " vs " + b_name] += 1

        rows.append({
            'lat': round(lat, 5), 'lon': round(lon, 5),
            'picks': {k: (None if v is None else {
                'name': v[0], 'cls': CLS_NAME.get(v[1], v[1]), 'dist_m': round(v[2]),
            }) for k, v in picks.items()},
        })

    named = len(sample) - unnamed
    print()
    print('named     %d of %d (%.1f%%)' % (named, len(sample), 100.0 * named / len(sample)))
    print('unanimous %d of %d named (%.1f%%)' % (agree, named, 100.0 * agree / max(1, named)))
    print('DISAGREE  %d of %d named (%.1f%%)' % (len(rows), named, 100.0 * len(rows) / max(1, named)))
    print()
    print('pairwise disagreements:')
    for k, v in pair.most_common():
        print('  %-22s %5d' % (k, v))
    print()
    print('what class each variant picks (top 6):')
    for name, _ in VARIANTS:
        top = cls_pick[name].most_common(6)
        print('  %-8s %s' % (name, ', '.join('%s %d' % (k, v) for k, v in top)))

    random.shuffle(rows)
    with open(OUT, 'w', encoding='utf-8') as fh:
        json.dump(rows[:400], fh, indent=1, ensure_ascii=False)
    print()
    print('wrote %d sampled disagreements to %s' % (min(400, len(rows)), OUT))


if __name__ == '__main__':
    main()
