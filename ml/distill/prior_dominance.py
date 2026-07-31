#!/usr/bin/env python3
"""NEXT-5: the PRIOR-DOMINANCE THRESHOLD.

At what vision confidence does the geographic prior start DECIDING the answer
rather than merely nudging it? That single number drives two product
decisions:
  - below it, the honest wording is not "probably a crow" but "common here,
    and consistent with what I can see"
  - it marks where a life-list entry should be flagged as a guess

Method: rank every held-out photo TWICE -- with the prior and without -- and
bucket by VISION confidence (softmax of sim/T alone, which is what the client
can compute before applying geography). For each bucket report:
  - flip rate: how often the prior CHANGES the top-1
  - accuracy with and without the prior, so we see whether flipping helps
  - net benefit

A bucket where the prior flips most answers AND supplies most of the accuracy
is a bucket where the model is really reporting geography, not vision.
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

    logT = torch.tensor(math.log(0.0078), requires_grad=True)
    wfree = torch.zeros(3, requires_grad=True)
    logbeta = torch.tensor(math.log(0.5), requires_grad=True)

    def lp(sel):
        num = counts[sel] + 0.5
        den = totals[sel].unsqueeze(1) + 0.5 * K
        return torch.log(num) - torch.log(den)

    def full(sel):
        w = torch.cat([torch.zeros(1), wfree])
        return sims[sel] / logT.exp() + w[status[sel]] + logbeta.exp() * lp(sel)

    opt = torch.optim.LBFGS([logT, wfree, logbeta], lr=0.05, max_iter=400,
                            tolerance_grad=1e-9, tolerance_change=1e-11)

    def closure():
        opt.zero_grad()
        lg = full(tr)
        tg = target[tr]
        v = tg >= 0
        logp = F.log_softmax(lg, dim=-1)
        nll = -logp.gather(1, tg.clamp(min=0).unsqueeze(1)).squeeze(1)[v].mean()
        nll.backward()
        return nll

    opt.step(closure)
    T = float(logT.exp())
    print("fitted T=" + str(round(T, 6)) +
          "  beta=" + str(round(float(logbeta.exp()), 4)))

    with torch.no_grad():
        vis = sims[va] / T
        vis_conf = F.softmax(vis, dim=-1).max(dim=-1).values.numpy()
        pred_vis = vis.argmax(dim=-1)
        pred_full = full(va).argmax(dim=-1)
        tg = target[va]
        ok_vis = (pred_vis == tg).numpy()
        ok_full = (pred_full == tg).numpy()
        flipped = (pred_vis != pred_full).numpy()

    print()
    print("=== PRIOR DOMINANCE BY VISION CONFIDENCE ===")
    print("  vision conf      n     flip%   acc(vis)  acc(full)   net")
    edges = [0.0, 0.2, 0.4, 0.6, 0.8, 0.9, 0.95, 1.01]
    for i in range(len(edges) - 1):
        m = (vis_conf >= edges[i]) & (vis_conf < edges[i + 1])
        n = int(m.sum())
        if n == 0:
            continue
        fr = 100.0 * flipped[m].mean()
        av = 100.0 * ok_vis[m].mean()
        af = 100.0 * ok_full[m].mean()
        print("  " + (str(edges[i]) + "-" + str(min(edges[i + 1], 1.0))).ljust(14) +
              str(n).rjust(5) + "   " + str(round(fr, 1)).rjust(5) +
              "   " + str(round(av, 2)).rjust(7) + "   " + str(round(af, 2)).rjust(7) +
              "   " + str(round(af - av, 2)).rjust(6))

    print()
    print("=== WHERE DOES THE PRIOR SUPPLY MOST OF THE ANSWER? ===")
    for thr in [0.2, 0.4, 0.6, 0.8, 0.9]:
        m = vis_conf < thr
        n = int(m.sum())
        if n == 0:
            continue
        fr = 100.0 * flipped[m].mean()
        av = 100.0 * ok_vis[m].mean()
        af = 100.0 * ok_full[m].mean()
        print("  conf < " + str(thr) + ": n=" + str(n).rjust(5) +
              "  flip " + str(round(fr, 1)).rjust(5) + "%" +
              "  acc " + str(round(av, 1)) + " -> " + str(round(af, 1)) +
              "  (+" + str(round(af - av, 1)) + ")")
    print()
    print("READ: the threshold to use for the wording change is where flip% is")
    print("high AND the prior supplies most of the accuracy. Above it, vision")
    print("is deciding and " + chr(34) + "probably X" + chr(34) + " is honest.")
    print("=== DOMINANCE DONE ===")


if __name__ == "__main__":
    main()
