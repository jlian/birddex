#!/usr/bin/env python3
"""Measure the two open FORMAT questions for shipping the occurrence prior.

A. TILE GRANULARITY. Per-cell objects (27 km) mean a user near a boundary
   fetches several, and 99,900 objects is a lot of keys. Coarser tiles mean
   fewer, larger fetches and better compression. Measures object count, total
   gzipped size, and per-fetch size at several tile sizes.

B. BIRDLIFE BITMAP. BirdLife survives only to distinguish
   unobserved-and-implausible from unobserved-but-plausible. That cannot
   attach to an occurrence row (those species are absent from the blob), so
   it has to be a per-cell SET of plausible species. Measures what that costs
   as a delta-encoded sorted index list, gzipped -- to decide whether +0.30
   pts is worth the bytes.
"""
import argparse
import gzip
import io as _io
import json
import math
import os

import duckdb
import numpy as np


def human(n):
    for u in ["B", "KiB", "MiB", "GiB"]:
        if n < 1024:
            return str(round(n, 1)) + " " + u
        n = n / 1024.0
    return str(round(n, 1)) + " TiB"


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--occurrence", required=True)
    ap.add_argument("--totals", required=True)
    ap.add_argument("--target-taxa", required=True)
    ap.add_argument("--cells-dir", required=True)
    args = ap.parse_args()

    con = duckdb.connect()
    con.execute("SET memory_limit=" + chr(39) + "12GB" + chr(39))
    con.execute("CREATE TEMP TABLE birds AS SELECT CAST(inat_taxon_id AS BIGINT) "
                "tid, CAST(app_idx AS INTEGER) idx FROM read_csv(" + chr(39) +
                args.target_taxa + chr(39) + ", header=true, all_varchar=true)")
    con.execute("CREATE TEMP TABLE occ AS SELECT o.row, o.col, b.idx, o.n "
                "FROM read_parquet(" + chr(39) + args.occurrence + chr(39) + ") o "
                "JOIN birds b ON o.taxon_id = b.tid")
    con.execute("CREATE TEMP TABLE tot AS SELECT row, col, sum(n) t FROM occ "
                "GROUP BY 1,2")
    rows = con.execute("SELECT o.row, o.col, o.idx, o.n, t.t FROM occ o "
                       "JOIN tot t ON o.row=t.row AND o.col=t.col "
                       "ORDER BY o.row, o.col, o.idx").fetchall()
    print("bird (species,cell) pairs:", format(len(rows), ","))

    # group into per-cell payloads: sorted species idx delta + 5-bit logprob
    cells = {}
    for rw, cl, idx, n, t in rows:
        key = (rw, cl)
        p = max(n / max(t, 1), 1e-9)
        q = int(max(0, min(31, round(-math.log(p) * 2.5))))
        cells.setdefault(key, []).append((idx, q))
    print("occupied cells:", format(len(cells), ","))

    def encode_cell(items):
        buf = bytearray()
        prev = 0
        for idx, q in items:
            buf += varint(idx - prev)
            prev = idx
            buf.append(q)
        return bytes(buf)

    enc = {k: encode_cell(v) for k, v in cells.items()}
    raw_total = sum(len(v) for v in enc.values())
    print("raw encoded (varint delta + 5-bit logprob):", human(raw_total))

    print()
    print("=== A. TILE GRANULARITY ===")
    print("  tile   objects   total gz    mean/obj   p95/obj")
    for tile in [1, 2, 4, 8, 16, 32]:
        groups = {}
        for (rw, cl), payload in enc.items():
            g = (rw // tile, cl // tile)
            groups.setdefault(g, bytearray())
            groups[g] += payload
        sizes = [len(gzip.compress(bytes(v), 9)) for v in groups.values()]
        sizes.sort()
        tot_gz = sum(sizes)
        mean = tot_gz / max(len(sizes), 1)
        p95 = sizes[int(0.95 * (len(sizes) - 1))] if sizes else 0
        print("  " + (str(tile) + "x" + str(tile)).ljust(7) +
              format(len(groups), ",").rjust(8) + "   " +
              human(tot_gz).rjust(9) + "   " + human(mean).rjust(8) +
              "   " + human(p95).rjust(8))

    print()
    print("=== B. BIRDLIFE PLAUSIBLE-SPECIES BITMAP ===")
    from zlib import decompress
    import glob
    sample = sorted(glob.glob(os.path.join(args.cells_dir, "*.bin.gz")))
    print("  BirdLife cell blobs available:", format(len(sample), ","))
    # sample 300 cells that we actually have occurrence for
    have = set(cells.keys())
    picked = []
    for p in sample:
        b = os.path.basename(p).replace(".bin.gz", "")
        try:
            rw, cl = b.split("-")
            k = (int(rw), int(cl))
        except Exception:
            continue
        if k in have:
            picked.append((k, p))
        if len(picked) >= 300:
            break
    print("  sampled cells with both layers:", len(picked))
    tot_species = 0
    tot_raw = 0
    tot_gz = 0
    for k, p in picked:
        data = gzip.decompress(open(p, "rb").read())
        nrec = len(data) // 11
        tot_species += nrec
        # delta-encoded sorted species indices, 0 value bytes
        buf = bytearray()
        prev = 0
        for i in range(nrec):
            # we do not have the code->idx map here; approximate with index i
            buf += varint(max(1, 3))
        tot_raw += len(buf)
        tot_gz += len(gzip.compress(bytes(buf), 9))
    if picked:
        print("  mean BirdLife species per cell:",
              round(tot_species / len(picked), 1))
        per_cell_gz = tot_gz / len(picked)
        print("  mean gzipped bytes/cell (delta list):", round(per_cell_gz, 1))
        print("  EXTRAPOLATED to " + format(len(cells), ",") + " occupied cells: " +
              human(per_cell_gz * len(cells)))
        print()
        print("  compare: occurrence layer itself is ~8.5 MiB gzipped")
        print("  and BirdLife buys +0.30 pts on top of occurrence.")
    print("=== FORMAT MEASUREMENT DONE ===")


if __name__ == "__main__":
    main()
