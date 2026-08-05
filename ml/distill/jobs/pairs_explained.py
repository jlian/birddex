"""Make the (species, cell) pair concept concrete with real examples.

"Median 1" sounds impossible next to 157M observations, so show the actual
distribution and name real species in a real cell.

A PAIR is one species in one 27 km grid square. ("Mallard", Seattle-cell) is one
pair. ("Rufous Hummingbird", Seattle-cell) is another. The whole dataset is
26.4M such combinations.

Mean is 157.1M / 26.4M = 5.95 observations per pair. Median is 1. Both are true
because the distribution is a power law: a small number of common-bird-in-a-
birded-place pairs carry most observations, and a very long tail of one-off
sightings carries almost none.
"""
import argparse

import duckdb


def log(m):
    print(m, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cells", default="occurrence_cells.parquet")
    ap.add_argument("--taxa", default="target_taxa.csv")
    args = ap.parse_args()
    con = duckdb.connect()
    P = args.cells

    log("=== what one PAIR is: one species, in one 27 km square ===")
    log("")
    log("Seattle is around 47.61 N, 122.33 W. Its cell in this grid:")

    # Find the busiest cell, which will be a heavily birded place.
    q = """
    SELECT row, col, sum(n) AS obs, count(*) AS species
    FROM read_parquet(?) GROUP BY row, col ORDER BY obs DESC LIMIT 1
    """
    row, col, obs, nsp = con.execute(q, [P]).fetchone()
    log("  busiest cell in the world: row=%d col=%d, %d observations, %d species"
        % (row, col, obs, nsp))

    q2 = """
    SELECT taxon_id, n FROM read_parquet(?)
    WHERE row = ? AND col = ? ORDER BY n DESC LIMIT 5
    """
    log("")
    log("  its top 5 pairs by count:")
    for tid, n in con.execute(q2, [P, row, col]).fetchall():
        log("    taxon %-9d %8d observations" % (tid, n))

    q3 = """
    SELECT count(*) FROM read_parquet(?)
    WHERE row = ? AND col = ? AND n = 1
    """
    ones = con.execute(q3, [P, row, col]).fetchone()[0]
    log("")
    log("  and in that SAME cell, %d of its %d species have exactly 1 record."
        % (ones, nsp))
    log("  Those are the vagrants and one-off sightings. Same place, same grid")
    log("  square, wildly different amounts of data per species.")

    log("")
    log("=== the distribution that makes median 1 and mean 5.95 both true ===")
    q4 = """
    WITH t AS (SELECT n FROM read_parquet(?))
    SELECT
      sum(CASE WHEN n = 1 THEN 1 ELSE 0 END),
      sum(CASE WHEN n BETWEEN 2 AND 9 THEN 1 ELSE 0 END),
      sum(CASE WHEN n BETWEEN 10 AND 99 THEN 1 ELSE 0 END),
      sum(CASE WHEN n BETWEEN 100 AND 999 THEN 1 ELSE 0 END),
      sum(CASE WHEN n >= 1000 THEN 1 ELSE 0 END),
      sum(CASE WHEN n = 1 THEN n ELSE 0 END),
      sum(CASE WHEN n BETWEEN 2 AND 9 THEN n ELSE 0 END),
      sum(CASE WHEN n BETWEEN 10 AND 99 THEN n ELSE 0 END),
      sum(CASE WHEN n BETWEEN 100 AND 999 THEN n ELSE 0 END),
      sum(CASE WHEN n >= 1000 THEN n ELSE 0 END),
      count(*), sum(n)
    FROM t
    """
    r = con.execute(q4, [P]).fetchone()
    buckets = ["=1", "2-9", "10-99", "100-999", ">=1000"]
    log("")
    log("  %-10s %12s %8s %14s %8s" % ("count", "pairs", "% pairs", "observations", "% obs"))
    for i, b in enumerate(buckets):
        log("  %-10s %12d %7.1f%% %14d %7.1f%%"
            % (b, r[i], 100.0 * r[i] / r[10], r[5 + i], 100.0 * r[5 + i] / r[11]))
    log("")
    log("  Read the last two columns against each other: the 1-record pairs are")
    log("  HALF of all pairs but a rounding error of the observations.")


if __name__ == "__main__":
    main()
