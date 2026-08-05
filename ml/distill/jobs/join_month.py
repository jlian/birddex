"""G16: join monthly counts to calibration candidates, with backoff.

Produces the counts matrix the fit consumes, but shrunk toward the pooled prior:

    n_eff[sp, cell, month] = n_scm + k * (n_sc / n_c) * n_cm_scale

Concretely the client will compute

    P(sp | cell, month) = (n_scm + k * P_pooled(sp | cell)) / (n_cm + k)

so this emits both the monthly numerator and the pooled probability, letting
the fit sweep k without another DuckDB pass.

k is in units of observations. k = 0 is a pure monthly split. Large k reproduces
the pooled prior exactly, which means the sweep BRACKETS the current shipping
behaviour and cannot score worse than it at the optimum.
"""
import argparse

import duckdb
import numpy as np
import pandas as pd


def log(m):
    print(m, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidates", required=True)
    ap.add_argument("--month-counts", default="occurrence_month.parquet")
    ap.add_argument("--month-totals", default="occurrence_month_totals.parquet")
    ap.add_argument("--pooled-counts", default="occurrence_cells.parquet")
    ap.add_argument("--pooled-totals", default="occurrence_totals.parquet")
    ap.add_argument("--target-taxa", default="target_taxa.csv")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    df = pd.read_parquet(args.candidates)
    N = len(df)
    idxs = np.stack(df["cand_idx"].values)
    K = idxs.shape[1]
    log("candidates: %d photos x %d" % (N, K))

    if "month" in df.columns:
        months = df["month"].values.astype(np.int64)
    else:
        raise SystemExit("candidate parquet has no month column")
    log("months present: %s" % sorted(set(months.tolist())))

    tt = pd.read_csv(args.target_taxa)
    # Name the columns explicitly. Positional guessing picked up "common"
    # (a species name) as the taxon id and blew up on 'Killdeer'.
    col = "app_idx"
    tax_col = "inat_taxon_id"
    for c in (col, tax_col):
        if c not in tt.columns:
            raise SystemExit("target_taxa.csv missing column " + c)
    idx_to_taxon = dict(zip(tt[col].values, tt[tax_col].values))

    con = duckdb.connect()
    con.execute("CREATE TABLE occm AS SELECT * FROM read_parquet(?)", [args.month_counts])
    con.execute("CREATE TABLE totm AS SELECT * FROM read_parquet(?)", [args.month_totals])
    con.execute("CREATE TABLE occ  AS SELECT * FROM read_parquet(?)", [args.pooled_counts])
    con.execute("CREATE TABLE tot  AS SELECT * FROM read_parquet(?)", [args.pooled_totals])

    # Photo cells come from the candidate parquet, which already carries them.
    # The candidate parquet carries lat/lon but not the grid cell, so project
    # here with the SAME Equal Earth math the blob was built with. Getting this
    # wrong mis-keys every lookup silently, which is why it is not reimplemented
    # by hand: the constants come from range-adjust.js.
    ORIGIN_X, ORIGIN_Y, CELL = -17226000.0, 8343000.0, 27000.0
    A1, A2, A3, A4 = 1.340264, -0.081106, 0.000893, 0.003796
    a = 6378137.0
    f = 1.0 / 298.257223563
    b = a * (1 - f)
    e2 = 1 - (b * b) / (a * a)
    e = np.sqrt(e2)
    qp = 1 + ((1 - e2) / (2 * e)) * np.log((1 + e) / (1 - e))
    R = a * np.sqrt(0.5 * qp)

    lat = df["latitude"].values.astype(np.float64)
    lon = df["longitude"].values.astype(np.float64)
    phi = np.radians(lat)
    lam = np.radians(lon)
    sp = np.sin(phi)
    q = (1 - e2) * (sp / (1 - e2 * sp * sp)
                    - (1 / (2 * e)) * np.log((1 - e * sp) / (1 + e * sp)))
    beta_ = np.arcsin(np.clip(q / qp, -1, 1))
    th = np.arcsin(np.clip((np.sqrt(3) / 2) * np.sin(beta_), -1, 1))
    t2 = th * th
    t6 = t2 * t2 * t2
    den = 3 * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2))
    xx = R * ((2 * np.sqrt(3) * lam * np.cos(th)) / den)
    yy = R * th * (A1 + A2 * t2 + t6 * (A3 + A4 * t2))
    rows = np.floor((ORIGIN_Y - yy) / CELL).astype(np.int64)
    cols = np.floor((xx - ORIGIN_X) / CELL).astype(np.int64)
    log("projected cells: row %d..%d col %d..%d"
        % (rows.min(), rows.max(), cols.min(), cols.max()))

    n_scm = np.zeros((N, K), dtype=np.float32)   # monthly count for the candidate
    n_sc = np.zeros((N, K), dtype=np.float32)    # pooled count for the candidate
    n_cm = np.zeros(N, dtype=np.float32)         # cell-month total
    n_c = np.zeros(N, dtype=np.float32)          # cell pooled total

    want = []
    for i in range(N):
        for j in range(K):
            t = idx_to_taxon.get(int(idxs[i, j]))
            if t is not None:
                want.append((i, j, int(rows[i]), int(cols[i]), int(months[i]), int(t)))
    w = pd.DataFrame(want, columns=["i", "j", "row", "col", "mon", "taxon_id"])
    log("lookups: %d" % len(w))
    con.execute("CREATE TABLE w AS SELECT * FROM w")

    q1 = """
    SELECT w.i, w.j, COALESCE(o.n, 0) AS n
    FROM w LEFT JOIN occm o
      ON o.row = w.row AND o.col = w.col AND o.mon = w.mon AND o.taxon_id = w.taxon_id
    """
    for i, j, n in con.execute(q1).fetchall():
        n_scm[i, j] = n

    q2 = """
    SELECT w.i, w.j, COALESCE(o.n, 0) AS n
    FROM w LEFT JOIN occ o
      ON o.row = w.row AND o.col = w.col AND o.taxon_id = w.taxon_id
    """
    for i, j, n in con.execute(q2).fetchall():
        n_sc[i, j] = n

    cell = pd.DataFrame({"i": np.arange(N), "row": rows, "col": cols, "mon": months})
    con.execute("CREATE TABLE c AS SELECT * FROM cell")
    for i, t in con.execute(
        "SELECT c.i, COALESCE(t.total,0) FROM c LEFT JOIN totm t "
        "ON t.row=c.row AND t.col=c.col AND t.mon=c.mon").fetchall():
        n_cm[i] = t
    for i, t in con.execute(
        "SELECT c.i, COALESCE(t.total,0) FROM c LEFT JOIN tot t "
        "ON t.row=c.row AND t.col=c.col").fetchall():
        n_c[i] = t

    np.savez_compressed(args.out, n_scm=n_scm, n_sc=n_sc, n_cm=n_cm, n_c=n_c,
                        months=months)
    log("wrote %s" % args.out)
    log("  monthly count nonzero:  %.1f%% of slots"
        % (100.0 * (n_scm > 0).mean()))
    log("  pooled count nonzero:   %.1f%% of slots"
        % (100.0 * (n_sc > 0).mean()))
    log("  photos whose cell-month has zero data: %d of %d"
        % (int((n_cm == 0).sum()), N))


if __name__ == "__main__":
    main()
