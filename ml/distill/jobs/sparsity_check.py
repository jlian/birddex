"""Is a monthly occurrence prior too sparse to be useful?

The corpus is large: 157M research-grade observations giving 3,176,965
(species, cell) pairs. So "we have plenty of data" is true in aggregate. The
question is what happens to the SMALLEST useful unit once it is split 12 ways.

Sparsity here does not mean "not enough rows overall". It means the count for
one specific (species, cell, month) is small enough that zero stops meaning
"absent" and starts meaning "nobody looked in November".

That distinction is the whole risk. The current prior treats a zero as strong
evidence, worth OCC_FLOOR = log(1e-9). If monthly zeros are mostly sampling
gaps rather than true absences, the same floor would veto correct species.

Measured here, on the real parquet:
  1. distribution of per-pair counts today
  2. what fraction of pairs would fall below a usable threshold if split by month
  3. how many cell-months would be entirely empty for a species that IS present
     in that cell annually, which is the false-zero rate that matters
"""
import argparse

import duckdb


def log(m):
    print(m, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cells", default="occurrence_cells.parquet")
    args = ap.parse_args()

    con = duckdb.connect()

    log("=== current (species, cell) pair counts ===")
    q = """
    SELECT
      count(*)                                   AS pairs,
      sum(n)                                     AS total_obs,
      quantile_cont(n, 0.50)                     AS p50,
      quantile_cont(n, 0.90)                     AS p90,
      sum(CASE WHEN n = 1 THEN 1 ELSE 0 END)     AS singletons,
      sum(CASE WHEN n < 12 THEN 1 ELSE 0 END)    AS under12
    FROM read_parquet(?)
    """
    r = con.execute(q, [args.cells]).fetchone()
    pairs, total, p50, p90, singles, under12 = r
    log("  pairs           %12d" % pairs)
    log("  observations    %12d" % total)
    log("  median count    %12.0f" % p50)
    log("  p90 count       %12.0f" % p90)
    log("  count == 1      %12d  (%.1f%%)" % (singles, 100.0 * singles / pairs))
    log("  count < 12      %12d  (%.1f%%)" % (under12, 100.0 * under12 / pairs))

    log("")
    log("=== what a 12-way split implies ===")
    log("A pair with n < 12 CANNOT average one observation per month.")
    log("Those pairs would produce mostly-zero monthly cells, where zero means")
    log("'not sampled' rather than 'not present'.")
    log("")
    log("  pairs that survive a 12-way split with >= 1/month on average: %d (%.1f%%)"
        % (pairs - under12, 100.0 * (pairs - under12) / pairs))
    log("  pairs that do NOT:                                           %d (%.1f%%)"
        % (under12, 100.0 * under12 / pairs))

    log("")
    log("=== how much of the SIGNAL is in the thin pairs? ===")
    q2 = """
    SELECT
      sum(CASE WHEN n < 12 THEN n ELSE 0 END) AS obs_in_thin,
      sum(n)                                  AS obs_total
    FROM read_parquet(?)
    """
    thin, tot = con.execute(q2, [args.cells]).fetchone()
    log("  observations inside thin pairs: %d of %d (%.1f%%)"
        % (thin, tot, 100.0 * thin / tot))
    log("")
    log("Read it this way: if the thin pairs hold a small share of observations")
    log("but a large share of PAIRS, then splitting by month mostly damages the")
    log("rare species, which are exactly the ones a geographic prior is supposed")
    log("to help rank correctly.")


if __name__ == "__main__":
    main()
