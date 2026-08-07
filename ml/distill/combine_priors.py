#!/usr/bin/env python3
"""Does iNat + GBIF beat iNat alone as the occurrence prior?

GBIF alone landed ~4 pts below iNat, plausibly because eBird checklists are
systematic surveys and a worse match for casual phone photos. But union is not
averaging -- GBIF fills in where iNat is thin (museum specimens, national
atlases, places nobody phone-photographs), so it may extend coverage AND keep
iNat" + chr(39) + "s photo-behaviour signal where it exists.

Compares four priors on the SAME held-out split:
  1. iNat only            (current best)
  2. GBIF only
  3. NAIVE SUM            counts simply added
  4. WEIGHTED             separate fitted beta per source

Naive summing risks GBIF" + chr(39) + "s 2.16B records swamping iNat" + chr(39) + "s 157M in
well-covered cells, dragging the prior toward survey behaviour. The weighted
variant lets the fit decide the balance instead of letting record counts
decide it. Also reports COVERAGE, which is the other reason to care.
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
    ap.add_argument("--inat", required=True)
    ap.add_argument("--gbif", required=True)
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

    def load(p):
        z = np.load(p)
        return (torch.tensor(z["counts"], dtype=torch.float32),
                torch.tensor(z["totals"], dtype=torch.float32))

    ci, ti = load(args.inat)
    cg, tg_ = load(args.gbif)
    print("iNat nonzero slots:", int((ci > 0).sum()))
    print("GBIF nonzero slots:", int((cg > 0).sum()))
    both = ((ci > 0) | (cg > 0))
    print("union nonzero slots:", int(both.sum()),
          " (+" + str(round(100.0 * (int(both.sum()) - int((ci > 0).sum())) /
                            max(int((ci > 0).sum()), 1), 1)) + "% over iNat)")
    ci_cov = (ti > 0)
    cg_cov = (tg_ > 0)
    print("photos with iNat cell coverage:", int(ci_cov.sum()), "/", N)
    print("photos with GBIF cell coverage:", int(cg_cov.sum()), "/", N)
    print("photos with EITHER:", int((ci_cov | cg_cov).sum()), "/", N)

    g = torch.Generator().manual_seed(args.seed)
    perm = torch.randperm(N, generator=g)
    ncut = int(N * 0.7)
    tr, va = perm[:ncut], perm[ncut:]
    tgt = target[va]
    nva = len(va)

    def run(mode, tag):
        logT = torch.tensor(math.log(0.0078), requires_grad=True)
        wfree = torch.zeros(3, requires_grad=True)
        lb1 = torch.tensor(math.log(0.5), requires_grad=True)
        lb2 = torch.tensor(math.log(0.5), requires_grad=True)
        params = [logT, wfree, lb1]
        if mode == "weighted":
            params.append(lb2)

        def lp(c, t, sel):
            num = c[sel] + 0.5
            den = t[sel].unsqueeze(1) + 0.5 * K
            return torch.log(num) - torch.log(den)

        def sc(sel):
            w = torch.cat([torch.zeros(1), wfree])
            base = sims[sel] / logT.exp() + w[status[sel]]
            if mode == "inat":
                return base + lb1.exp() * lp(ci, ti, sel)
            if mode == "gbif":
                return base + lb1.exp() * lp(cg, tg_, sel)
            if mode == "sum":
                return base + lb1.exp() * lp(ci + cg, ti + tg_, sel)
            return (base + lb1.exp() * lp(ci, ti, sel) +
                    lb2.exp() * lp(cg, tg_, sel))

        opt = torch.optim.LBFGS(params, lr=0.05, max_iter=400,
                                tolerance_grad=1e-9, tolerance_change=1e-11)

        def closure():
            opt.zero_grad()
            lg = sc(tr)
            t2 = target[tr]
            v = t2 >= 0
            logp = F.log_softmax(lg, dim=-1)
            nll = -logp.gather(1, t2.clamp(min=0).unsqueeze(1)).squeeze(1)[v].mean()
            nll.backward()
            return nll

        opt.step(closure)
        with torch.no_grad():
            lg = sc(va)
            acc = float((lg.argmax(dim=-1) == tgt).float().sum()) / nva
        ex = "  beta=" + str(round(float(lb1.exp()), 3))
        if mode == "weighted":
            ex += "  beta_gbif=" + str(round(float(lb2.exp()), 3))
        print("  " + tag.ljust(28) + "ABS top-1 " + str(round(100 * acc, 2)) + ex)
        return acc

    print()
    print("=== PRIOR SOURCE COMPARISON (abs top-1, n=" + str(nva) + ") ===")
    a1 = run("inat", "1. iNat only")
    a2 = run("gbif", "2. GBIF only")
    a3 = run("sum", "3. NAIVE SUM")
    a4 = run("weighted", "4. WEIGHTED (2 betas)")
    print()
    print("=== VERDICT ===")
    print("  naive sum vs iNat:  " + str(round(100 * (a3 - a1), 2)) + " pts")
    print("  weighted vs iNat:   " + str(round(100 * (a4 - a1), 2)) + " pts")
    best = max([(a1, "iNat only"), (a3, "naive sum"), (a4, "weighted")])
    print("  WINNER: " + best[1] + " at " + str(round(100 * best[0], 2)))
    print("=== COMBINE DONE ===")


if __name__ == "__main__":
    main()
