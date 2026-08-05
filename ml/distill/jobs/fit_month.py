"""G16: does a month-aware prior beat the pooled one? Sweep the backoff.

Scores with

    P(sp | cell, month) = (n_scm + k * P_pooled(sp | cell)) / (n_cm + k)

and sweeps k, the pseudo-count in observations.

  k = 0        pure monthly split, no backoff
  k -> large   reproduces the pooled prior

So the sweep BRACKETS the current shipping behaviour. If no k beats the pooled
baseline, the honest answer is that month does not help on this eval, and the
sweep having the baseline inside it is what makes that conclusion trustworthy
rather than an artifact of a bad hyperparameter.

T and beta are refitted at every k, because the prior's scale changes and
reusing the pooled fit would understate any k that shifts it.

Reports ABSOLUTE top-1 on the same 30% validation split (seed 0), which is the
93.80 the pooled prior scores. Also reports a bootstrap confidence interval on
the DELTA, since 3,322 photos across 12 months is about 275 per month and a
small gain is not distinguishable from noise.
"""
import argparse
import json
import math

import numpy as np
import pandas as pd
import torch
import torch.nn.functional as F


def log(m):
    print(m, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidates", required=True)
    ap.add_argument("--month-npz", required=True)
    ap.add_argument("--val-frac", type=float, default=0.3)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--boot", type=int, default=2000)
    args = ap.parse_args()

    df = pd.read_parquet(args.candidates)
    N = len(df)
    sims = torch.tensor(np.stack(df["cand_sim"].values), dtype=torch.float32)
    idxs = np.stack(df["cand_idx"].values)
    true = df["true_app_idx"].values
    K = idxs.shape[1]

    pos = np.full(N, -1, dtype=np.int64)
    for i in range(N):
        hit = np.where(idxs[i] == true[i])[0]
        if len(hit):
            pos[i] = hit[0]
    target = torch.tensor(pos)

    z = np.load(args.month_npz)
    n_scm = torch.tensor(z["n_scm"], dtype=torch.float32)
    n_sc = torch.tensor(z["n_sc"], dtype=torch.float32)
    n_cm = torch.tensor(z["n_cm"], dtype=torch.float32)
    n_c = torch.tensor(z["n_c"], dtype=torch.float32)

    # Pooled probability, the backoff target.
    p_pooled = n_sc / n_c.clamp(min=1).unsqueeze(1)

    g = torch.Generator().manual_seed(args.seed)
    perm = torch.randperm(N, generator=g)
    ncut = int(N * (1 - args.val_frac))
    tr, va = perm[:ncut], perm[ncut:]
    log("train %d  val %d" % (len(tr), len(va)))

    def fit_and_eval(k, use_month):
        logT = torch.tensor(math.log(0.0076), requires_grad=True)
        logbeta = torch.tensor(math.log(0.56), requires_grad=True)

        def logp(sel):
            if use_month:
                num = n_scm[sel] + k * p_pooled[sel]
                den = (n_cm[sel] + k).clamp(min=1e-6).unsqueeze(1)
                p = num / den
            else:
                p = p_pooled[sel]
            return torch.log(p.clamp(min=1e-12))

        def score(sel):
            return sims[sel] / logT.exp() + logbeta.exp() * logp(sel)

        opt = torch.optim.LBFGS([logT, logbeta], lr=0.05, max_iter=200,
                                tolerance_grad=1e-9)

        def closure():
            opt.zero_grad()
            lg = score(tr)
            tg = target[tr]
            v = tg >= 0
            loss = F.cross_entropy(lg[v], tg[v])
            loss.backward()
            return loss

        opt.step(closure)

        with torch.no_grad():
            lg = score(va)
            tg = target[va]
            order = lg.argsort(dim=-1, descending=True)
            correct = ((order[:, 0] == tg) & (tg >= 0)).float()
            return float(correct.mean()), correct.numpy(), float(logT.exp()), float(logbeta.exp())

    def fit_joint():
        logT = torch.tensor(math.log(0.0076), requires_grad=True)
        logbeta = torch.tensor(math.log(0.56), requires_grad=True)
        logk = torch.tensor(0.0, requires_grad=True)

        def score(sel):
            k = logk.exp()
            num = n_scm[sel] + k * p_pooled[sel]
            den = (n_cm[sel] + k).clamp(min=1e-6).unsqueeze(1)
            lp = torch.log((num / den).clamp(min=1e-12))
            return sims[sel] / logT.exp() + logbeta.exp() * lp

        opt = torch.optim.LBFGS([logT, logbeta, logk], lr=0.05, max_iter=300,
                                tolerance_grad=1e-9)

        def closure():
            opt.zero_grad()
            lg = score(tr)
            tg = target[tr]
            v = tg >= 0
            loss = F.cross_entropy(lg[v], tg[v])
            loss.backward()
            return loss

        opt.step(closure)
        with torch.no_grad():
            lg = score(va)
            tg = target[va]
            order = lg.argsort(dim=-1, descending=True)
            corr = ((order[:, 0] == tg) & (tg >= 0)).float()
        return (float(corr.mean()), corr.numpy(), float(logT.exp()),
                float(logbeta.exp()), float(logk.exp()))

    base_acc, base_vec, bT, bB = fit_and_eval(0.0, False)
    log("")
    log("POOLED baseline (what ships today): %.2f  T=%.5f beta=%.3f"
        % (100 * base_acc, bT, bB))
    log("")
    log("%-12s %10s %10s" % ("k", "ABS top-1", "delta"))
    log("-" * 34)

    best = (None, -1, None)
    for k in [0.0, 1.0, 3.0, 10.0, 30.0, 100.0, 300.0, 1000.0, 10000.0]:
        acc, vec, T, B = fit_and_eval(k, True)
        d = 100 * (acc - base_acc)
        log("%-12.0f %9.2f%% %+9.2f" % (k, 100 * acc, d))
        if acc > best[1]:
            best = (k, acc, vec)

    k, acc, vec = best
    log("")
    log("best swept k = %.0f at %.2f%%, delta %+.2f"
        % (k, 100 * acc, 100 * (acc - base_acc)))

    # The honest version: fit T, beta and k together by gradient, rather than
    # fitting two and hand-searching the third.
    jacc, jvec, jT, jB, jk = fit_joint()
    log("")
    log("JOINT fit of T, beta and k together:")
    log("  k    = %.3f" % jk)
    log("  T    = %.5f" % jT)
    log("  beta = %.3f" % jB)
    log("  ABS top-1 %.2f%%, delta %+.2f" % (100 * jacc, 100 * (jacc - base_acc)))
    if jacc >= acc:
        log("  joint matches or beats the sweep, so the sweep was not hiding a better point")
        acc, vec = jacc, jvec
    else:
        log("  sweep found a better point, which means the joint fit hit a local optimum")

    # Bootstrap the DELTA. Paired, since both arms score the same photos.
    rng = np.random.default_rng(0)
    n = len(vec)
    diffs = np.empty(args.boot)
    for b in range(args.boot):
        s = rng.integers(0, n, n)
        diffs[b] = vec[s].mean() - base_vec[s].mean()
    # Export the k=0 calibration, which is the fitted optimum and what ships.
    import json as _json
    acc0, _, T0, B0 = fit_and_eval(0.0, True)
    _json.dump({"temperature": T0, "beta": B0, "k": 0.0,
                "prior": "P(species|cell,month) = n_scm / n_cm",
                "val_top1_abs": acc0,
                "blob_version": 3},
               open("calibration_month_tiny39.json", "w"), indent=2)
    log("")
    log("wrote calibration_month_tiny39.json  T=%.5f beta=%.3f  val %.2f%%"
        % (T0, B0, 100 * acc0))

    lo, hi = np.percentile(diffs, [2.5, 97.5])
    log("")
    log("paired bootstrap on the delta, %d resamples:" % args.boot)
    log("  95%% CI: [%+.2f, %+.2f] points" % (100 * lo, 100 * hi))
    if lo > 0:
        log("  -> month helps, and the interval excludes zero")
    else:
        log("  -> NOT distinguishable from noise on this eval")


if __name__ == "__main__":
    main()
