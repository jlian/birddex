#!/usr/bin/env python3
"""Build the rarity asset: "is this bird notable HERE, THIS MONTH", as a verdict.

WHY THIS IS NOT THE OCCURRENCE BLOB. The v4 prior is 22.62 MiB gzipped and the
web client only fetches it behind ModelDownloadGate, on the first identify. A
rarity mark has to render on the WingDex and Outings pages, where that blob is
not present and pulling it would be indefensible. So this emits a separate,
much smaller asset carrying the VERDICT rather than the probability.

Derived FROM the shipped blob, not from the source parquet, for two reasons:
it reproduces from a clean checkout with no DuckDB and no 47.9M-row occurrence
dump, and the badge can never disagree with the prior the ranker actually ran.

TWO THINGS SHRINK IT. The grid is coarsened (default 4x, so 27 km -> 108 km):
rarity is a regional question and a vagrant 50 km away is still a vagrant.
And the per-species value collapses from a 5-bit log-probability to a 12-bit
"ordinary here?" mask, one bit per month.

LAYOUT (little-endian throughout):
  magic       4B   "WDRR"
  version     1B   format version
  coarse      1B   grid coarsening factor applied to the WDOP grid
  reserved    2B
  tax_hash    8B   sha256(taxonomy.json)[:8] -- species are keyed by ROW INDEX
                   into taxonomy.json exactly as in WDOP, so a reordered
                   taxonomy would silently mis-key every verdict. The client
                   MUST refuse an asset whose hash does not match.
  n_cells     4B   uint32
  INDEX       (n_cells + 1) * 8B, sorted ascending by coarse cell id:
                key     4B uint32  (crow * coarse_cols + ccol)
                offset  4B uint32  (byte offset into PAYLOAD)
              the last entry is a sentinel (0xFFFFFFFF, len(payload)) so cell
              i's length is index[i+1].offset - index[i].offset with no
              special case, matching WDOP.
  MONTHS      n_cells * 2B uint16, PARALLEL to the index, inserted between the
              index and the payload exactly as WDOP v4 inserts its totals:
              bit m set = this cell has enough records in month m+1 to judge.
              Clear = unknown, and the client shows NOTHING.
  PAYLOAD     per cell: varint(delta of sorted species index) + 2B uint16 mask
                bit m set = species is ORDINARY here in month m+1
                mask == 0  = recorded here, but ordinary in no month

A species ABSENT from a present cell's list is the strongest verdict, not the
weakest: it means the species has never been meaningfully recorded in a cell
that has plenty of records. That asymmetry is the whole reason the month mask
and the cell list are separate. An undersampled cell is omitted entirely, so
"no data" and "never here" can never be confused.
"""
import argparse
import gzip
import hashlib
import json
import math
import struct
from collections import defaultdict

MAGIC = b"WDRR"
OCC_MAGIC = b"WDOP"
VERSION = 1
GRID_COLS = 1276
# WDOP v4 constants. Duplicated rather than imported because this script reads
# the shipped blob directly; they are asserted against its header below.
MONTH_BITS = 4
POOLED_MONTH_CODE = 12
OCC_SCALE = 2.5


def varint(v):
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def read_wdop(path):
    """Read a v4 occurrence blob. Port of parseOccurrence in src/lib/occurrence.ts."""
    raw = gzip.decompress(open(path, "rb").read())
    if raw[:4] != OCC_MAGIC:
        raise SystemExit("bad magic " + repr(raw[:4]))
    version = raw[4]
    if version < 4:
        raise SystemExit("need a v4 blob: v3 divided n_cm out and it is not "
                         "recoverable, so no count-based gate can be applied")
    n_cells = struct.unpack("<I", raw[16:20])[0]
    idx_start = 20
    totals_start = idx_start + (n_cells + 1) * 8
    payload_start = totals_start + n_cells * 4
    if payload_start > len(raw):
        raise SystemExit("blob truncated: index needs " + str(payload_start) +
                         " bytes but the blob is " + str(len(raw)))
    return raw, version, n_cells, idx_start, totals_start, payload_start


def decode_slot(raw, idx_start, payload_start, slot):
    """Species index -> quantised byte for one WDOP slice."""
    start = struct.unpack("<I", raw[idx_start + slot * 8 + 4:idx_start + slot * 8 + 8])[0]
    end = struct.unpack("<I", raw[idx_start + (slot + 1) * 8 + 4:idx_start + (slot + 1) * 8 + 8])[0]
    p = payload_start + start
    stop = payload_start + end
    out = {}
    cur = 0
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
        out[cur] = raw[p]
        p += 1
    return out


