#!/usr/bin/env python3
"""Ablation: is BirdLife redundant once iNat occurrence counts exist?

alpha fitted to 0.0 in Strategy I, meaning BirdLife was rejected as a
SMOOTHING pseudo-count. That is NOT the same as BirdLife being useless -- it
still enters via w[status], and w[out-of-range] fitted to -8.98.

Fits four variants on the same split so the question is answered directly:
  1. vision only
  2. + BirdLife status weights          (= Strategy H)
  3. + iNat occurrence only, NO BirdLife
  4. + both                             (= Strategy I)

If (3) ~= (4), BirdLife adds nothing once counts exist. If (3) < (4),
BirdLife is contributing and alpha=0 only rejected its smoothing role.
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
    ncut = int(N * (1 - args.val_frac))
    tr, va = perm[:ncut], perm[ncut:]
    nva = len(va)

    def run(use_bl, use_occ, tag):
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
            lg = sc(tr)
            tg = target[tr]
            v = tg >= 0
            logp = F.log_softmax(lg, dim=-1)
            nll = -logp.gather(1, tg.clamp(min=0).unsqueeze(1)).squeeze(1)[v].mean()
            nll.backward()
            return nll

        opt.step(closure)
        with torch.no_grad():
            lg = sc(va)
            tg = target[va]
            v = tg >= 0
            order = lg.argsort(dim=-1, descending=True)
            cond = float((order[:, 0] == tg)[v].float().mean())
            absacc = float((order[:, 0] == tg).float().sum()) / nva
        extra = ""
        if use_occ:
            extra = "  beta=" + str(round(float(logbeta.exp()), 3))
        if use_bl:
            w = torch.cat([torch.zeros(1), wfree]).detach()
            extra += "  w[oor]=" + str(round(float(w[3]), 2))
        print("  " + tag.ljust(30) + "cond " + str(round(100 * cond, 2)) +
              "  ABS " + str(round(100 * absacc, 2)) + extra)
        return absacc

    print("val photos:", nva, " (1 pt = " + str(round(nva / 100.0, 1)) + " photos)")
    print()
    print("=== ABLATION (absolute top-1 over ALL val photos) ===")
    a1 = run(False, False, "1. vision only")
    a2 = run(True, False, "2. + BirdLife (= H)")
    a3 = run(False, True, "3. + iNat occurrence ONLY")
    a4 = run(True, True, "4. + both (= I)")
    print()
    print("=== VERDICT ===")
    print("  BirdLife alone adds:      " + str(round(100 * (a2 - a1), 2)) + " pts")
    print("  occurrence alone adds:    " + str(round(100 * (a3 - a1), 2)) + " pts")
    print("  BirdLife ON TOP of occ:   " + str(round(100 * (a4 - a3), 2)) + " pts")
    print("  occurrence ON TOP of BL:  " + str(round(100 * (a4 - a2), 2)) + " pts")
    if (a4 - a3) < 0.005:
        print("  => BirdLife is REDUNDANT once occurrence counts exist")
    else:
        print("  => BirdLife still contributes beyond occurrence")
    print("=== ABLATION DONE ===")


if __name__ == "__main__":
    main()
