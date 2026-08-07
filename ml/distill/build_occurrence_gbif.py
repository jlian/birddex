#!/usr/bin/env python3
"""Build an INDEPENDENT occurrence prior from GBIF, excluding iNaturalist.

WHY: every result so far uses iNat photos scored against an iNat-derived
prior. Geographic transfer is verified (0.87 pt penalty) and temporal transfer
is measured (2.88 pt cost over 2 years), but SOURCE transfer is not. If the
+6.4 pt occurrence gain is an artifact of prior and photos sharing a source,
this is where it shows.

GBIF aggregates iNat but ALSO eBird/EOD, museum specimens and national
atlases. Filtering `datasetkey != <iNat>` yields a genuinely independent
prior. eBird direct access was requested and never granted; NABirds has no
GPS at all; so this is the available independent source.

Reads the AWS Open Data mirror in place via DuckDB httpfs -- no download, no
auth. Streams tens of GB, so expect hours, not minutes. Network-bound.

Grid + projection are the SAME verified ellipsoidal Equal Earth used for the
iNat layer (12/12 cell-id match against production JS), so the two priors are
directly comparable.

CAVEAT to record with any result: eBird checklists are SYSTEMATIC SURVEYS,
skewed toward what birders deliberately seek. That may be a truer abundance
signal but a WORSE match for "what a casual user photographs", which is what
WingDex actually needs. A GBIF prior losing to the iNat prior would therefore
not be a bug.
"""
import argparse
import time

import duckdb

ORIGIN_X = -17226000.0
ORIGIN_Y = 8343000.0
CELL = 27000.0
COLS = 1276
ROWS = 618
INAT_DATASET = "50c9509d-22c7-4a22-a47d-8c48425ef4a7"


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
    ap.add_argument("--snapshot", default="2026-07-01")
    ap.add_argument("--out", default="occurrence_gbif.parquet")
    ap.add_argument("--totals", default="occurrence_gbif_totals.parquet")
    ap.add_argument("--memory-limit", default="18GB")
    ap.add_argument("--exclude-inat", action="store_true", default=True)
    ap.add_argument("--threads", type=int, default=8)
    a2 = ap.parse_args()

    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    con.execute("SET s3_region=" + chr(39) + "us-east-1" + chr(39))
    con.execute("SET memory_limit=" + chr(39) + a2.memory_limit + chr(39))
    con.execute("SET threads=" + str(a2.threads))
    con.execute("SET preserve_insertion_order=false")
    con.execute("SET temp_directory=" + chr(39) +
                "/home/jlian/wingdex/ml/distill/.duckdbtmp" + chr(39))
    con.execute("PRAGMA enable_progress_bar")

    base = ("s3://gbif-open-data-us-east-1/occurrence/" + a2.snapshot +
            "/occurrence.parquet/*")
    log("source: " + base)
    log("excluding iNat dataset: " + str(a2.exclude_inat))

    where = []
    where.append("class = " + chr(39) + "Aves" + chr(39))
    where.append("decimallatitude IS NOT NULL")
    where.append("decimallongitude IS NOT NULL")
    where.append("species IS NOT NULL")
    where.append("occurrencestatus = " + chr(39) + "PRESENT" + chr(39))
    if a2.exclude_inat:
        where.append("datasetkey <> " + chr(39) + INAT_DATASET + chr(39))

    src = ("SELECT species AS sp, CAST(decimallatitude AS DOUBLE) AS lat, "
           "CAST(decimallongitude AS DOUBLE) AS lon FROM read_parquet(" +
           chr(39) + base + chr(39) + ") WHERE " + " AND ".join(where))

    log("streaming GBIF Aves (this is the slow part -- network bound)...")
    q = (ee_cte(src) + chr(10) +
         "SELECT sp, CAST(floor((" + str(ORIGIN_Y) + " - yy)/" + str(CELL) +
         ") AS INTEGER) AS row, CAST(floor((xx - (" + str(ORIGIN_X) + "))/" +
         str(CELL) + ") AS INTEGER) AS col FROM xy "
         "WHERE lat BETWEEN -90 AND 90 AND lon BETWEEN -180 AND 180")
    con.execute("CREATE OR REPLACE TABLE occ AS SELECT row, col, sp, "
                "count(*) AS n FROM (" + q + ") WHERE row BETWEEN 0 AND " +
                str(ROWS - 1) + " AND col BETWEEN 0 AND " + str(COLS - 1) +
                " GROUP BY 1,2,3")

    npairs = con.execute("SELECT count(*) FROM occ").fetchone()[0]
    ncells = con.execute("SELECT count(DISTINCT (row,col)) FROM occ").fetchone()[0]
    nsp = con.execute("SELECT count(DISTINCT sp) FROM occ").fetchone()[0]
    ntot = con.execute("SELECT sum(n) FROM occ").fetchone()[0]
    log(str(npairs) + " (species,cell) pairs | " + str(ncells) + " cells | " +
        str(nsp) + " species | " + str(ntot) + " occurrences")

    con.execute("CREATE OR REPLACE TABLE tot AS SELECT row, col, sum(n) AS total "
                "FROM occ GROUP BY 1,2")
    con.execute("COPY occ TO " + chr(39) + a2.out + chr(39) +
                " (FORMAT PARQUET, COMPRESSION ZSTD)")
    con.execute("COPY tot TO " + chr(39) + a2.totals + chr(39) +
                " (FORMAT PARQUET, COMPRESSION ZSTD)")
    log("wrote " + a2.out)

    sea = con.execute("SELECT sp, n FROM occ WHERE row=96 AND col=273 "
                      "ORDER BY n DESC LIMIT 5").fetchall()
    log("top species in the Seattle cell (96,273): " + str(sea))
    print("=== GBIF OCCURRENCE DONE ===")


if __name__ == "__main__":
    main()
