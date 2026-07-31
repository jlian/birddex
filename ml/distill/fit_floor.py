#!/usr/bin/env python3
"""Fit the FLOOR for candidates absent from a cell.

The harness currently uses log(1e-9) ~ -20.7 for a candidate with no
occurrence record in the cell. That number was invented, never fitted, and it
does real work: it decides how hard an unobserved species is penalised. For
comparison the BirdLife w[out-of-range] FITTED to -3.86, so -20.7 is ~5x
harsher than anything we measured.

Sweeps the floor and refits T and beta at each value.
"""
import argparse
import json
import math

import numpy as np
import torch
import torch.nn.functional as F


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidates", required=True)
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

    z = np.load(args.counts)
    counts = torch.tensor(z["counts"], dtype=torch.float32)
    totals = torch.tensor(z["totals"], dtype=torch.float32)
    absent = (counts <= 0)
    print("candidate slots with NO occurrence record:",
          int(absent.sum()), "/", absent.numel(),
          "(" + str(round(100.0 * float(absent.float().mean()), 1)) + "%)")

    g = torch.Generator().manual_seed(args.seed)
    perm = torch.randperm(N, generator=g)
    ncut = int(N * 0.7)
    tr, va = perm[:ncut], perm[ncut:]
    tgt = target[va]
    nva = len(va)

    def run(floor):
        logT = torch.tensor(math.log(0.0078), requires_grad=True)
        logbeta = torch.tensor(math.log(1.0), requires_grad=True)

        def lp(sel):
            # present -> log(count/total); absent -> the floor under test
            p = counts[sel] / totals[sel].unsqueeze(1).clamp(min=1)
            v = torch.where(counts[sel] > 0, torch.log(p.clamp(min=1e-30)),
                            torch.full_like(p, floor))
            return v

        def sc(sel):
            return sims[sel] / logT.exp() + logbeta.exp() * lp(sel)

        opt = torch.optim.LBFGS([logT, logbeta], lr=0.05, max_iter=300,
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
            acc = float((sc(va).argmax(dim=-1) == tgt).float().sum()) / nva
        return acc, float(logT.exp()), float(logbeta.exp())

    print()
    print("=== FLOOR SWEEP (log-prob assigned to absent species) ===")
    print("  floor        ABS top-1      T        beta")
    best = None
    for fl in [-2.0, -4.0, -6.0, -8.0, -10.0, -14.0, -20.7, -30.0]:
        acc, T, b = run(fl)
        tag = "   <-- harness uses this" if abs(fl + 20.7) < 0.1 else ""
        print("  " + str(fl).rjust(6) + "      " + str(round(100 * acc, 2)).rjust(6) +
              "   " + str(round(T, 5)).rjust(8) + "   " + str(round(b, 3)).rjust(6) + tag)
        if best is None or acc > best[0]:
            best = (acc, fl, T, b)
    print()
    print("BEST floor = " + str(best[1]) + " at " + str(round(100 * best[0], 2)) +
          "  (T=" + str(round(best[2], 5)) + ", beta=" + str(round(best[3], 3)) + ")")
    print("=== FLOOR SWEEP DONE ===")


if __name__ == "__main__":
    main()
