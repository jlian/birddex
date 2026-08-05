"""Why does a hand-picked k beat a fitted one?

Three candidate explanations, and they predict different things:

  1. LOCAL OPTIMUM. LBFGS got stuck. Predicts the joint fit has HIGHER training
     loss than the swept point, since it failed to find the better minimum.

  2. OBJECTIVE MISMATCH. The optimiser minimises cross-entropy, but we score
     top-1 accuracy. Those are different surfaces: CE cares how well-calibrated
     every candidate's probability is, top-1 only cares which one ranks first.
     Predicts the joint fit has LOWER training loss and still worse accuracy.

  3. NOISE. 95.00 against 94.94 on 3,322 photos is 0.06 points, which is two
     photos. Predicts the gap is inside the resampling spread.

So: report train CE, val CE and val top-1 across k, plus where the joint fit
landed, plus a paired bootstrap on the swept-versus-joint difference. Whichever
prediction holds is the answer.
"""
import argparse
import math

import numpy as np
import pandas as pd
import torch
import torch.nn.functional as F

FLOOR = math.log(1e-9)


def log(m):
    print(m, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidates", required=True)
    ap.add_argument("--month-npz", required=True)
    ap.add_argument("--boot", type=int, default=4000)
    args = ap.parse_args()

    df = pd.read_parquet(args.candidates)
    N = len(df)
    sims = torch.tensor(np.stack(df["cand_sim"].values), dtype=torch.float32)
    idxs = np.stack(df["cand_idx"].values)
    true = df["true_app_idx"].values

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
    p_pooled = n_sc / n_c.clamp(min=1).unsqueeze(1)

    g = torch.Generator().manual_seed(0)
    perm = torch.randperm(N, generator=g)
    ncut = int(N * 0.7)
    tr, va = perm[:ncut], perm[ncut:]

    def make_score(logT, logbeta, kval):
        def score(sel):
            p = (n_scm[sel] + kval * p_pooled[sel]) / (n_cm[sel] + kval).clamp(min=1e-6).unsqueeze(1)
            lp = torch.logaddexp(torch.log(p.clamp(min=1e-30)),
                                 torch.tensor(FLOOR))
            return sims[sel] / logT.exp() + logbeta.exp() * lp
        return score

    def fit_fixed_k(kval):
        logT = torch.tensor(math.log(0.0076), requires_grad=True)
        logbeta = torch.tensor(math.log(0.56), requires_grad=True)
        score = make_score(logT, logbeta, kval)
        opt = torch.optim.LBFGS([logT, logbeta], lr=0.05, max_iter=300,
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
            ltr = score(tr)
            ttr = target[tr]
            vtr = ttr >= 0
            train_ce = float(F.cross_entropy(ltr[vtr], ttr[vtr]))
            lva = score(va)
            tva = target[va]
            vva = tva >= 0
            val_ce = float(F.cross_entropy(lva[vva], tva[vva]))
            order = lva.argsort(dim=-1, descending=True)
            corr = ((order[:, 0] == tva) & vva).float()
        return train_ce, val_ce, float(corr.mean()), corr.numpy()

    log("")
    log("%-10s %11s %11s %11s" % ("k", "train CE", "val CE", "val top-1"))
    log("-" * 46)
    results = {}
    for k in [0.0, 0.5, 1.0, 2.0, 3.0, 10.0]:
        tce, vce, acc, corr = fit_fixed_k(k)
        results[k] = (tce, vce, acc, corr)
        log("%-10.1f %11.5f %11.5f %10.2f%%" % (k, tce, vce, 100 * acc))

    log("")
    log("The joint fit drove k to 0.000, so compare k=0 against k=1:")
    t0, v0, a0, c0 = results[0.0]
    t1, v1, a1, c1 = results[1.0]
    log("  train CE   k=0 %.5f   k=1 %.5f   %s"
        % (t0, t1, "k=0 lower, so NOT a local optimum" if t0 < t1
           else "k=1 lower, so the joint fit MISSED it"))
    log("  val CE     k=0 %.5f   k=1 %.5f" % (v0, v1))
    log("  val top-1  k=0 %.2f%%   k=1 %.2f%%" % (100 * a0, 100 * a1))
    log("  difference %d photos of %d" % (round(abs(a1 - a0) * len(c0)), len(c0)))

    rng = np.random.default_rng(0)
    n = len(c0)
    d = np.empty(args.boot)
    for b in range(args.boot):
        s = rng.integers(0, n, n)
        d[b] = c1[s].mean() - c0[s].mean()
    lo, hi = np.percentile(d, [2.5, 97.5])
    log("")
    log("paired bootstrap, k=1 minus k=0: 95%% CI [%+.2f, %+.2f] points"
        % (100 * lo, 100 * hi))
    if lo <= 0 <= hi:
        log("  -> the interval spans zero, so k=1 and k=0 are NOT distinguishable")
    else:
        log("  -> genuinely different")


if __name__ == "__main__":
    main()
