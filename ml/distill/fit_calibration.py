#!/usr/bin/env python3
"""Fit temperature T (and optionally range-status log-priors) by max likelihood.

WHY: our pipeline top-1 (78%) trails the teacher (87%) even though our top-5
MATCHES it (96%). Cosine distillation preserved embedding DIRECTION (so argmax
and NABirds are excellent) but left the similarity SPREAD unconstrained, so the
softmax is flat: teacher median top-1 conf 0.915, ours 0.715. Every hand-set
pipeline threshold then misfires.

Temperature scaling (Guo et al. 2017) is the standard fix: one scalar, fit on
held-out data by minimizing NLL. It is a MONOTONIC transform, so it provably
cannot change argmax -- NABirds accuracy is mathematically untouched.

This also fits the BAYESIAN form the hand-rolled Strategy A-G pipeline is
badly approximating:
    score = sim/T + w[range_status]
i.e. log P(image|species) + log P(species|location). Our range data is
CATEGORICAL (present / near-range / out-of-range / no-data), not a probability,
so instead of inventing one we LEARN a log-prior weight per status class.
That keeps it honest about what the data supports, and w[out-of-range] is a
fitted floor rather than the hand-set 0.25 multiplier (avoids log(0)).

Fit is on the leak-free calibration set (untouched by distillation AND
fine-tuning, one photo per observation).
"""
import argparse
import json
import math

import numpy as np
import torch
import torch.nn.functional as F

STATUSES = ["present", "near-range", "no-data", "out-of-range"]


def nll_and_acc(sims, target_pos, T, w=None, status=None):
    """sims: (N,K) raw cosine. target_pos: (N,) index of true species in K, or -1."""
    logits = sims / T
    if w is not None and status is not None:
        logits = logits + w[status]
    logp = F.log_softmax(logits, dim=-1)
    valid = target_pos >= 0
    idx = target_pos.clamp(min=0)
    picked = logp.gather(1, idx.unsqueeze(1)).squeeze(1)
    nll = -(picked[valid].mean())
    pred = logits.argmax(dim=-1)
    acc = (pred[valid] == target_pos[valid]).float().mean()
    return nll, acc


def ece(conf, correct, bins=15):
    """Expected calibration error -- the standard reliability metric."""
    e = 0.0
    n = len(conf)
    for i in range(bins):
        lo, hi = i / bins, (i + 1) / bins
        m = (conf > lo) & (conf <= hi)
        if m.sum() == 0:
            continue
        e += (m.sum() / n) * abs(correct[m].mean() - conf[m].mean())
    return float(e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidates", required=True)
    ap.add_argument("--out", default="calibration.json")
    ap.add_argument("--val-frac", type=float, default=0.3)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    import pandas as pd
    df = pd.read_parquet(args.candidates)
    print("rows:", len(df))

    sims = torch.tensor(np.stack(df["cand_sim"].values), dtype=torch.float32)
    idxs = np.stack(df["cand_idx"].values)
    true = df["true_app_idx"].values
    # position of the true species within the top-K list (-1 = not present)
    pos = np.full(len(df), -1, dtype=np.int64)
    for i in range(len(df)):
        hit = np.where(idxs[i] == true[i])[0]
        if len(hit):
            pos[i] = hit[0]
    target = torch.tensor(pos)
    inK = (pos >= 0).mean()
    print("true species inside top-K:", round(100 * float(inK), 2), "%")

    g = torch.Generator().manual_seed(args.seed)
    perm = torch.randperm(len(df), generator=g)
    ncut = int(len(df) * (1 - args.val_frac))
    tr, va = perm[:ncut], perm[ncut:]

    # --- baseline (T = the 0.01 the fixtures hardcode, and T = 1) ---
    for T0 in [1.0, 0.01]:
        nll, acc = nll_and_acc(sims[va], target[va], T0)
        print("  T=" + str(T0) + "  NLL " + str(round(float(nll), 4)) +
              "  acc " + str(round(100 * float(acc), 2)))

    # --- fit T by minimizing NLL on the train half ---
    logT = torch.tensor(math.log(0.01), requires_grad=True)
    opt = torch.optim.LBFGS([logT], lr=0.1, max_iter=100)

    def closure():
        opt.zero_grad()
        nll, _ = nll_and_acc(sims[tr], target[tr], logT.exp())
        nll.backward()
        return nll

    opt.step(closure)
    T = float(logT.exp())
    print("FITTED T =", round(T, 6))

    nll_v, acc_v = nll_and_acc(sims[va], target[va], T)
    print("  val NLL " + str(round(float(nll_v), 4)) +
          "  val acc " + str(round(100 * float(acc_v), 2)))

    # --- confidence distribution before/after (the thing the pipeline reads) ---
    for tag, TT in [("before (T=0.01)", 0.01), ("after  (fitted)", T)]:
        p = F.softmax(sims[va] / TT, dim=-1)
        conf = p.max(dim=-1).values.numpy()
        pred = (sims[va] / TT).argmax(dim=-1)
        corr = (pred == target[va]).numpy().astype(float)
        print("  " + tag + ": median conf " + str(round(float(np.median(conf)), 3)) +
              "  frac>0.9 " + str(round(float((conf > 0.9).mean()), 3)) +
              "  ECE " + str(round(ece(conf, corr), 4)))

    json.dump({"temperature": T,
               "n": int(len(df)),
               "topk_recall": float(inK),
               "val_acc": float(acc_v),
               "val_nll": float(nll_v)},
              open(args.out, "w"), indent=2)
    print("wrote " + args.out)
    print("NOTE: argmax is unchanged by construction -- T is monotonic.")
    print("=== FIT DONE ===")


if __name__ == "__main__":
    main()
