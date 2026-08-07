#!/usr/bin/env python3
"""NEXT-1c: how coarse can the prior get, and what happens with no coverage?

Two ship-blocking questions, both answerable on the existing calibration set:

1. QUANTISATION. We plan to store a quantised log-probability per
   (species,cell). How few bits before top-1 degrades? Re-scores the held-out
   split at several bit depths and reports the accuracy drop.

2. COVERAGE GAP. The occurrence layer only covers 99,900 cells (vs BirdLife"'s
   681,023) because it only exists where someone photographed a bird. Splits
   the held-out photos by whether their cell HAS occurrence data and reports
   accuracy separately, so we know what a user in an uncovered area actually
   experiences.
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

    z = np.load(args.counts)
    counts = torch.tensor(z["counts"], dtype=torch.float32)
    totals = torch.tensor(z["totals"], dtype=torch.float32)

    g = torch.Generator().manual_seed(args.seed)
    perm = torch.randperm(N, generator=g)
    ncut = int(N * 0.7)
    tr, va = perm[:ncut], perm[ncut:]

    # fit once at full precision, then only quantise at eval time
    logT = torch.tensor(math.log(0.0078), requires_grad=True)
    wfree = torch.zeros(3, requires_grad=True)
    logbeta = torch.tensor(math.log(0.5), requires_grad=True)

    def logprior(sel):
        num = counts[sel] + 0.5
        den = totals[sel].unsqueeze(1) + 0.5 * K
        return torch.log(num) - torch.log(den)

    def sc(sel, lp):
        w = torch.cat([torch.zeros(1), wfree])
        return sims[sel] / logT.exp() + w[status[sel]] + logbeta.exp() * lp

    opt = torch.optim.LBFGS([logT, wfree, logbeta], lr=0.05, max_iter=400,
                            tolerance_grad=1e-9, tolerance_change=1e-11)

    def closure():
        opt.zero_grad()
        lg = sc(tr, logprior(tr))
        tg = target[tr]
        v = tg >= 0
        logp = F.log_softmax(lg, dim=-1)
        nll = -logp.gather(1, tg.clamp(min=0).unsqueeze(1)).squeeze(1)[v].mean()
        nll.backward()
        return nll

    opt.step(closure)
    tg = target[va]
    nva = len(va)

    def acc_of(lp):
        with torch.no_grad():
            lg = sc(va, lp)
            return float((lg.argmax(dim=-1) == tg).float().sum()) / nva

    lp_full = logprior(va).detach()
    base = acc_of(lp_full)
    print("=== 1. QUANTISATION OF log P(species|cell) ===")
    print("  full float32            ABS top-1 " + str(round(100 * base, 2)))
    lo = float(lp_full.min())
    hi = float(lp_full.max())
    print("  logprior range: " + str(round(lo, 2)) + " .. " + str(round(hi, 2)))
    for bits in [8, 6, 5, 4, 3, 2]:
        levels = 2 ** bits
        step = (hi - lo) / (levels - 1)
        q = torch.round((lp_full - lo) / step) * step + lo
        a2 = acc_of(q)
        print("  " + str(bits) + "-bit (" + str(levels).rjust(3) +
              " levels)      ABS top-1 " + str(round(100 * a2, 2)) +
              "   delta " + str(round(100 * (a2 - base), 2)))

    print()
    print("=== 2. COVERAGE GAP: cells WITH vs WITHOUT occurrence data ===")
    has = (totals[va] > 0)
    print("  val photos in covered cells   : " + str(int(has.sum())) +
          " (" + str(round(100.0 * float(has.float().mean()), 1)) + "%)")
    print("  val photos in UNcovered cells : " + str(int((~has).sum())))

    def acc_subset(mask, lp, tag):
        if int(mask.sum()) == 0:
            print("  " + tag.ljust(34) + "n=0")
            return
        with torch.no_grad():
            lg = sc(va, lp)
            ok = (lg.argmax(dim=-1) == tg).float()
        print("  " + tag.ljust(34) + "n=" + str(int(mask.sum())).rjust(5) +
              "  ABS top-1 " + str(round(100 * float(ok[mask].mean()), 2)))

    acc_subset(has, lp_full, "covered cells, with prior")
    acc_subset(~has, lp_full, "UNcovered cells, with prior")
    zero = torch.zeros_like(lp_full)
    acc_subset(has, zero, "covered cells, prior DISABLED")
    acc_subset(~has, zero, "UNcovered cells, prior DISABLED")
    print()
    print("READ: if uncovered-with-prior ~= uncovered-without, the smoothing")
    print("floor already handles the gap gracefully and no BirdLife fallback")
    print("is needed. If it is WORSE, an uncovered cell actively hurts and we")
    print("need a fallback path.")
    print("=== QUANT + COVERAGE DONE ===")


if __name__ == "__main__":
    main()
