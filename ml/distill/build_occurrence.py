#!/usr/bin/env python3
"""Step 4: empirical P(species | cell) from the FULL iNat corpus.

The four BirdLife status weights cannot tell a Rock Pigeon from a Northern
Hawk-Owl when both are merely `present` in Seattle -- polygons encode CAN
OCCUR HERE, not HOW LIKELY. This adds the abundance half.

Source is observations.csv.gz (raw dump), NOT train_manifest.parquet, which is
post-floor (>=50) and post-cap (500/species) and so flattens exactly the
abundance ratios we need. Metadata only, no images.

PROJECTION: exact port of lonLatToEqualEarth from functions/lib/range-adjust.js,
using the WGS84 ELLIPSOID (authalic latitude beta), NOT a sphere. Verified
12/12 cell-id matches against the JS across Seattle, Chicago, Maui, Amsterdam,
Taipei, Sydney, Nairobi, Reykjavik and the origin. A spherical approximation
was off by a full cell in several places, which would have silently
misaligned occurrence counts against the range priors.

Observer-effort bias is ACCEPTED deliberately: we want
P(species | someone points a phone at a bird here), not true ecological
abundance, and iNat users are the same kind of humans in the same accessible
places as WingDex users.
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
    ap.add_argument("--out", default="occurrence_cells.parquet")
    ap.add_argument("--totals", default="occurrence_totals.parquet")
    ap.add_argument("--memory-limit", default="20GB")
    ap.add_argument("--temp-dir", default="/home/jlian/wingdex/ml/distill/.duckdbtmp")
    a2 = ap.parse_args()

    obs = a2.meta.rstrip("/") + "/observations.csv.gz"
    con = duckdb.connect()
    con.execute("PRAGMA enable_progress_bar")
    con.execute("SET memory_limit=" + chr(39) + a2.memory_limit + chr(39))
    con.execute("SET temp_directory=" + chr(39) + a2.temp_dir + chr(39))
    con.execute("SET preserve_insertion_order=false")
    log("memory_limit=" + a2.memory_limit + " temp=" + a2.temp_dir)

    rd = ("read_csv(" + chr(39) + obs + chr(39) + ", delim=" + chr(39) +
          chr(92) + "t" + chr(39) + ", header=true, quote=" + chr(39) + chr(39) +
          ", escape=" + chr(39) + chr(39) + ", ignore_errors=true, all_varchar=true)")

    src = ("SELECT CAST(taxon_id AS BIGINT) AS taxon_id, "
           "CAST(latitude AS DOUBLE) AS lat, CAST(longitude AS DOUBLE) AS lon "
           "FROM " + rd + " WHERE quality_grade = " + chr(39) + "research" +
           chr(39) + " AND latitude IS NOT NULL AND longitude IS NOT NULL "
           "AND taxon_id IS NOT NULL")

    log("projecting + binning (streams the 12GB gzip, expect ~10-20 min)...")
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
    ncells = con.execute("SELECT count(DISTINCT (row,col)) FROM occ").fetchone()[0]
    nsp = con.execute("SELECT count(DISTINCT taxon_id) FROM occ").fetchone()[0]
    ntot = con.execute("SELECT sum(n) FROM occ").fetchone()[0]
    log(str(npairs) + " (species,cell) pairs | " + str(ncells) + " cells | " +
        str(nsp) + " taxa | " + str(ntot) + " observations")

    con.execute("CREATE OR REPLACE TABLE tot AS SELECT row, col, sum(n) AS total "
                "FROM occ GROUP BY 1,2")
    con.execute("COPY occ TO " + chr(39) + a2.out + chr(39) +
                " (FORMAT PARQUET, COMPRESSION ZSTD)")
    con.execute("COPY tot TO " + chr(39) + a2.totals + chr(39) +
                " (FORMAT PARQUET, COMPRESSION ZSTD)")
    log("wrote " + a2.out + " and " + a2.totals)

    top = con.execute("SELECT taxon_id, sum(n) s FROM occ GROUP BY 1 "
                      "ORDER BY s DESC LIMIT 5").fetchall()
    log("most-observed taxa: " + str(top))
    sea = con.execute("SELECT taxon_id, n FROM occ WHERE row=96 AND col=273 "
                      "ORDER BY n DESC LIMIT 5").fetchall()
    log("top taxa in the Seattle cell (96,273): " + str(sea))
    print("=== OCCURRENCE BUILD DONE ===")


if __name__ == "__main__":
    main()