def report(cells, counts, month_totals, coarse_cols):
    """How often does a mark actually fire?

    The issue's binding constraint is that a badge on most rows means nothing,
    so this is the number that picks --coverage, not a percentile. Weighted by
    occurrence probability, which is the closest available proxy for what a
    birder actually logs: a species contributes in proportion to how often it
    is really recorded there that month, so one Snowy Owl does not count the
    same as ten thousand House Sparrows.

    "Both" cannot appear here and its absence is the point. This samples from
    species that ARE recorded in the cell, and "both" means never recorded in
    it, so the genuine surprise is by construction outside the sample.
    """
    weighted = defaultdict(float)
    total_weight = 0.0
    for ccell, month_mask, entries in cells:
        ordinary_by_sp = dict(entries)
        for month_code in range(12):
            if not (month_mask >> month_code) & 1:
                continue
            for sp, n in counts[ccell][month_code].items():
                mask = ordinary_by_sp.get(sp)
                if mask is None:
                    state = "both"
                elif (mask >> month_code) & 1:
                    state = "none"
                elif mask:
                    state = "out of season"
                else:
                    state = "off range"
                weighted[state] += n
                total_weight += n

    print("badge rate, weighted by occurrence:")
    for state in ("none", "out of season", "off range", "both"):
        share = weighted[state] / total_weight if total_weight else 0.0
        line = "  " + state.ljust(14) + " " + ("%.2f%%" % (share * 100)).rjust(7)
        if state != "none" and share > 0:
            line += "   1 in " + str(round(1 / share))
        print(line)
    marked = 1 - (weighted["none"] / total_weight if total_weight else 1)
    print("  -> a mark on 1 row in " + str(round(1 / marked) if marked else "inf"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--occurrence", required=True,
                    help="public/priors/occurrence.<hash>.bin.gz, must be v4")
    ap.add_argument("--taxonomy", required=True, help="src/lib/taxonomy.json")
    ap.add_argument("--out", required=True)
    ap.add_argument("--coarse", type=int, default=4,
                    help="grid coarsening factor; 4 turns 27 km cells into 108 km")
    ap.add_argument("--min-cell-records", type=int, default=400,
                    help="coarse cells below this are OMITTED, so they badge nothing")
    ap.add_argument("--min-month-records", type=int, default=60,
                    help="cell-months below this get no month bit, so they badge nothing")
    ap.add_argument("--min-species-records", type=float, default=3.0,
                    help="species below this in a cell are dropped, which reads as "
                         "'never recorded here' rather than 'scarce here'")
    ap.add_argument("--coverage", type=float, default=0.94,
                    help="a species is ORDINARY if it falls inside the smallest set "
                         "covering this share of the cell-month's records. Rank-based "
                         "rather than an absolute share, because cells differ by an "
                         "order of magnitude in species richness and one fixed cut "
                         "would call everything rare in a rich cell. 0.94 measured at "
                         "1 mark in 15 rows: out of season 1 in 22, off range 1 in 66, "
                         "both 1 in 208. 0.90 gives 1 in 10, which is too many to mean "
                         "anything; 0.96 gives 1 in 22 and starts hiding real vagrants.")
    args = ap.parse_args()

    tx_hash = hashlib.sha256(open(args.taxonomy, "rb").read()).digest()[:8]
    print("taxonomy sha256[:8] = " + tx_hash.hex())

    raw, version, n_cells, idx_start, totals_start, payload_start = read_wdop(args.occurrence)
    print("read WDOP v" + str(version) + ", " + str(n_cells) + " slices")

    coarse = args.coarse
    coarse_cols = (GRID_COLS + coarse - 1) // coarse

    # counts[ccell][month][species] and month_totals[ccell][month], summed from
    # the fine slices. n_scm is reconstructed as p_hat * n_cm; that carries the
    # blob's 5-bit quantisation error, but it is the SAME error the ranker
    # already runs on, so the badge cannot disagree with the ranking.
    counts = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))
    month_totals = defaultdict(lambda: defaultdict(float))

    for slot in range(n_cells):
        key = struct.unpack("<I", raw[idx_start + slot * 8:idx_start + slot * 8 + 4])[0]
        month_code = key & ((1 << MONTH_BITS) - 1)
        if month_code == POOLED_MONTH_CODE:
            continue
        cell = key >> MONTH_BITS
        row, col = divmod(cell, GRID_COLS)
        ccell = (row // coarse) * coarse_cols + (col // coarse)
        n_cm = struct.unpack("<I", raw[totals_start + slot * 4:totals_start + slot * 4 + 4])[0]
        if n_cm <= 0:
            continue
        month_totals[ccell][month_code] += n_cm
        bucket = counts[ccell][month_code]
        for sp, q in decode_slot(raw, idx_start, payload_start, slot).items():
            bucket[sp] += math.exp(-q / OCC_SCALE) * n_cm

    print(str(len(counts)) + " coarse cells before the record gate")

    cells = []
    n_entries = 0
    n_ordinary_bits = 0
    dropped_cells = 0
    for ccell in sorted(counts):
        cell_total = sum(month_totals[ccell].values())
        if cell_total < args.min_cell_records:
            dropped_cells += 1
            continue

        month_mask = 0
        ordinary = defaultdict(int)
        present = defaultdict(float)
        for month_code in range(12):
            total = month_totals[ccell].get(month_code, 0.0)
            for sp, n in counts[ccell].get(month_code, {}).items():
                present[sp] += n
            if total < args.min_month_records:
                continue
            month_mask |= 1 << month_code
            ranked = sorted(counts[ccell][month_code].items(), key=lambda kv: -kv[1])
            acc = 0.0
            for sp, n in ranked:
                if acc >= args.coverage * total:
                    break
                acc += n
                ordinary[sp] |= 1 << month_code

        # A cell with no judgeable month carries no information at all, and
        # keeping it would badge every species in it as "never recorded here".
        if month_mask == 0:
            dropped_cells += 1
            continue

        species = sorted(sp for sp, n in present.items()
                         if n >= args.min_species_records or sp in ordinary)
        if not species:
            dropped_cells += 1
            continue
        cells.append((ccell, month_mask, [(sp, ordinary.get(sp, 0)) for sp in species]))
        n_entries += len(species)
        n_ordinary_bits += sum(bin(ordinary.get(sp, 0)).count("1") for sp in species)

    print(str(len(cells)) + " cells kept, " + str(dropped_cells) + " dropped, " +
          str(n_entries) + " (species, cell) entries")

    report(cells, counts, month_totals, coarse_cols)

    payload = bytearray()
    index = []
    months = bytearray()
    for ccell, month_mask, entries in cells:
        index.append((ccell, len(payload)))
        months += struct.pack("<H", month_mask)
        prev = 0
        for sp, mask in entries:
            payload += varint(sp - prev)
            prev = sp
            payload += struct.pack("<H", mask)

    head = bytearray()
    head += MAGIC
    head += bytes([VERSION, coarse, 0, 0])
    head += tx_hash
    head += struct.pack("<I", len(index))
    for key, off in index:
        head += struct.pack("<II", key, off)
    head += struct.pack("<II", 0xFFFFFFFF, len(payload))
    head += months

    blob = bytes(head) + bytes(payload)
    gz = gzip.compress(blob, 9)
    open(args.out, "wb").write(gz)
    content_hash = hashlib.sha256(gz).hexdigest()[:8]
    print("raw  " + str(len(blob)) + " B (" + str(round(len(blob) / 1048576.0, 2)) + " MiB)")
    print("gzip " + str(len(gz)) + " B (" + str(round(len(gz) / 1048576.0, 2)) + " MiB)")

    meta = {"magic": "WDRR", "version": VERSION, "coarse": coarse,
            "grid_cols": GRID_COLS, "coarse_cols": coarse_cols,
            "taxonomy_sha256_8": tx_hash.hex(),
            "n_cells": len(index), "n_entries": n_entries,
            "n_ordinary_bits": n_ordinary_bits,
            "min_cell_records": args.min_cell_records,
            "min_month_records": args.min_month_records,
            "min_species_records": args.min_species_records,
            "coverage": args.coverage,
            "raw_bytes": len(blob), "gzip_bytes": len(gz),
            "content_hash": content_hash}
    json.dump(meta, open(args.out + ".meta.json", "w"), indent=2)
    print("wrote " + args.out + " (content hash " + content_hash + ")")


if __name__ == "__main__":
    main()
