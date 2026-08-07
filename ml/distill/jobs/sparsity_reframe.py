"""Was the sparsity framing right? Three checks.

The earlier number was PAIR-weighted: half of all (species, cell) pairs have one
observation. That is true but possibly the wrong statistic, because queries do
not land uniformly across pairs. Photos get taken where people bird, so the
pairs a user actually hits are the well-sampled ones.

So:
  1. observation-weighted support, not pair-weighted
  2. per-CELL totals, since a well-birded cell can support monthly estimates for
     its common species even when its rare species cannot
  3. coarsening sensitivity: the grid is 27 km, so aggregate 3x3 into 81 km and
     see how much support that recovers

Point 3 matters because the temporal layer does not have to use the same
resolution as the spatial one. A coarser grid for month is a legitimate design,
not a compromise.
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
    P = args.cells

    log("=== 1. observation-weighted support ===")
    log("For a RANDOM OBSERVATION, how much data backs its (species, cell) pair?")
    q = """
    WITH t AS (SELECT n FROM read_parquet(?))
    SELECT
      sum(n)                                        AS obs,
      sum(CASE WHEN n >= 12  THEN n ELSE 0 END)     AS obs_ge12,
      sum(CASE WHEN n >= 60  THEN n ELSE 0 END)     AS obs_ge60,
      sum(CASE WHEN n >= 120 THEN n ELSE 0 END)     AS obs_ge120
    FROM t
    """
    obs, ge12, ge60, ge120 = con.execute(q, [P]).fetchone()
    log("  in a pair with >=12 obs  (1/month avg):  %.1f%%" % (100.0 * ge12 / obs))
    log("  in a pair with >=60 obs  (5/month avg):  %.1f%%" % (100.0 * ge60 / obs))
    log("  in a pair with >=120 obs (10/month avg): %.1f%%" % (100.0 * ge120 / obs))
    log("")
    log("  Compare with the PAIR-weighted view: only 8.7%% of pairs reach 12.")
    log("  The gap between these two numbers is the whole point.")

    log("")
    log("=== 2. per-cell totals ===")
    q2 = """
    WITH c AS (
      SELECT row, col, sum(n) AS cell_obs, count(*) AS species
      FROM read_parquet(?) GROUP BY row, col
    )
    SELECT count(*), quantile_cont(cell_obs, 0.5), quantile_cont(cell_obs, 0.9),
           quantile_cont(species, 0.5),
           sum(CASE WHEN cell_obs >= 1000 THEN 1 ELSE 0 END)
    FROM c
    """
    ncells, cp50, cp90, sp50, big = con.execute(q2, [P]).fetchone()
    log("  occupied cells:            %d" % ncells)
    log("  median observations/cell:  %.0f" % cp50)
    log("  p90 observations/cell:     %.0f" % cp90)
    log("  median species/cell:       %.0f" % sp50)
    log("  cells with >=1000 obs:     %d (%.1f%%)" % (big, 100.0 * big / ncells))

    log("")
    log("=== 3. coarsening the grid for the temporal layer ===")
    log("Grid is 27 km. Aggregate 3x3 (81 km) and 5x5 (135 km):")
    for f in (1, 3, 5):
        q3 = """
        WITH a AS (
          SELECT row / ? AS r, col / ? AS c, taxon_id, sum(n) AS n
          FROM read_parquet(?) GROUP BY 1, 2, 3
        )
        SELECT count(*), sum(n),
               sum(CASE WHEN n >= 12 THEN 1 ELSE 0 END),
               sum(CASE WHEN n >= 12 THEN n ELSE 0 END)
        FROM a
        """
        pairs, tot, ok, okobs = con.execute(q3, [f, f, P]).fetchone()
        log("  %3d km: pairs %10d   >=12 obs: %6.1f%% of pairs, %.1f%% of observations"
            % (27 * f, pairs, 100.0 * ok / pairs, 100.0 * okobs / tot))

    log("")
    log("If the observation-weighted share is high, then a monthly prior helps")
    log("the queries users actually make, and the thin pairs simply need to fall")
    log("back to the annual estimate rather than be scored as absent.")


if __name__ == "__main__":
    main()
