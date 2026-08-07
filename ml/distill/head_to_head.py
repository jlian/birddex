#!/usr/bin/env python3
"""Head-to-head at n=11k: does Strategy F beat the Bayesian log-sum?

The 27-image golden set says F >= H. The 11k calibration set says the log-sum
adds +9.46 pts. Only one of those can be guiding us, so run F" + chr(39) + "s ACTUAL LOGIC
(dominance gate + hard range tiering) on the same 11k photos and compare like
for like.

F: if top1_conf - top2_conf >= domMargin, trust vision and keep raw order.
   Otherwise hard-partition by range tier, ranking by adjusted score within
   each tier.
H: score = sim/T + w[status], sort. No gate, no tiers.
"""
import argparse
import json

import numpy as np
import torch
import torch.nn.functional as F

STATUSES = ["present", "near-range", "no-data", "out-of-range"]
SIDX = {s: i for i, s in enumerate(STATUSES)}
TIER = {"present": 0, "near-range": 1, "no-data": 2, "out-of-range": 3}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidates", required=True)
    ap.add_argument("--status", required=True)
    ap.add_argument("--calib", required=True)
    ap.add_argument("--val-frac", type=float, default=0.3)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    import pandas as pd
    df = pd.read_parquet(args.candidates)
    cal = json.load(open(args.calib))
    T = cal["temperature"]
    w = torch.tensor([cal["w"][s] for s in STATUSES], dtype=torch.float32)

    st_by_photo = {}
    for line in open(args.status):
        if line.strip():
            r = json.loads(line)
            st_by_photo[int(r["photo_id"])] = r["status"]

    sims = torch.tensor(np.stack(df["cand_sim"].values), dtype=torch.float32)
    idxs = np.stack(df["cand_idx"].values)
    true = df["true_app_idx"].values
    N, K = idxs.shape
    pos = np.full(N, -1, dtype=np.int64)
    for i in range(N):
        hit = np.where(idxs[i] == true[i])[0]
        if len(hit):
            pos[i] = hit[0]
    target = torch.tensor(pos)

    stat = np.zeros((N, K), dtype=np.int64)
    tier = np.zeros((N, K), dtype=np.int64)
    pids = df["photo_id"].values
    for i in range(N):
        ss = st_by_photo.get(int(pids[i]))
        if ss is None:
            stat[i, :] = SIDX["no-data"]
            tier[i, :] = TIER["no-data"]
        else:
            for j, s in enumerate(ss[:K]):
                stat[i, j] = SIDX.get(s, SIDX["no-data"])
                tier[i, j] = TIER.get(s, 2)
    status = torch.tensor(stat)
    tiers = torch.tensor(tier)

    g = torch.Generator().manual_seed(args.seed)
    perm = torch.randperm(N, generator=g)
    va = perm[int(N * (1 - args.val_frac)):]
    tg = target[va]
    v = tg >= 0
    nv = int(v.sum())

    def topk_acc(order, k):
        """order: (n,K) indices sorted best-first."""
        hit = (order[:, :k] == tg.unsqueeze(1))
        return float(hit.any(dim=1)[v].float().mean())

    print("val photos:", nv)
    print()

    # --- raw vision only (shipped temperature) ---
    raw = sims[va] / 0.01
    o_raw = raw.argsort(dim=-1, descending=True)
    print("raw argmax (no geography):      top-1 " +
          str(round(100 * topk_acc(o_raw, 1), 2)) + "  top-5 " +
          str(round(100 * topk_acc(o_raw, 5), 2)))

    # --- Strategy F: dominance gate, else hard tier ---
    for dom in [0.5, 0.3, 0.7]:
        p = F.softmax(sims[va] / 0.01, dim=-1)
        sp = p.sort(dim=-1, descending=True)
        dominant = (sp.values[:, 0] - sp.values[:, 1]) >= dom
        # tiered order: sort by (tier, -score)
        key = tiers[va].float() * 1000.0 - p
        o_tier = key.argsort(dim=-1)
        o_f = torch.where(dominant.unsqueeze(1), o_raw, o_tier)
        print("F gated dom=" + str(dom) + " + tiering:    top-1 " +
              str(round(100 * topk_acc(o_f, 1), 2)) + "  top-5 " +
              str(round(100 * topk_acc(o_f, 5), 2)))

    # --- pure hard tiering, no gate (Strategy D) ---
    p = F.softmax(sims[va] / 0.01, dim=-1)
    key = tiers[va].float() * 1000.0 - p
    o_d = key.argsort(dim=-1)
    print("D hard tiering (no gate):       top-1 " +
          str(round(100 * topk_acc(o_d, 1), 2)) + "  top-5 " +
          str(round(100 * topk_acc(o_d, 5), 2)))

    # --- Strategy H: Bayesian log-sum ---
    hs = sims[va] / T + w[status[va]]
    o_h = hs.argsort(dim=-1, descending=True)
    print("H bayes log-sum (FITTED):       top-1 " +
          str(round(100 * topk_acc(o_h, 1), 2)) + "  top-5 " +
          str(round(100 * topk_acc(o_h, 5), 2)))

    print()
    print("1 pt = ~" + str(round(nv / 100.0, 1)) + " photos")
    print("=== HEAD TO HEAD DONE ===")


if __name__ == "__main__":
    main()
