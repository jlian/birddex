#!/usr/bin/env python3
"""TEMPORAL HOLDOUT: does the occurrence prior survive drift?

Geographic holdout showed the prior transfers to unseen CELLS. This tests a
different failure: the prior is built from observations that include the same
era as the test photos. If bird distributions, or iNat usage patterns, shift
over time, a prior fitted on contemporaneous data will look better than one
deployed against future photos.

Build the counts from PRE-2024 observations only, then evaluate on calibration
photos observed in 2025+. That is a genuine forward-in-time test: the prior
cannot have seen anything from the evaluation period.

Compares against the full-corpus prior on the SAME photos, so the difference
isolates the temporal effect rather than the photo subset.
"""
import argparse
import time

import duckdb

ORIGIN_X = -17226000.0
ORIGIN_Y = 8343000.0
CELL = 27000.0
COLS = 1276
ROWS = 618


def log(m):
    print("[" + time.strftime("%H:%M:%S") + "] " + str(m), flush=True)


def ee_cte(src_sql):
    p = []
    p.append("WITH src AS (" + src_sql + "),")
    p.append("kk AS (SELECT 6378137.0 AS a, 1.0/298.257223563 AS f),")
    p.append("kk2 AS (SELECT a, 1 - ((a*(1-f))*(a*(1-f)))/(a*a) AS e2 FROM kk),")
    p.append("kk3 AS (SELECT a, e2, sqrt(e2) AS e FROM kk2),")
    p.append("kk4 AS (SELECT a, e2, e,")
    p.append("  1 + ((1-e2)/(2*e))*ln((1+e)/(1-e)) AS qp,")
    p.append("  a*sqrt(0.5*(1 + ((1-e2)/(2*e))*ln((1+e)/(1-e)))) AS R FROM kk3),")
    p.append("q1 AS (SELECT s.*, R, qp,")
    p.append("  (1-e2)*( sin(radians(lat))/(1-e2*sin(radians(lat))*sin(radians(lat)))")
    p.append("   - (1/(2*e))*ln((1-e*sin(radians(lat)))/(1+e*sin(radians(lat)))) ) AS q")
    p.append("  FROM src s, kk4),")
    p.append("t1 AS (SELECT q1.*, asin((sqrt(3.0)/2.0)*sin(asin(q/qp))) AS t FROM q1),")
    p.append("xy AS (SELECT t1.*,")
    p.append("  R*((2*sqrt(3.0)*radians(lon)*cos(t))/(3*(1.340264 + 3*(-0.081106)*t*t")
    p.append("    + pow(t,6)*(7*0.000893 + 9*0.003796*t*t)))) AS xx,")
    p.append("  R*t*(1.340264 + (-0.081106)*t*t + pow(t,6)*(0.000893 + 0.003796*t*t)) AS yy")
    p.append("  FROM t1)")
    return chr(10).join(p)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--meta", required=True)
    ap.add_argument("--cutoff", default="2024-01-01")
    ap.add_argument("--out", default="occurrence_pre2024.parquet")
    ap.add_argument("--totals", default="occurrence_pre2024_totals.parquet")
    ap.add_argument("--memory-limit", default="20GB")
    a2 = ap.parse_args()

    obs = a2.meta.rstrip("/") + "/observations.csv.gz"
    con = duckdb.connect()
    con.execute("PRAGMA enable_progress_bar")
    con.execute("SET memory_limit=" + chr(39) + a2.memory_limit + chr(39))
    con.execute("SET preserve_insertion_order=false")

    rd = ("read_csv(" + chr(39) + obs + chr(39) + ", delim=" + chr(39) +
          chr(92) + "t" + chr(39) + ", header=true, quote=" + chr(39) + chr(39) +
          ", escape=" + chr(39) + chr(39) + ", ignore_errors=true, all_varchar=true)")

    src = ("SELECT CAST(taxon_id AS BIGINT) AS taxon_id, "
           "CAST(latitude AS DOUBLE) AS lat, CAST(longitude AS DOUBLE) AS lon "
           "FROM " + rd + " WHERE quality_grade = " + chr(39) + "research" +
           chr(39) + " AND latitude IS NOT NULL AND longitude IS NOT NULL "
           "AND taxon_id IS NOT NULL AND observed_on IS NOT NULL "
           "AND observed_on < " + chr(39) + a2.cutoff + chr(39))

    log("binning PRE-" + a2.cutoff + " observations only...")
    q = (ee_cte(src) + chr(10) +
         "SELECT taxon_id, CAST(floor((" + str(ORIGIN_Y) + " - yy)/" + str(CELL) +
         ") AS INTEGER) AS row, CAST(floor((xx - (" + str(ORIGIN_X) + "))/" +
         str(CELL) + ") AS INTEGER) AS col FROM xy "
         "WHERE lat BETWEEN -90 AND 90 AND lon BETWEEN -180 AND 180")
    con.execute("CREATE OR REPLACE TABLE occ AS SELECT row, col, taxon_id, "
                "count(*) AS n FROM (" + q + ") WHERE row BETWEEN 0 AND " +
                str(ROWS - 1) + " AND col BETWEEN 0 AND " + str(COLS - 1) +
                " GROUP BY 1,2,3")
    npairs = con.execute("SELECT count(*) FROM occ").fetchone()[0]
    ntot = con.execute("SELECT sum(n) FROM occ").fetchone()[0]
    log(str(npairs) + " pairs | " + str(ntot) + " observations (pre-cutoff)")
    con.execute("CREATE OR REPLACE TABLE tot AS SELECT row, col, sum(n) AS total "
                "FROM occ GROUP BY 1,2")
    con.execute("COPY occ TO " + chr(39) + a2.out + chr(39) +
                " (FORMAT PARQUET, COMPRESSION ZSTD)")
    con.execute("COPY tot TO " + chr(39) + a2.totals + chr(39) +
                " (FORMAT PARQUET, COMPRESSION ZSTD)")
    log("wrote " + a2.out)
    print("=== PRE-CUTOFF OCCURRENCE DONE ===")


if __name__ == "__main__":
    main()
