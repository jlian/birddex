"""G16: build a MONTH-aware occurrence prior, with backoff.

The pooled prior is P(species | cell). This adds P(species | cell, month) but
does NOT simply swap one for the other, because the counts do not support it
everywhere: median count per (species, cell) is 1, and only 8.7% of pairs reach
12 observations. A naive split turns "nobody birded here in February" into
"this species is absent".

Instead the monthly estimate is shrunk toward the pooled one:

    P(sp | cell, month) = (n_scm + k * P(sp | cell)) / (n_cm + k)

k is a pseudo-count in units of observations. When a cell-month has plenty of
data, n_cm dominates and the monthly signal comes through. When it is thin, the
estimate falls back to the pooled prior rather than to zero. k = 0 is a pure
monthly split and k = infinity reproduces the current pooled behaviour, so the
sweep brackets the existing prior and cannot do worse than it by construction.

This writes the same schema as build_occurrence.py plus a `month` column, so
join_occurrence.py needs only the month of each photo to line the counts up.
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
    p.append("q1 AS (SELECT s.*, kk4.R, kk4.qp,")
    p.append("  (1-kk4.e2)*(sin(radians(s.lat))/(1-kk4.e2*sin(radians(s.lat))*sin(radians(s.lat)))")
    p.append("   - (1/(2*kk4.e))*ln((1-kk4.e*sin(radians(s.lat)))/(1+kk4.e*sin(radians(s.lat))))) AS q")
    p.append("  FROM src s, kk4),")
    p.append("t1 AS (SELECT q1.*, asin((sqrt(3.0)/2.0)*sin(asin(q/qp))) AS t FROM q1),")
    p.append("xy AS (SELECT t1.*,")
    p.append("  R*((2*sqrt(3.0)*radians(lon)*cos(t))/(3*(1.340264 + 3*(-0.081106)*t*t")
    p.append("    + (t*t*t*t*t*t)*(7*0.000893 + 9*0.003796*t*t)))) AS xx,")
    p.append("  R*t*(1.340264 + (-0.081106)*t*t + (t*t*t*t*t*t)*(0.000893 + 0.003796*t*t)) AS yy")
    p.append("  FROM t1)")
    return chr(10).join(p)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--meta", required=True, help="dir holding observations.csv.gz")
    ap.add_argument("--out", default="occurrence_month.parquet")
    ap.add_argument("--totals", default="occurrence_month_totals.parquet")
    ap.add_argument("--threads", type=int, default=0)
    args = ap.parse_args()

    con = duckdb.connect()
    if args.threads:
        con.execute("PRAGMA threads=" + str(args.threads))
    con.execute("PRAGMA enable_progress_bar=false")

    obs = args.meta.rstrip("/") + "/observations.csv.gz"
    rd = ("read_csv(" + chr(39) + obs + chr(39) + ", delim=" + chr(39) +
          chr(9) + chr(39) + ", header=true, quote=" + chr(39) + chr(39) +
          ", escape=" + chr(39) + chr(39) + ", ignore_errors=true, all_varchar=true)")

    # observed_on is the only new column. It sits next to the lat/lon already
    # used, so this costs one more field in the same single pass.
    src = ("SELECT CAST(taxon_id AS BIGINT) AS taxon_id, "
           "CAST(latitude AS DOUBLE) AS lat, CAST(longitude AS DOUBLE) AS lon, "
           "CAST(month(CAST(observed_on AS DATE)) AS INTEGER) AS mon "
           "FROM " + rd + " WHERE quality_grade = " + chr(39) + "research" +
           chr(39) + " AND latitude IS NOT NULL AND longitude IS NOT NULL "
           "AND taxon_id IS NOT NULL AND observed_on IS NOT NULL "
           "AND try_cast(observed_on AS DATE) IS NOT NULL")

    log("projecting + binning by (species, cell, month), streams the 12GB gzip...")
    q = (ee_cte(src) + chr(10) +
         "SELECT taxon_id, mon, CAST(floor((" + str(ORIGIN_Y) + " - yy)/" + str(CELL) +
         ") AS INTEGER) AS row, CAST(floor((xx - (" + str(ORIGIN_X) + "))/" +
         str(CELL) + ") AS INTEGER) AS col FROM xy "
         "WHERE lat BETWEEN -90 AND 90 AND lon BETWEEN -180 AND 180")
    con.execute("CREATE OR REPLACE TABLE occm AS SELECT row, col, taxon_id, mon, "
                "count(*) AS n FROM (" + q + ") WHERE row BETWEEN 0 AND " +
                str(ROWS - 1) + " AND col BETWEEN 0 AND " + str(COLS - 1) +
                " AND mon BETWEEN 1 AND 12 GROUP BY 1,2,3,4")

    n_triples = con.execute("SELECT count(*) FROM occm").fetchone()[0]
    n_tot = con.execute("SELECT sum(n) FROM occm").fetchone()[0]
    log(str(n_triples) + " (species,cell,month) triples | " + str(n_tot) + " observations")

    # Pooled counts, so the client can shrink toward them.
    con.execute("CREATE OR REPLACE TABLE occ AS "
                "SELECT row, col, taxon_id, sum(n) AS n FROM occm GROUP BY 1,2,3")
    con.execute("CREATE OR REPLACE TABLE totm AS "
                "SELECT row, col, mon, sum(n) AS total FROM occm GROUP BY 1,2,3")
    con.execute("CREATE OR REPLACE TABLE tot AS "
                "SELECT row, col, sum(n) AS total FROM occ GROUP BY 1,2")

    npairs = con.execute("SELECT count(*) FROM occ").fetchone()[0]
    log(str(npairs) + " pooled (species,cell) pairs for the backoff target")

    con.execute("COPY occm TO " + chr(39) + args.out + chr(39) +
                " (FORMAT PARQUET, COMPRESSION ZSTD)")
    con.execute("COPY totm TO " + chr(39) + args.totals + chr(39) +
                " (FORMAT PARQUET, COMPRESSION ZSTD)")
    log("wrote " + args.out + " and " + args.totals)

    # Sanity: a migratory species should show a strong seasonal signal in a
    # cell where it is only present part of the year. Rufous Hummingbird in
    # the Seattle cell is the canonical case.
    log("")
    log("sanity, Seattle cell (96,273) monthly totals:")
    rows = con.execute("SELECT mon, total FROM totm WHERE row=96 AND col=273 "
                       "ORDER BY mon").fetchall()
    for m, t in rows:
        log("  month %2d  %8d observations" % (m, t))


if __name__ == "__main__":
    main()
