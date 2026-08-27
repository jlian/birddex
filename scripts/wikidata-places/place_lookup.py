import json
import math
import sys

EXTENTS = {
    'Q46169': 15000, 'Q473972': 10000, 'Q179049': 6000, 'Q4421': 8000,
    'Q23397': 4000, 'Q170321': 3000, 'Q39594': 5000, 'Q23442': 8000,
    'Q40080': 2000, 'Q185113': 3000, 'Q8072': 8000, 'Q8502': 6000,
    'Q22698': 2000, 'Q167346': 1500, 'Q1107656': 1000,
}
CLS_NAME = {
    'Q46169': 'national park', 'Q473972': 'protected area', 'Q179049': 'nature reserve',
    'Q4421': 'forest', 'Q23397': 'lake', 'Q170321': 'marsh', 'Q39594': 'bay',
    'Q23442': 'island', 'Q40080': 'beach', 'Q185113': 'cape', 'Q8072': 'volcano',
    'Q8502': 'mountain', 'Q22698': 'park', 'Q167346': 'botanical garden',
    'Q1107656': 'garden',
}

# Fallback prominence when Nominatim has no importance for an item. Only 8.2% of
# the extract is covered, so without this the other 92% would all score equally
# and the ranking would collapse back to nearest-wins. A national park with no
# Wikipedia article is still a better outing name than an unnamed pond.
CLS_PRIOR = {
    'Q46169': 0.42, 'Q473972': 0.34, 'Q179049': 0.32, 'Q4421': 0.26,
    'Q23442': 0.26, 'Q8072': 0.30, 'Q8502': 0.24, 'Q39594': 0.24,
    'Q23397': 0.22, 'Q170321': 0.20, 'Q40080': 0.22, 'Q185113': 0.20,
    'Q22698': 0.24, 'Q167346': 0.24, 'Q1107656': 0.18,
}

EARTH_R = 6371000.0


def haversine_m(a_lat, a_lon, b_lat, b_lon):
    to_rad = math.pi / 180.0
    d_lat = (b_lat - a_lat) * to_rad
    d_lon = (b_lon - a_lon) * to_rad
    s = (math.sin(d_lat / 2) ** 2
         + math.cos(a_lat * to_rad) * math.cos(b_lat * to_rad) * math.sin(d_lon / 2) ** 2)
    return 2 * EARTH_R * math.asin(min(1.0, math.sqrt(s)))


def load(path):
    """Bucket by whole degree so a lookup scans a few thousand rows, not 1.2M."""
    grid = {}
    with open(path, encoding='utf-8') as fh:
        for line in fh:
            r = json.loads(line)
            key = (int(math.floor(r['lat'])), int(math.floor(r['lon'])))
            grid.setdefault(key, []).append(r)
    return grid


def candidates(grid, lat, lon):
    la = int(math.floor(lat))
    lo = int(math.floor(lon))
    out = []
    for dla in (-1, 0, 1):
        for dlo in (-1, 0, 1):
            out.extend(grid.get((la + dla, lo + dlo), ()))
    return out


def load_containment(path):
    """child QID -> set of parent QIDs that are themselves nameable places.

    Only edges where BOTH ends are in the extract matter. A P131 edge to
    Washington is useless: nobody names an outing after a state, and it is not
    a candidate anyway. That filter is brutal: 1,207,700 edges reduce to 8,895.
    """
    import json as _json
    out = {}
    with open(path, encoding='utf-8') as fh:
        for line in fh:
            e = _json.loads(line)
            if not e.get('parent_in_extract'):
                continue
            out.setdefault(e['child'], set()).add(e['parent'])
    return out


def best_contained(grid, lat, lon, edges):
    """Like best(), but a candidate loses to its own container.

    Rationale: a feature INSIDE a park is rarely the name a birder writes.
    Siwash Rock is a real rock in Stanley Park; the outing is at Stanley Park.
    Pure distance prefers the rock because its centroid is closer.
    """
    scored = []
    for c in candidates(grid, lat, lon):
        extent = EXTENTS.get(c['cls'], 2000)
        d = haversine_m(lat, lon, c['lat'], c['lon'])
        if d > extent:
            continue
        prom = c.get('importance', 0.0) or CLS_PRIOR.get(c['cls'], 0.2)
        scored.append((max(0.0, 1 - d / extent) * (1 + prom), c, d))
    if not scored:
        return None

    in_range = {c['qid'] for _, c, _ in scored}
    # Drop any candidate whose container is also in range.
    kept = [t for t in scored if not (edges.get(t[1]['qid'], set()) & in_range)]
    pool = kept or scored
    return max(pool, key=lambda t: t[0])


def best(grid, lat, lon):
    top = None
    for c in candidates(grid, lat, lon):
        extent = EXTENTS.get(c['cls'], 2000)
        d = haversine_m(lat, lon, c['lat'], c['lon'])
        if d > extent:
            continue
        prominence = c.get('importance', 0.0) or CLS_PRIOR.get(c['cls'], 0.2)
        score = max(0.0, 1 - d / extent) * (1 + prominence)
        if top is None or score > top[0]:
            top = (score, c, d)
    return top
