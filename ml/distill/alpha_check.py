#!/usr/bin/env python3
"""Is alpha=0 an artifact of small n, or a real finding?

Worry: 11,070 photos / 3,697 species might be too few to justify "never
rescue a zero-count species". Two checks:

1. SWEEP alpha over a wide grid and report held-out accuracy at each. If the
   curve is FLAT near zero, alpha barely matters and the fit landing on 0 is
   not a strong claim. If there is a real optimum at 0, it is a finding.
2. SUBSAMPLE: refit at 25%, 50%, 100% of the data. If fitted alpha drifts
   toward larger values as n grows, small-n is biasing it. If it is stable at
   ~0 across sizes, n is not the driver.
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

    cnt = np.load(args.counts)
    counts = torch.tensor(cnt["counts"], dtype=torch.float32)
    totals = torch.tensor(cnt["totals"], dtype=torch.float32)

    g = torch.Generator().manual_seed(args.seed)
    perm = torch.randperm(N, generator=g)
    ncut = int(N * 0.7)
    tr_all, va = perm[:ncut], perm[ncut:]

    def fit(tr_idx, alpha_fixed=None):
        logT = torch.tensor(math.log(0.0078), requires_grad=True)
        wfree = torch.zeros(3, requires_grad=True)
        logbeta = torch.tensor(math.log(0.5), requires_grad=True)
        params = [logT, wfree, logbeta]
        logalpha = None
        if alpha_fixed is None:
            logalpha = torch.tensor(math.log(1.0), requires_grad=True)
            params.append(logalpha)

        def sc(sel):
            w = torch.cat([torch.zeros(1), wfree])
            s = sims[sel] / logT.exp()
            wst = w[status[sel]]
            al = (torch.tensor(float(alpha_fixed)) if alpha_fixed is not None
                  else logalpha.exp())
            pri = torch.exp(wst)
            num = counts[sel] + al * pri
            den = totals[sel].unsqueeze(1) + al * pri.sum(dim=1, keepdim=True)
            lp = torch.log(num.clamp(min=1e-12)) - torch.log(den.clamp(min=1e-12))
            return s + wst + logbeta.exp() * lp

        opt = torch.optim.LBFGS(params, lr=0.05, max_iter=300,
                                tolerance_grad=1e-9, tolerance_change=1e-11)

        def closure():
            opt.zero_grad()
            lg = sc(tr_idx)
            tg = target[tr_idx]
            v = tg >= 0
            logp = F.log_softmax(lg, dim=-1)
            nll = -logp.gather(1, tg.clamp(min=0).unsqueeze(1)).squeeze(1)[v].mean()
            nll.backward()
            return nll

        opt.step(closure)
        with torch.no_grad():
            lg = sc(va)
            tg = target[va]
            acc = float((lg.argmax(dim=-1) == tg).float().sum()) / len(va)
        al = (alpha_fixed if alpha_fixed is not None
              else float(logalpha.exp()))
        return acc, al

    print("=== 1. ALPHA SWEEP (fixed alpha, refit everything else) ===")
    print("   alpha        held-out ABS top-1")
    for al in [0.0, 0.01, 0.1, 0.5, 1.0, 5.0, 20.0, 100.0, 1000.0]:
        acc, _ = fit(tr_all, alpha_fixed=al)
        print("   " + str(al).ljust(12) + str(round(100 * acc, 2)))

    print()
    print("=== 2. SUBSAMPLE: does fitted alpha drift with n? ===")
    print("   frac    n_train   fitted alpha    held-out ABS top-1")
    for frac in [0.25, 0.5, 1.0]:
        k = int(len(tr_all) * frac)
        acc, al = fit(tr_all[:k], alpha_fixed=None)
        print("   " + str(frac).ljust(8) + str(k).ljust(10) +
              str(round(al, 4)).ljust(16) + str(round(100 * acc, 2)))
    print()
    print("READ: if the sweep is flat near 0, alpha barely matters. If fitted")
    print("alpha grows with n, small-n was biasing it toward 0.")
    print("=== ALPHA CHECK DONE ===")


if __name__ == "__main__":
    main()
