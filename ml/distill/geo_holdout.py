#!/usr/bin/env python3
"""GEOGRAPHIC HOLDOUT: does the occurrence prior TRANSFER, or memorise iNat?

The worry: the prior is built from iNat observations and tested on iNat
photos. Not leakage (zero shared photos/observations, verified) but the prior
is unusually well matched to this distribution.

Test: split by CELL, not by photo. Fit the parameters on photos from one set
of cells, evaluate on photos from cells the fit never saw. The occurrence
COUNTS still come from the full corpus (that is fine and realistic -- at
inference the prior is always precomputed), but the fitted scalars must
generalise to unseen geography.

If held-out-by-cell performance ~= random-split performance, the prior
generalises. If it collapses, we are memorising region-specific structure.
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
    ap.add_argument("--cells", required=True)
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

    cellmap = {}
    for line in open(args.cells):
        if line.strip():
            r = json.loads(line)
            cellmap[int(r["photo_id"])] = (r["row"], r["col"])
    cellid = np.array([hash(cellmap.get(int(p), (-1, -1))) for p in pids])
    uniq = np.array(sorted(set(cellid.tolist())))
    rng = np.random.RandomState(args.seed)
    rng.shuffle(uniq)
    ncut = int(len(uniq) * 0.7)
    trcells = set(uniq[:ncut].tolist())
    tr = torch.tensor(np.where(np.isin(cellid, list(trcells)))[0])
    va = torch.tensor(np.where(~np.isin(cellid, list(trcells)))[0])
    print("distinct cells:", len(uniq), " train cells:", ncut)
    print("train photos:", len(tr), " val photos:", len(va))

    def fit_and_eval(use_bl, use_occ, tag, tr_idx, va_idx):
        logT = torch.tensor(math.log(0.0078), requires_grad=True)
        wfree = torch.zeros(3, requires_grad=True)
        logbeta = torch.tensor(math.log(0.5), requires_grad=True)
        params = [logT]
        if use_bl:
            params.append(wfree)
        if use_occ:
            params.append(logbeta)

        def sc(sel):
            s = sims[sel] / logT.exp()
            if use_bl:
                w = torch.cat([torch.zeros(1), wfree])
                s = s + w[status[sel]]
            if use_occ:
                num = counts[sel] + 0.5
                den = totals[sel].unsqueeze(1) + 0.5 * K
                s = s + logbeta.exp() * (torch.log(num) - torch.log(den))
            return s

        opt = torch.optim.LBFGS(params, lr=0.05, max_iter=400,
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
            lg = sc(va_idx)
            tg = target[va_idx]
            order = lg.argsort(dim=-1, descending=True)
            absacc = float((order[:, 0] == tg).float().sum()) / len(va_idx)
        print("  " + tag.ljust(30) + "ABS top-1 " + str(round(100 * absacc, 2)))
        return absacc

    print()
    print("=== HELD OUT BY CELL (unseen geography) ===")
    g1 = fit_and_eval(False, False, "1. vision only", tr, va)
    g2 = fit_and_eval(True, False, "2. + BirdLife", tr, va)
    g3 = fit_and_eval(False, True, "3. + occurrence only", tr, va)
    g4 = fit_and_eval(True, True, "4. + both", tr, va)

    print()
    print("=== RANDOM SPLIT (same sizes, for comparison) ===")
    g = torch.Generator().manual_seed(args.seed)
    perm = torch.randperm(N, generator=g)
    rtr = perm[:len(tr)]
    rva = perm[len(tr):len(tr) + len(va)]
    r1 = fit_and_eval(False, False, "1. vision only", rtr, rva)
    r3 = fit_and_eval(False, True, "3. + occurrence only", rtr, rva)
    r4 = fit_and_eval(True, True, "4. + both", rtr, rva)

    print()
    print("=== VERDICT ===")
    print("  occurrence gain, unseen cells: " + str(round(100 * (g3 - g1), 2)) + " pts")
    print("  occurrence gain, random split: " + str(round(100 * (r3 - r1), 2)) + " pts")
    drop = 100 * ((r3 - r1) - (g3 - g1))
    print("  transfer penalty: " + str(round(drop, 2)) + " pts")
    if abs(drop) < 2.0:
        print("  => the prior GENERALISES to unseen geography")
    else:
        print("  => WARNING: gain shrinks on unseen cells, partly region-specific")
    print("=== HOLDOUT DONE ===")


if __name__ == "__main__":
    main()
