"""What does --min-count buy, and what does it cost?

min-count drops (species, cell, month) entries with fewer than N observations.
Those species then fall back to the absence floor client-side, so it trades
accuracy for blob size.

That tail is large: 50.1% of pooled pairs have exactly one observation, and the
month split makes it worse. So pruning it is the obvious size lever, but the
same tail is where RARE species live, and rare species are exactly what a
geographic prior is supposed to help rank.

For each threshold this reports blob size AND the resulting absolute top-1 on
the calibration validation split, so the tradeoff is measured rather than
assumed. Accuracy is evaluated by rebuilding the counts matrix with the same
threshold applied, which is what the client would actually see.
"""
import argparse
import math
import os
import subprocess

import numpy as np
import pandas as pd
import torch


def log(m):
    print(m, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidates", required=True)
    ap.add_argument("--month-npz", required=True)
    ap.add_argument("--occurrence", default="occurrence_month.parquet")
    ap.add_argument("--target-taxa", default="target_taxa.csv")
    ap.add_argument("--taxonomy", default="../../src/lib/taxonomy.json")
    ap.add_argument("--builder", default="jobs/build_prior_blob_month.py")
    ap.add_argument("--thresholds", default="1,2,3,5,10")
    args = ap.parse_args()

    df = pd.read_parquet(args.candidates)
    N = len(df)
    sims = torch.tensor(np.stack(df["cand_sim"].values), dtype=torch.float32)
    idxs = np.stack(df["cand_idx"].values)
    true = df["true_app_idx"].values
    pos = np.full(N, -1, dtype=np.int64)
    for i in range(N):
        hit = np.where(idxs[i] == true[i])[0]
        if len(hit):
            pos[i] = hit[0]
    target = torch.tensor(pos)

    z = np.load(args.month_npz)
    n_scm_full = torch.tensor(z["n_scm"], dtype=torch.float32)
    n_cm = torch.tensor(z["n_cm"], dtype=torch.float32)

    g = torch.Generator().manual_seed(0)
    perm = torch.randperm(N, generator=g)
    va = perm[int(N * 0.7):]
    FLOOR = math.log(1e-9)

    def acc_at(minc, T, beta):
        # Applying the threshold to the candidate counts reproduces exactly what
        # the client sees: pruned entries are absent from the blob and hit the
        # floor.
        n = n_scm_full.clone()
        n[n < minc] = 0.0
        p = n[va] / n_cm[va].clamp(min=1e-6).unsqueeze(1)
        lp = torch.logaddexp(torch.log(p.clamp(min=1e-30)), torch.tensor(FLOOR))
        score = sims[va] / T + beta * lp
        tg = target[va]
        order = score.argsort(dim=-1, descending=True)
        return float(((order[:, 0] == tg) & (tg >= 0)).float().mean())

    T, beta = 0.007545, 0.5435
    log("")
    log("%-12s %12s %12s %10s" % ("min-count", "gzip MiB", "ABS top-1", "delta"))
    log("-" * 50)
    base = None
    for t in [int(x) for x in args.thresholds.split(",")]:
        out = "/tmp/occ-v3-min%d.bin.gz" % t
        subprocess.run(
            ["./.venv/bin/python", args.builder,
             "--occurrence", args.occurrence,
             "--target-taxa", args.target_taxa,
             "--taxonomy", args.taxonomy,
             "--out", out, "--min-count", str(t)],
            capture_output=True, text=True)
        mb = os.path.getsize(out) / 1048576 if os.path.exists(out) else float("nan")
        a = acc_at(t, T, beta)
        if base is None:
            base = a
        log("%-12d %11.2f %11.2f%% %+9.2f" % (t, mb, 100 * a, 100 * (a - base)))

    log("")
    log("Every pruned entry falls back to the absence floor, so the accuracy")
    log("column is what the CLIENT would score, not an upper bound.")


if __name__ == "__main__":
    main()
