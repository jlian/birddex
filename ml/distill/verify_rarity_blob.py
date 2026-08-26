#!/usr/bin/env python3
"""Check the rarity asset against ornithology, not against itself.

Two questions a size number cannot answer.

FIRST, what did the record gate actually throw away. build_rarity_blob.py drops
coarse cells under --min-cell-records, and that drops most CELLS. The number
that matters is not how many cells were dropped but what share of the world's
RECORDS went with them: a cell nobody has ever birded costs nothing to omit,
and omitting it is the whole defence against a false rare on every bird in an
under-recorded region.

SECOND, whether the verdicts are right. The fixtures below are birding facts,
not golden values captured from a previous run, so this fails when the asset
becomes wrong rather than merely when it changes. Northern Cardinal does not
occur in Seattle. Rufous Hummingbird leaves Washington for the winter and
Anna's does not. Baltimore Oriole is in New York in June and in Central America
in January. If a rebuild breaks one of these, the asset is broken.
"""
import argparse
import gzip
import json
import math
import struct
from collections import defaultdict

GRID_ORIGIN_X = -17226000
GRID_ORIGIN_Y = 8343000
GRID_CELL_SIZE = 27000
GRID_COLS = 1276
GRID_ROWS = 618
MONTH_BITS = 4
POOLED_MONTH_CODE = 12


def lonlat_to_cell(lon, lat):
    """Equal Earth (EPSG:8857) grid cell. Port of src/lib/equal-earth.ts."""
    a1, a2, a3, a4 = 1.340264, -0.081106, 0.000893, 0.003796
    a, f = 6378137.0, 1 / 298.257223563
    b = a * (1 - f)
    e2 = 1 - (b * b) / (a * a)
    e = math.sqrt(e2)
    r = a * math.sqrt(0.5 * (1 + ((1 - e2) / (2 * e)) * math.log((1 + e) / (1 - e))))
    qp = 1 + ((1 - e2) / (2 * e)) * math.log((1 + e) / (1 - e))
    lam, phi = math.radians(lon), math.radians(lat)
    sin_phi = math.sin(phi)
    e_sin = e * sin_phi
    q = (1 - e2) * (sin_phi / (1 - e2 * sin_phi * sin_phi)
                    - (1 / (2 * e)) * math.log((1 - e_sin) / (1 + e_sin)))
    theta = math.asin((math.sqrt(3) / 2) * math.sin(math.asin(q / qp)))
    t2 = theta * theta
    t6 = t2 * t2 * t2
    denom = 3 * (a1 + 3 * a2 * t2 + t6 * (7 * a3 + 9 * a4 * t2))
    x = r * ((2 * math.sqrt(3) * lam * math.cos(theta)) / denom)
    y = r * theta * (a1 + a2 * t2 + t6 * (a3 + a4 * t2))
    col = math.floor((x - GRID_ORIGIN_X) / GRID_CELL_SIZE)
    row = math.floor((GRID_ORIGIN_Y - y) / GRID_CELL_SIZE)
    if row < 0 or row >= GRID_ROWS or col < 0 or col >= GRID_COLS:
        return None
    return row, col

BOSTON = (42.36, -71.06)
SEATTLE = (47.61, -122.33)
COLUMBUS = (39.96, -82.99)
NEW_YORK = (40.71, -74.01)
LONDON = (51.51, -0.13)
MIAMI = (25.76, -80.19)
SACRAMENTO = (38.58, -121.49)

# (species, place, place name, month, expected). "marked" accepts any of the
# three marks, for cases where the bird is clearly notable but which of
# "off range" and "out of season" should win is a judgement call.
CASES = [
    # Residents, everywhere they belong. These are the ones that must stay
    # silent: a mark on a common garden bird makes every other mark worthless.
    ("American Robin", SEATTLE, "Seattle", 1, "none"),
    ("American Robin", SEATTLE, "Seattle", 7, "none"),
    ("Anna's Hummingbird", SEATTLE, "Seattle", 1, "none"),
    ("Northern Cardinal", COLUMBUS, "Columbus OH", 1, "none"),
    ("House Sparrow", LONDON, "London", 3, "none"),
    ("Mallard", LONDON, "London", 6, "none"),
    ("Great Blue Heron", MIAMI, "Miami", 1, "none"),
    ("Yellow-billed Magpie", SACRAMENTO, "Sacramento", 4, "none"),

    # Migrants, present and absent. Same bird, same place, opposite verdicts:
    # this is the pair that proves the month slice is doing real work.
    ("Barn Swallow", SEATTLE, "Seattle", 7, "none"),
    ("Barn Swallow", SEATTLE, "Seattle", 1, "outOfSeason"),
    ("Rufous Hummingbird", SEATTLE, "Seattle", 5, "none"),
    ("Rufous Hummingbird", SEATTLE, "Seattle", 1, "outOfSeason"),
    ("Baltimore Oriole", NEW_YORK, "New York", 6, "none"),
    ("Baltimore Oriole", NEW_YORK, "New York", 1, "outOfSeason"),

    # Out of range entirely. A cardinal in Seattle is a famous non-event.
    ("Northern Cardinal", SEATTLE, "Seattle", 6, "marked"),
    ("Yellow-billed Magpie", SEATTLE, "Seattle", 4, "marked"),
    ("Painted Bunting", SEATTLE, "Seattle", 6, "marked"),
    ("Scarlet Tanager", SEATTLE, "Seattle", 6, "marked"),

    # Out of season in a place it is genuinely known from. Snowy Owl is a
    # regular coastal Massachusetts winter bird and a June mega.
    ("Snowy Owl", BOSTON, "Boston", 6, "marked"),

    # Not on the continent at all.
    ("Emperor Penguin", SEATTLE, "Seattle", 6, "both"),

    # The --ui-test-seed-csv rarity outing in ios/WingDex/App/WingDexApp.swift.
    # That fixture exists to put all four verdicts on one screen, so these four
    # ARE its contract: if a rebuilt asset moves any of them, the fixture stops
    # showing what it claims to show and this check is what says so.
    ("American Robin", SEATTLE, "seed outing", 1, "none"),
    ("Rufous Hummingbird", SEATTLE, "seed outing", 1, "outOfSeason"),
    ("Tundra Swan", SEATTLE, "seed outing", 1, "offRange"),
    ("Northern Cardinal", SEATTLE, "seed outing", 1, "both"),
]


