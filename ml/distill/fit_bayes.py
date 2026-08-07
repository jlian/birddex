#!/usr/bin/env python3
"""Step 3: jointly fit temperature T and the four BirdLife range log-priors.

    score(species) = sim/T + w[range_status]
                   = log P(image|species) + log P(species|location)

This is the Bayesian model that replaces the hand-rolled floor/tier/dominance
stack (Strategy A-G). Every parameter is FITTED on the leak-free calibration
set instead of hand-set:
  T                  was hardcoded 0.01   (fitted alone earlier: 0.0072)
  w[present]         was an implicit 1.0x multiplier
  w[near-range]      was 0.7x
  w[out-of-range]    was 0.25x (and 0.65x in the GPT-era pipeline)
  w[no-data]         was 1.0x

w[present] is PINNED to 0 as the reference level -- only differences between
statuses are identifiable, since a constant shift cancels inside softmax.

Reports top-1 on a held-out split for: raw argmax (no prior), temperature
only, and the full log-sum. That is the honest test of whether geography
helps at n=11k, where 4 points is ~440 photos rather than the 27-image set" + chr(39) + "s
one image.
"""
import argparse
import json
import math

import numpy as np
import torch
import torch.nn.functional as F

STATUSES = ["present", "near-range", "no-data", "out-of-range"]
SIDX = {s: i for i, s in enumerate(STATUSES)}


def ece(conf, correct, bins=15):
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
    ap.add_argument("--status", required=True)
    ap.add_argument("--out", default="calibration_bayes.json")
    ap.add_argument("--val-frac", type=float, default=0.3)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    import pandas as pd
    df = pd.read_parquet(args.candidates)
    st_by_photo = {}
    for line in open(args.status):
        if not line.strip():
            continue
        r = json.loads(line)
        st_by_photo[int(r["photo_id"])] = r["status"]
    print("rows:", len(df), "with status:", len(st_by_photo))

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
    pids = df["photo_id"].values
    for i in range(N):
        ss = st_by_photo.get(int(pids[i]))
        if ss is None:
            stat[i, :] = SIDX["no-data"]
        else:
            for j, s in enumerate(ss[:K]):
                stat[i, j] = SIDX.get(s, SIDX["no-data"])
    status = torch.tensor(stat)

    valid = target >= 0
    print("true species in top-K:", round(100 * float(valid.float().mean()), 2), "%")

    g = torch.Generator().manual_seed(args.seed)
    perm = torch.randperm(N, generator=g)
    ncut = int(N * (1 - args.val_frac))
    tr, va = perm[:ncut], perm[ncut:]

    def evaluate(T, w, sel):
        logits = sims[sel] / T
        if w is not None:
            logits = logits + w[status[sel]]
        tg = target[sel]
        v = tg >= 0
        pred = logits.argmax(dim=-1)
        acc = float((pred[v] == tg[v]).float().mean())
        logp = F.log_softmax(logits, dim=-1)
        nll = float(-logp.gather(1, tg.clamp(min=0).unsqueeze(1)).squeeze(1)[v].mean())
        p = F.softmax(logits, dim=-1)
        conf = p.max(dim=-1).values.detach().numpy()
        corr = (pred == tg).detach().numpy().astype(float)
        return acc, nll, ece(conf, corr)

    print()
    print("=== BASELINES (val split) ===")
    a0, n0, e0 = evaluate(0.01, None, va)
    print("  raw, T=0.01 (shipped):   top-1 " + str(round(100 * a0, 2)) +
          "  NLL " + str(round(n0, 4)) + "  ECE " + str(round(e0, 4)))
    a1, n1, e1 = evaluate(0.0072, None, va)
    print("  temperature only:        top-1 " + str(round(100 * a1, 2)) +
          "  NLL " + str(round(n1, 4)) + "  ECE " + str(round(e1, 4)))

    logT = torch.tensor(math.log(0.0072), requires_grad=True)
    wfree = torch.zeros(3, requires_grad=True)

    def full_w():
        return torch.cat([torch.zeros(1), wfree])

    opt = torch.optim.LBFGS([logT, wfree], lr=0.1, max_iter=300,
                            tolerance_grad=1e-9, tolerance_change=1e-11)

    def closure():
        opt.zero_grad()
        T = logT.exp()
        w = full_w()
        logits = sims[tr] / T + w[status[tr]]
        tg = target[tr]
        v = tg >= 0
        logp = F.log_softmax(logits, dim=-1)
        nll = -logp.gather(1, tg.clamp(min=0).unsqueeze(1)).squeeze(1)[v].mean()
        nll.backward()
        return nll

    opt.step(closure)
    T = float(logT.exp())
    w = full_w().detach()

    print()
    print("=== FITTED ===")
    print("  T = " + str(round(T, 6)))
    for s in STATUSES:
        print("  w[" + s.ljust(13) + "] = " + str(round(float(w[SIDX[s]]), 4)))
    a2, n2, e2 = evaluate(T, w, va)
    print("  log-sum (T + range):     top-1 " + str(round(100 * a2, 2)) +
          "  NLL " + str(round(n2, 4)) + "  ECE " + str(round(e2, 4)))

    print()
    print("=== VERDICT ===")
    d = 100 * (a2 - a1)
    print("  geography adds " + str(round(d, 2)) + " pts of top-1 over "
          "temperature alone")
    nv = int(valid[va].sum())
    print("  (val n=" + str(nv) + ", so 1 pt = ~" + str(round(nv / 100.0, 1)) +
          " photos)")
    json.dump({"temperature": T,
               "w": {s: float(w[SIDX[s]]) for s in STATUSES},
               "val_top1_raw": a0, "val_top1_temp": a1, "val_top1_logsum": a2,
               "val_nll_logsum": n2, "val_ece_logsum": e2,
               "val_n": nv},
              open(args.out, "w"), indent=2)
    print("wrote " + args.out)
    print("=== BAYES FIT DONE ===")


if __name__ == "__main__":
    main()
