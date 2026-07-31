#!/usr/bin/env python3
"""Join occurrence counts onto the calibration candidates.

For each photo: its grid cell, the iNat observation count of each of its 25
candidate species IN THAT CELL, and the cell total. Emits an npz with
counts (N,K) and totals (N,) for fit_occurrence.py.

Uses the SAME verified ellipsoidal Equal Earth projection as
build_occurrence.py (12/12 cell-id match against the production JS).
"""
import argparse
import json

import numpy as np
import duckdb

ORIGIN_X = -17226000.0
ORIGIN_Y = 8343000.0
CELL = 27000.0


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
    ap.add_argument("--candidates", required=True)
    ap.add_argument("--occurrence", required=True)
    ap.add_argument("--totals", required=True)
    ap.add_argument("--target-taxa", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    import pandas as pd
    df = pd.read_parquet(args.candidates)
    N = len(df)
    idxs = np.stack(df["cand_idx"].values)
    K = idxs.shape[1]
    print("photos:", N, "candidates:", K)

    con = duckdb.connect()
    con.execute("SET memory_limit=" + chr(39) + "12GB" + chr(39))

    # app_idx -> inat_taxon_id
    tt = con.execute("SELECT CAST(app_idx AS BIGINT) app_idx, "
                     "CAST(inat_taxon_id AS BIGINT) tid FROM read_csv(" +
                     chr(39) + args.target_taxa + chr(39) +
                     ", header=true, all_varchar=true)").fetchall()
    app2tid = {int(a): int(b) for a, b in tt}
    print("app_idx -> taxon_id entries:", len(app2tid))

    # photo cells, via the verified projection
    pts = df[["photo_id", "latitude", "longitude"]].copy()
    con.register("pts", pts)
    src = ("SELECT photo_id, CAST(latitude AS DOUBLE) lat, "
           "CAST(longitude AS DOUBLE) lon FROM pts "
           "WHERE latitude IS NOT NULL AND longitude IS NOT NULL")
    q = (ee_cte(src) + chr(10) +
         "SELECT photo_id, CAST(floor((" + str(ORIGIN_Y) + " - yy)/" + str(CELL) +
         ") AS INTEGER) AS row, CAST(floor((xx - (" + str(ORIGIN_X) + "))/" +
         str(CELL) + ") AS INTEGER) AS col FROM xy")
    cells = con.execute(q).fetchall()
    cell_by_photo = {int(p): (int(r), int(c)) for p, r, c in cells}
    print("photos with a cell:", len(cell_by_photo))

    # only the cells we need
    need = sorted(set(cell_by_photo.values()))
    con.execute("CREATE TEMP TABLE needcells(row INTEGER, col INTEGER)")
    con.executemany("INSERT INTO needcells VALUES (?,?)", need)
    print("distinct cells needed:", len(need))

    occ = con.execute("SELECT o.row, o.col, o.taxon_id, o.n FROM read_parquet(" +
                      chr(39) + args.occurrence + chr(39) + ") o "
                      "JOIN needcells nc ON o.row=nc.row AND o.col=nc.col").fetchall()
    print("occurrence rows for those cells:", len(occ))
    cnt_by = {}
    for r, c, t, n in occ:
        cnt_by[(int(r), int(c), int(t))] = float(n)

    tot = con.execute("SELECT t.row, t.col, t.total FROM read_parquet(" +
                      chr(39) + args.totals + chr(39) + ") t "
                      "JOIN needcells nc ON t.row=nc.row AND t.col=nc.col").fetchall()
    tot_by = {(int(r), int(c)): float(v) for r, c, v in tot}

    counts = np.zeros((N, K), dtype=np.float32)
    totals = np.zeros(N, dtype=np.float32)
    pid = df["photo_id"].values
    hit = 0
    for i in range(N):
        rc = cell_by_photo.get(int(pid[i]))
        if rc is None:
            continue
        totals[i] = tot_by.get(rc, 0.0)
        for j in range(K):
            tid = app2tid.get(int(idxs[i, j]))
            if tid is None:
                continue
            v = cnt_by.get((rc[0], rc[1], tid))
            if v:
                counts[i, j] = v
                hit += 1
    print("candidate slots with a nonzero count:", hit, "/", N * K,
          "(" + str(round(100.0 * hit / (N * K), 1)) + "%)")
    print("median cell total:", float(np.median(totals)))
    np.savez_compressed(args.out, counts=counts, totals=totals)
    print("wrote", args.out)
    print("=== JOIN DONE ===")


if __name__ == "__main__":
    main()
