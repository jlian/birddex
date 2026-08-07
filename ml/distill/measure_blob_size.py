#!/usr/bin/env python3
"""NEXT-1b: measure what the occurrence prior costs to SHIP.

Blocks the NEXT-1 decision (R2 sidecar vs merged blob vs occurrence-only).
Cannot choose a format without knowing the size.

The corpus table has 522,006 taxa across all of iNat; only our ~11,167 BIRD
species matter. Measures, after filtering to birds:
  - distinct (species, cell) pairs and occupied cells
  - on-disk bytes at 1-byte and 2-byte quantised log-probability
  - gzipped size, GLOBAL and NORTH-AMERICA-only
  - how many cells are so sparse they could be dropped
Compares against the existing range-priors: 681,023 cells / 260 MiB.

Blob format assumed (mirrors the BirdLife layout so a merge is possible):
  per cell, per species: 8-byte species key + N-byte quantised log-prob
A 2-byte species INDEX into taxonomy.json would be far smaller than the
8-byte eBird code, so both are reported.
"""
import argparse
import gzip
import json
import math

import duckdb
import numpy as np


def human(n):
    for u in ["B", "KiB", "MiB", "GiB"]:
        if n < 1024:
            return str(round(n, 1)) + " " + u
        n = n / 1024.0
    return str(round(n, 1)) + " TiB"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--occurrence", required=True)
    ap.add_argument("--totals", required=True)
    ap.add_argument("--target-taxa", required=True)
    args = ap.parse_args()

    con = duckdb.connect()
    con.execute("SET memory_limit=" + chr(39) + "12GB" + chr(39))

    con.execute("CREATE TEMP TABLE birds AS SELECT CAST(inat_taxon_id AS BIGINT) "
                "AS tid FROM read_csv(" + chr(39) + args.target_taxa + chr(39) +
                ", header=true, all_varchar=true)")
    nb = con.execute("SELECT count(*) FROM birds").fetchone()[0]
    print("bird taxa in taxonomy:", nb)

    con.execute("CREATE TEMP TABLE occ AS SELECT o.row, o.col, o.taxon_id, o.n "
                "FROM read_parquet(" + chr(39) + args.occurrence + chr(39) + ") o "
                "JOIN birds b ON o.taxon_id = b.tid")
    r = con.execute("SELECT count(*), count(DISTINCT (row,col)), "
                    "count(DISTINCT taxon_id), sum(n) FROM occ").fetchone()
    pairs, cells, spp, tot = r
    print()
    print("=== BIRDS ONLY ===")
    print("  (species,cell) pairs :", format(pairs, ","))
    print("  occupied cells       :", format(cells, ","))
    print("  species              :", format(spp, ","))
    print("  observations         :", format(tot, ","))
    print("  mean species/cell    :", round(pairs / max(cells, 1), 1))

    print()
    print("=== RAW SIZE ESTIMATES (uncompressed) ===")
    for keyb, keyname in [(8, "8-byte eBird code"), (2, "2-byte taxonomy index")]:
        for valb in [1, 2]:
            sz = pairs * (keyb + valb)
            print("  " + keyname.ljust(24) + " + " + str(valb) + "-byte logprob: " +
                  human(sz))

    print()
    print("=== SPARSITY: could we drop thin cells? ===")
    for thr in [1, 2, 5, 10, 50]:
        rr = con.execute("SELECT count(*) FROM (SELECT row, col, sum(n) s FROM occ "
                         "GROUP BY 1,2) WHERE s < " + str(thr)).fetchone()[0]
        pp = con.execute("SELECT count(*) FROM occ WHERE (row,col) IN "
                         "(SELECT row, col FROM (SELECT row, col, sum(n) s FROM occ "
                         "GROUP BY 1,2) WHERE s < " + str(thr) + ")").fetchone()[0]
        print("  cells with <" + str(thr) + " obs: " + format(rr, ",") +
              "  (" + str(round(100.0 * rr / max(cells, 1), 1)) + "% of cells, " +
              str(round(100.0 * pp / max(pairs, 1), 1)) + "% of pairs)")

    print()
    print("=== NORTH AMERICA ONLY (rough bbox: lat 15-72, lon -170..-50) ===")
    na = con.execute("SELECT count(*), count(DISTINCT (row,col)) FROM occ "
                     "WHERE row BETWEEN 40 AND 240 AND col BETWEEN 60 AND 420").fetchone()
    print("  pairs:", format(na[0], ","), " cells:", format(na[1], ","))
    for keyb in [8, 2]:
        for valb in [1, 2]:
            print("    " + str(keyb) + "+" + str(valb) + " bytes -> " +
                  human(na[0] * (keyb + valb)))

    print()
    print("=== ACTUAL GZIP TEST (sample of 2,000 cells) ===")
    rows = con.execute("SELECT row, col, taxon_id, n FROM occ WHERE (row,col) IN "
                       "(SELECT row, col FROM (SELECT DISTINCT row, col FROM occ "
                       "LIMIT 2000)) ORDER BY row, col").fetchall()
    tots = dict(con.execute("SELECT (row::VARCHAR || " + chr(39) + "-" + chr(39) +
                            " || col::VARCHAR), sum(n) FROM occ GROUP BY 1").fetchall())
    buf = bytearray()
    for rw, cl, tid, n in rows:
        t = tots.get(str(rw) + "-" + str(cl), 1)
        p = max(n / max(t, 1), 1e-9)
        q = int(max(0, min(255, round(-math.log(p) * 16))))
        buf += int(tid).to_bytes(4, "little")
        buf += bytes([q])
    raw = len(buf)
    gz = len(gzip.compress(bytes(buf), 9))
    ncell = len(set((r[0], r[1]) for r in rows))
    print("  sample: " + str(len(rows)) + " pairs across " + str(ncell) + " cells")
    print("  raw " + human(raw) + " -> gzip " + human(gz) +
          "  (ratio " + str(round(raw / max(gz, 1), 2)) + "x)")
    per_pair_gz = gz / max(len(rows), 1)
    print("  => ~" + str(round(per_pair_gz, 2)) + " gzipped bytes per pair")
    print()
    print("  EXTRAPOLATED GLOBAL (4-byte tid + 1-byte logprob, gzipped): " +
          human(per_pair_gz * pairs))
    print("  EXTRAPOLATED NORTH AMERICA:                                " +
          human(per_pair_gz * na[0]))
    print()
    print("  compare: existing BirdLife range-priors = 681,023 cells / 260 MiB")
    print("=== SIZE MEASUREMENT DONE ===")


if __name__ == "__main__":
    main()
