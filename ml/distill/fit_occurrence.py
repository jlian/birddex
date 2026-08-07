#!/usr/bin/env python3
"""Strategy I: Bayesian log-sum with an EMPIRICAL P(species | cell).

    score = sim/T + beta * log P(species | cell)

where the prior is smoothed toward the BirdLife status weights:

    P(species|cell) = (count[sp,cell] + alpha * exp(w[status])) /
                      (total[cell]    + alpha * sum_exp_w)

H is the special case alpha -> infinity (counts ignored, only status matters),
so I strictly generalizes H. If fitted beta lands near 0, or I merely ties H,
then abundance adds nothing beyond presence/absence -- a real negative result
that saves shipping an extra data layer to clients.

Fits T, w[4], log-alpha and beta jointly by max-likelihood on the leak-free
calibration set, then reports top-1/top-5 on the SAME held-out split used for
the H comparison (3,140 photos, 1 pt = ~31 photos).
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
    ap.add_argument("--counts", required=True)
    ap.add_argument("--out", default="calibration_occ.json")
    ap.add_argument("--val-frac", type=float, default=0.3)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    import pandas as pd
    df = pd.read_parquet(args.candidates)
    N = len(df)
    sims = torch.tensor(np.stack(df["cand_sim"].values), dtype=torch.float32)
    idxs = np.stack(df["cand_idx"].values)
    true = df["true_app_idx"].values
    K = idxs.shape[1]

    pos = np.full(N, -1, dtype=np.int64)
    for i in range(N):
        hit = np.where(idxs[i] == true[i])[0]
        if len(hit):
            pos[i] = hit[0]
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

    cnt = np.load(args.counts)
    counts = torch.tensor(cnt["counts"], dtype=torch.float32)
    totals = torch.tensor(cnt["totals"], dtype=torch.float32)
    print("counts matrix:", tuple(counts.shape),
          " nonzero:", int((counts > 0).sum()))

    g = torch.Generator().manual_seed(args.seed)
    perm = torch.randperm(N, generator=g)
    ncut = int(N * (1 - args.val_frac))
    tr, va = perm[:ncut], perm[ncut:]

    logT = torch.tensor(math.log(0.007809), requires_grad=True)
    wfree = torch.tensor([-0.5726, 0.0, -3.8552], requires_grad=True)
    logalpha = torch.tensor(math.log(1.0), requires_grad=True)
    logbeta = torch.tensor(math.log(1.0), requires_grad=True)

    def score(sel, use_occ=True):
        w = torch.cat([torch.zeros(1), wfree])
        s = sims[sel] / logT.exp()
        wst = w[status[sel]]
        if not use_occ:
            return s + wst
        alpha = logalpha.exp()
        beta = logbeta.exp()
        # smooth counts toward exp(w[status]) as the pseudo-count prior
        pri = torch.exp(wst)
        num = counts[sel] + alpha * pri
        den = (totals[sel].unsqueeze(1) + alpha * pri.sum(dim=1, keepdim=True))
        logp = torch.log(num.clamp(min=1e-12)) - torch.log(den.clamp(min=1e-12))
        return s + beta * logp

    def report(tag, sel, use_occ):
        with torch.no_grad():
            lg = score(sel, use_occ)
            tg = target[sel]
            v = tg >= 0
            order = lg.argsort(dim=-1, descending=True)
            t1 = float((order[:, 0] == tg)[v].float().mean())
            t5 = float((order[:, :5] == tg.unsqueeze(1)).any(dim=1)[v].float().mean())
            logp = F.log_softmax(lg, dim=-1)
            nll = float(-logp.gather(1, tg.clamp(min=0).unsqueeze(1)).squeeze(1)[v].mean())
        print("  " + tag.ljust(34) + "top-1 " + str(round(100 * t1, 2)) +
              "  top-5 " + str(round(100 * t5, 2)) + "  NLL " + str(round(nll, 4)))
        return t1, t5

    print()
    print("=== BEFORE FITTING occurrence (H params) ===")
    h1, h5 = report("H bayes log-sum (status only)", va, False)

    opt = torch.optim.LBFGS([logT, wfree, logalpha, logbeta], lr=0.05,
                            max_iter=400, tolerance_grad=1e-9,
                            tolerance_change=1e-11)

    def closure():
        opt.zero_grad()
        lg = score(tr, True)
        tg = target[tr]
        v = tg >= 0
        logp = F.log_softmax(lg, dim=-1)
        nll = -logp.gather(1, tg.clamp(min=0).unsqueeze(1)).squeeze(1)[v].mean()
        nll.backward()
        return nll

    opt.step(closure)

    T = float(logT.exp())
    alpha = float(logalpha.exp())
    beta = float(logbeta.exp())
    w = torch.cat([torch.zeros(1), wfree]).detach()
    print()
    print("=== FITTED (Strategy I) ===")
    print("  T     = " + str(round(T, 6)))
    print("  alpha = " + str(round(alpha, 4)) + "   (pseudo-count strength)")
    print("  beta  = " + str(round(beta, 4)) + "   (weight on log P(species|cell))")
    for s in STATUSES:
        print("  w[" + s.ljust(13) + "] = " + str(round(float(w[SIDX[s]]), 4)))
    print()
    print("=== HELD-OUT (same split as the H comparison) ===")
    i1, i5 = report("I bayes + occurrence", va, True)
    print()
    print("=== VERDICT ===")
    d = 100 * (i1 - h1)
    print("  occurrence adds " + str(round(d, 2)) + " pts top-1 over status-only H")
    if beta < 0.05:
        print("  beta is ~0: abundance adds nothing beyond presence/absence")
    json.dump({"temperature": T, "alpha": alpha, "beta": beta,
               "w": {s: float(w[SIDX[s]]) for s in STATUSES},
               "val_top1_H": h1, "val_top5_H": h5,
               "val_top1_I": i1, "val_top5_I": i5},
              open(args.out, "w"), indent=2)
    print("wrote " + args.out)
    print("=== OCC FIT DONE ===")


if __name__ == "__main__":
    main()
