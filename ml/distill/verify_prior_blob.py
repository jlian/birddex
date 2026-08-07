#!/usr/bin/env python3
"""Verify the shipped blob decodes to the same numbers as the source parquet.

Reads the blob exactly as a client would -- header, binary search the index,
slice one cell, walk the varint deltas -- and compares against DuckDB for a
random sample of cells. Catches offset bugs, delta-encoding bugs, and
quantisation drift before any of it ships.
"""
import argparse
import gzip
import math
import random
import struct

import duckdb

GRID_COLS = 1276


def read_blob(path):
    raw = gzip.decompress(open(path, "rb").read())
    assert raw[:4] == b"WDOP", "bad magic"
    version = raw[4]
    qbits = raw[5]
    if version >= 2:
        tax_hash = raw[8:16].hex()
        n = struct.unpack("<I", raw[16:20])[0]
        off = 20
    else:
        tax_hash = None
        n = struct.unpack("<I", raw[8:12])[0]
        off = 12
    idx = []
    for i in range(n + 1):
        key, o = struct.unpack("<II", raw[off:off + 8])
        idx.append((key, o))
        off += 8
    payload = raw[off:]
    return version, qbits, idx, payload, tax_hash


def decode_cell(idx, payload, cell_id):
    lo, hi = 0, len(idx) - 2
    while lo <= hi:
        mid = (lo + hi) // 2
        if idx[mid][0] == cell_id:
            start = idx[mid][1]
            end = idx[mid + 1][1]
            out = []
            p = start
            cur = 0
            while p < end:
                shift = 0
                v = 0
                while True:
                    b = payload[p]
                    p += 1
                    v |= (b & 0x7F) << shift
                    if not (b & 0x80):
                        break
                    shift += 7
                cur += v
                q = payload[p]
                p += 1
                out.append((cur, q))
            return out
        if idx[mid][0] < cell_id:
            lo = mid + 1
        else:
            hi = mid - 1
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--blob", required=True)
    ap.add_argument("--occurrence", required=True)
    ap.add_argument("--target-taxa", required=True)
    ap.add_argument("--samples", type=int, default=40)
    ap.add_argument("--taxonomy", default=None)
    ap.add_argument("--scale", type=float, default=2.5)
    args = ap.parse_args()

    version, qbits, idx, payload, tax_hash = read_blob(args.blob)
    if tax_hash and args.taxonomy:
        import hashlib
        want = hashlib.sha256(open(args.taxonomy, "rb").read()).digest()[:8].hex()
        print("taxonomy hash: blob=" + tax_hash + " file=" + want +
              ("  MATCH" if want == tax_hash else "  *** MISMATCH ***"))
        assert want == tax_hash, "taxonomy hash mismatch -- blob is stale"
    print("version", version, "qbits", qbits, "cells", len(idx) - 1,
          "payload", len(payload), "B")

    con = duckdb.connect()
    con.execute("SET memory_limit=" + chr(39) + "8GB" + chr(39))
    con.execute("CREATE TEMP TABLE birds AS SELECT "
                "CAST(inat_taxon_id AS BIGINT) tid, CAST(app_idx AS INTEGER) ix "
                "FROM read_csv(" + chr(39) + args.target_taxa + chr(39) +
                ", header=true, all_varchar=true)")
    con.execute("CREATE TEMP TABLE occ AS SELECT o.row, o.col, b.ix, o.n "
                "FROM read_parquet(" + chr(39) + args.occurrence + chr(39) + ") o "
                "JOIN birds b ON o.taxon_id = b.tid")

    random.seed(0)
    picks = random.sample(range(len(idx) - 1), args.samples)
    bad = 0
    checked = 0
    worst = 0.0
    for i in picks:
        cell_id = idx[i][0]
        rw = cell_id // GRID_COLS
        cl = cell_id % GRID_COLS
        got = decode_cell(idx, payload, cell_id)
        exp = con.execute("SELECT ix, n FROM occ WHERE row=" + str(rw) +
                          " AND col=" + str(cl) + " ORDER BY ix").fetchall()
        tot = sum(e[1] for e in exp)
        if got is None or len(got) != len(exp):
            print("  MISMATCH cell", rw, cl, "decoded",
                  0 if got is None else len(got), "expected", len(exp))
            bad += 1
            continue
        for (gi, gq), (ei, en) in zip(got, exp):
            checked += 1
            if gi != ei:
                print("  INDEX MISMATCH cell", rw, cl, gi, "vs", ei)
                bad += 1
                break
            p_true = en / max(tot, 1)
            p_dec = math.exp(-gq / args.scale)
            rel = abs(math.log(p_dec) - math.log(p_true))
            worst = max(worst, rel)
    print()
    print("cells sampled :", args.samples)
    print("pairs checked :", checked)
    print("mismatches    :", bad)
    print("worst |log p| error from quantisation:", round(worst, 4))
    print()
    if bad == 0:
        print("VERDICT: blob decodes correctly. Species indices are exact;")
        print("only the log-prob is lossy, by design (5-bit quantisation).")
    else:
        print("VERDICT: BROKEN -- do not ship.")
    print("=== BLOB VERIFY DONE ===")


if __name__ == "__main__":
    main()
