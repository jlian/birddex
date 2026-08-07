#!/usr/bin/env python3
"""Evaluate the temporal holdout: pre-2024 prior vs full-corpus prior, on the
SAME 2025+ photos.

The comparison isolates the temporal effect. Both runs use identical photos,
identical candidates and identical fitting; only the occurrence COUNTS differ
(pre-2024 only vs the whole corpus). If the pre-2024 prior holds up, the
prior survives drift and a yearly refresh is enough.
"""
import argparse
import json
import math

import numpy as np
import torch
import torch.nn.functional as F

STATUSES = ["present", "near-range", "no-data", "out-of-range"]
SIDX = {s: i for i, s in enumerate(STATUSES)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidates", required=True)
    ap.add_argument("--status", required=True)
    ap.add_argument("--counts-full", required=True)
    ap.add_argument("--counts-pre", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--min-year", type=int, default=2025)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    import pandas as pd
    df = pd.read_parquet(args.candidates)
    man = pd.read_parquet(args.manifest)[["photo_id", "observed_on"]]
    df = df.merge(man, on="photo_id", how="left")
    yr = df["observed_on"].astype(str).str[:4]
    recent = (pd.to_numeric(yr, errors="coerce") >= args.min_year).values
    print("photos total:", len(df), " observed >=", args.min_year, ":",
          int(recent.sum()))

    N = len(df)
    sims = torch.tensor(np.stack(df["cand_sim"].values), dtype=torch.float32)
    idxs = np.stack(df["cand_idx"].values)
    true = df["true_app_idx"].values
    K = idxs.shape[1]
    pos = np.full(N, -1, dtype=np.int64)
    for i in range(N):
        h = np.where(idxs[i] == true[i])[0]
        if len(h):
            pos[i] = h[0]
    target = torch.tensor(pos)

    st_by = {}
    for line in open(args.status):
        if line.strip():
            r = json.loads(line)
            st_by[int(r["photo_id"])] = r["status"]
    pids = df["photo_id"].values
    stat = np.zeros((N, K), dtype=np.int64)
    for i in range(N):
        ss = st_by.get(int(pids[i]))
        if ss is None:
            stat[i, :] = SIDX["no-data"]
        else:
            for j, s in enumerate(ss[:K]):
                stat[i, j] = SIDX.get(s, SIDX["no-data"])
    status = torch.tensor(stat)

    def load(p):
        z = np.load(p)
        return (torch.tensor(z["counts"], dtype=torch.float32),
                torch.tensor(z["totals"], dtype=torch.float32))

    cfull, tfull = load(args.counts_full)
    cpre, tpre = load(args.counts_pre)
    print("full-corpus nonzero slots:", int((cfull > 0).sum()))
    print("pre-2024   nonzero slots:", int((cpre > 0).sum()))

    # train on OLD photos, evaluate on RECENT photos
    old_idx = torch.tensor(np.where(~recent)[0])
    new_idx = torch.tensor(np.where(recent)[0])

    def fit_eval(counts, totals, tag, use_occ=True):
        logT = torch.tensor(math.log(0.0078), requires_grad=True)
        wfree = torch.zeros(3, requires_grad=True)
        logbeta = torch.tensor(math.log(0.5), requires_grad=True)
        params = [logT, wfree] + ([logbeta] if use_occ else [])

        def sc(sel):
            w = torch.cat([torch.zeros(1), wfree])
            s = sims[sel] / logT.exp() + w[status[sel]]
            if use_occ:
                num = counts[sel] + 0.5
                den = totals[sel].unsqueeze(1) + 0.5 * K
                s = s + logbeta.exp() * (torch.log(num) - torch.log(den))
            return s

        opt = torch.optim.LBFGS(params, lr=0.05, max_iter=400,
                                tolerance_grad=1e-9, tolerance_change=1e-11)

        def closure():
            opt.zero_grad()
            lg = sc(old_idx)
            tg = target[old_idx]
            v = tg >= 0
            logp = F.log_softmax(lg, dim=-1)
            nll = -logp.gather(1, tg.clamp(min=0).unsqueeze(1)).squeeze(1)[v].mean()
            nll.backward()
            return nll

        opt.step(closure)
        with torch.no_grad():
            lg = sc(new_idx)
            tg = target[new_idx]
            acc = float((lg.argmax(dim=-1) == tg).float().sum()) / len(new_idx)
        print("  " + tag.ljust(38) + "ABS top-1 " + str(round(100 * acc, 2)))
        return acc

    print()
    print("=== TEMPORAL HOLDOUT ===")
    print("  fit on photos observed <" + str(args.min_year) +
          " (n=" + str(len(old_idx)) + "),")
    print("  evaluate on photos observed >=" + str(args.min_year) +
          " (n=" + str(len(new_idx)) + ")")
    print()
    b = fit_eval(cfull, tfull, "no occurrence (BirdLife only)", use_occ=False)
    f = fit_eval(cfull, tfull, "occurrence: FULL corpus")
    p = fit_eval(cpre, tpre, "occurrence: PRE-2024 only")
    print()
    print("=== VERDICT ===")
    print("  full-corpus prior gain:  " + str(round(100 * (f - b), 2)) + " pts")
    print("  pre-2024 prior gain:     " + str(round(100 * (p - b), 2)) + " pts")
    d = 100 * (f - p)
    print("  cost of a stale prior:   " + str(round(d, 2)) + " pts")
    if d < 1.5:
        print("  => the prior SURVIVES drift; a yearly refresh is plenty")
    else:
        print("  => WARNING: a stale prior costs real accuracy, refresh often")
    print("=== TEMPORAL DONE ===")


if __name__ == "__main__":
    main()
