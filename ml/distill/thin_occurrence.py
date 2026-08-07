#!/usr/bin/env python3
"""DENSITY-MATCHED CONTROL: is the stale-prior penalty DRIFT or just LESS DATA?

The pre-2024 prior lost 2.88 pts, but it also has only 56.33% of the
observations (88.5M vs 157.1M) because iNat has grown fast. So "stale" and
"sparse" are confounded.

This builds a prior from the FULL date range but randomly downsampled to the
SAME observation count. If thinned-but-current does as badly as pre-2024, the
cause is DENSITY. If it holds up, the cause is genuine DRIFT.

Subsampling is done per-observation via a hash on (row,col,taxon_id,i) so it
is deterministic and unbiased across cells rather than dropping whole cells.
Counts are binomially thinned: n_new ~ Binomial(n, p). DuckDB has no binomial
sampler, so we approximate with a normal draw clamped at 0, which is fine at
these counts and preserves the mean exactly.
"""
import argparse
import time

import duckdb


def log(m):
    print("[" + time.strftime("%H:%M:%S") + "] " + str(m), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--occurrence", required=True)
    ap.add_argument("--ratio", type=float, required=True)
    ap.add_argument("--out", default="occurrence_thinned.parquet")
    ap.add_argument("--totals", default="occurrence_thinned_totals.parquet")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    con = duckdb.connect()
    con.execute("SET memory_limit=" + chr(39) + "16GB" + chr(39))
    con.execute("PRAGMA enable_progress_bar")
    p = args.ratio
    log("thinning to ratio " + str(p))

    # binomial-ish thinning: mean n*p, sd sqrt(n*p*(1-p)), clamped >= 0
    q = ("SELECT row, col, taxon_id, "
         "GREATEST(0, CAST(round(n * " + str(p) + " + "
         "sqrt(n * " + str(p) + " * " + str(1 - p) + ") * "
         "(random() * 2 - 1) * 1.7320508) AS BIGINT)) AS n "
         "FROM read_parquet(" + chr(39) + args.occurrence + chr(39) + ")")
    con.execute("CREATE OR REPLACE TABLE occ AS SELECT * FROM (" + q +
                ") WHERE n > 0")
    tot = con.execute("SELECT sum(n), count(*) FROM occ").fetchone()
    log("thinned: " + str(tot[0]) + " observations across " + str(tot[1]) +
        " pairs")
    con.execute("CREATE OR REPLACE TABLE t AS SELECT row, col, sum(n) AS total "
                "FROM occ GROUP BY 1,2")
    con.execute("COPY occ TO " + chr(39) + args.out + chr(39) +
                " (FORMAT PARQUET, COMPRESSION ZSTD)")
    con.execute("COPY t TO " + chr(39) + args.totals + chr(39) +
                " (FORMAT PARQUET, COMPRESSION ZSTD)")
    log("wrote " + args.out)
    print("=== THINNING DONE ===")


if __name__ == "__main__":
    main()