def load_rarity(path):
    raw = gzip.decompress(open(path, "rb").read())
    if raw[:4] != b"WDRR":
        raise SystemExit("bad magic " + repr(raw[:4]))
    coarse = raw[5]
    n_cells = struct.unpack("<I", raw[16:20])[0]
    idx_start = 20
    months_start = idx_start + (n_cells + 1) * 8
    payload_start = months_start + n_cells * 2
    return raw, coarse, n_cells, idx_start, months_start, payload_start


def state_at(blob, species_idx, row, col, month):
    """Port of rarityAt in src/lib/rarity.ts, minus the projection."""
    raw, coarse, n_cells, idx_start, months_start, payload_start = blob
    coarse_cols = (GRID_COLS + coarse - 1) // coarse
    want = (row // coarse) * coarse_cols + (col // coarse)

    lo, hi = 0, n_cells - 1
    slot = -1
    while lo <= hi:
        mid = (lo + hi) // 2
        key = struct.unpack("<I", raw[idx_start + mid * 8:idx_start + mid * 8 + 4])[0]
        if key == want:
            slot = mid
            break
        if key < want:
            lo = mid + 1
        else:
            hi = mid - 1
    if slot < 0:
        return "none"

    month_mask = struct.unpack("<H", raw[months_start + slot * 2:months_start + slot * 2 + 2])[0]
    if not (month_mask >> (month - 1)) & 1:
        return "none"

    start = struct.unpack("<I", raw[idx_start + slot * 8 + 4:idx_start + slot * 8 + 8])[0]
    end = struct.unpack("<I", raw[idx_start + (slot + 1) * 8 + 4:idx_start + (slot + 1) * 8 + 8])[0]
    p = payload_start + start
    stop = payload_start + end
    cur = 0
    mask = None
    while p < stop:
        shift = 0
        v = 0
        while True:
            b = raw[p]
            p += 1
            v |= (b & 0x7F) << shift
            if not (b & 0x80):
                break
            shift += 7
        cur += v
        m = struct.unpack("<H", raw[p:p + 2])[0]
        p += 2
        if cur == species_idx:
            mask = m
            break
        if cur > species_idx:
            break
    if mask is None:
        return "both"
    if (mask >> (month - 1)) & 1:
        return "none"
    return "offRange" if mask == 0 else "outOfSeason"


def record_coverage(occurrence_path, coarse, min_cell_records):
    """What share of all records sits in cells the gate keeps.

    Reads only the index keys and the totals table, never the payload, so this
    is seconds rather than minutes.
    """
    raw = gzip.decompress(open(occurrence_path, "rb").read())
    if raw[:4] != b"WDOP" or raw[4] < 4:
        raise SystemExit("need a v4 WDOP blob")
    n = struct.unpack("<I", raw[16:20])[0]
    idx_start = 20
    totals_start = idx_start + (n + 1) * 8
    coarse_cols = (GRID_COLS + coarse - 1) // coarse

    per_cell = defaultdict(int)
    for slot in range(n):
        key = struct.unpack("<I", raw[idx_start + slot * 8:idx_start + slot * 8 + 4])[0]
        if key & ((1 << MONTH_BITS) - 1) == POOLED_MONTH_CODE:
            continue
        cell = key >> MONTH_BITS
        row, col = divmod(cell, GRID_COLS)
        n_cm = struct.unpack("<I", raw[totals_start + slot * 4:totals_start + slot * 4 + 4])[0]
        per_cell[(row // coarse) * coarse_cols + (col // coarse)] += n_cm

    kept = [v for v in per_cell.values() if v >= min_cell_records]
    dropped = [v for v in per_cell.values() if v < min_cell_records]
    total = sum(per_cell.values())
    print("record gate at " + str(min_cell_records) + " per coarse cell:")
    print("  kept    " + str(len(kept)).rjust(6) + " cells, " +
          ("%.2f%%" % (100.0 * sum(kept) / total)).rjust(7) + " of all records")
    print("  dropped " + str(len(dropped)).rjust(6) + " cells, " +
          ("%.2f%%" % (100.0 * sum(dropped) / total)).rjust(7) + " of all records")
    if dropped:
        print("  the median dropped cell holds " +
              str(sorted(dropped)[len(dropped) // 2]) + " records")


def probe(blob, names, lat, lon, month, limit=12):
    """List what a given place and month actually looks like, by state.

    For picking fixtures. Guessing a species that lands on "off range" is much
    harder than guessing an obvious vagrant, because it has to be a bird the
    area really does record and yet never in ordinary numbers.
    """
    raw, coarse, n_cells, idx_start, months_start, payload_start = blob
    cell = lonlat_to_cell(lon, lat)
    if cell is None:
        print("  off grid")
        return
    coarse_cols = (GRID_COLS + coarse - 1) // coarse
    want = (cell[0] // coarse) * coarse_cols + (cell[1] // coarse)

    lo, hi = 0, n_cells - 1
    slot = -1
    while lo <= hi:
        mid = (lo + hi) // 2
        key = struct.unpack("<I", raw[idx_start + mid * 8:idx_start + mid * 8 + 4])[0]
        if key == want:
            slot = mid
            break
        if key < want:
            lo = mid + 1
        else:
            hi = mid - 1
    if slot < 0:
        print("  cell not in the asset: undersampled, nothing is ever marked here")
        return

    month_mask = struct.unpack("<H", raw[months_start + slot * 2:months_start + slot * 2 + 2])[0]
    judgeable = [m + 1 for m in range(12) if (month_mask >> m) & 1]
    print("  judgeable months: " + (", ".join(map(str, judgeable)) or "none"))
    if not (month_mask >> (month - 1)) & 1:
        print("  month " + str(month) + " is NOT judgeable here, so nothing is marked")
        return

    start = struct.unpack("<I", raw[idx_start + slot * 8 + 4:idx_start + slot * 8 + 8])[0]
    end = struct.unpack("<I", raw[idx_start + (slot + 1) * 8 + 4:idx_start + (slot + 1) * 8 + 8])[0]
    p = payload_start + start
    stop = payload_start + end
    cur = 0
    buckets = defaultdict(list)
    while p < stop:
        shift = 0
        v = 0
        while True:
            b = raw[p]
            p += 1
            v |= (b & 0x7F) << shift
            if not (b & 0x80):
                break
            shift += 7
        cur += v
        mask = struct.unpack("<H", raw[p:p + 2])[0]
        p += 2
        if (mask >> (month - 1)) & 1:
            state = "none"
        elif mask == 0:
            state = "offRange"
        else:
            state = "outOfSeason"
        buckets[state].append(names[cur] if cur < len(names) else "#" + str(cur))

    for state in ("none", "outOfSeason", "offRange"):
        got = buckets[state]
        print("  " + state + " (" + str(len(got)) + " species)")
        for n in got[:limit]:
            print("      " + n)
    print("  every other species in the taxonomy reads 'both' here")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rarity", required=True)
    ap.add_argument("--taxonomy", required=True)
    ap.add_argument("--occurrence", help="v4 WDOP blob, for the record-gate report")
    ap.add_argument("--min-cell-records", type=int, default=400)
    ap.add_argument("--probe", help="lat,lon,month -- list species by state there")
    args = ap.parse_args()

    blob = load_rarity(args.rarity)
    coarse = blob[1]

    if args.occurrence:
        record_coverage(args.occurrence, coarse, args.min_cell_records)
        print()

    taxonomy = json.load(open(args.taxonomy))
    idx_by_name = {}
    names = []
    for i, entry in enumerate(taxonomy):
        name = entry[0] if entry and isinstance(entry[0], str) else "#" + str(i)
        names.append(name)
        idx_by_name.setdefault(name.lower(), i)

    if args.probe:
        lat, lon, month = args.probe.split(",")
        print("probe at " + args.probe + ":")
        probe(blob, names, float(lat), float(lon), int(month))
        print()

    failures = 0
    print("verdicts against known distributions:")
    for name, (lat, lon), place, month, expected in CASES:
        idx = idx_by_name.get(name.lower())
        if idx is None:
            print("  MISSING FROM TAXONOMY  " + name)
            failures += 1
            continue
        cell = lonlat_to_cell(lon, lat)
        if cell is None:
            print("  OFF GRID  " + place)
            failures += 1
            continue
        got = state_at(blob, idx, cell[0], cell[1], month)
        ok = got == expected or (expected == "marked" and got != "none")
        if not ok:
            failures += 1
        label = (name + " in " + place + ", month " + str(month)).ljust(52)
        print("  " + ("ok  " if ok else "FAIL") + " " + label +
              got.ljust(13) + ("" if ok else "expected " + expected))

    print()
    if failures:
        print(str(failures) + " of " + str(len(CASES)) + " cases wrong")
        raise SystemExit(1)
    print("all " + str(len(CASES)) + " cases match known distributions")


if __name__ == "__main__":
    main()
