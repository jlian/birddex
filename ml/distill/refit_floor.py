"""Refit T and beta at the CLIENT floor, and compare against the shipped fit.

The shipped constants came from jobs/fit_month.py, which clamps the prior at
1e-12, so log floor -27.63. rank.ts applies Math.log(1e-9), so -20.72. The
question is whether that mismatch is worth a recalibration or a one-line
client change.

Runs the SAME fit at both floors on the same split, so the only thing that
differs is the clamp. Reports the constants and the accuracy each produces.
"""
import math
import sys

import numpy as np
import pandas as pd
import torch
import torch.nn.functional as F

CANDS = "calib_cands_tiny39_a060.parquet"
MONTH = "calib_month_tiny39.npz"

df = pd.read_parquet(CANDS)
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

z = np.load(MONTH)
n_scm = torch.tensor(z["n_scm"], dtype=torch.float32)
n_sc = torch.tensor(z["n_sc"], dtype=torch.float32)
n_cm = torch.tensor(z["n_cm"], dtype=torch.float32)
n_c = torch.tensor(z["n_c"], dtype=torch.float32)
p_pooled = n_sc / n_c.clamp(min=1).unsqueeze(1)

g = torch.Generator().manual_seed(0)
perm = torch.randperm(N, generator=g)
ncut = int(N * 0.7)
tr, va = perm[:ncut], perm[ncut:]


def fit(floor_p, k=0.0):
    """Fit T and beta with the prior clamped at floor_p. k=0 is the shipped fit."""
    logT = torch.tensor(math.log(0.0076), requires_grad=True)
    logbeta = torch.tensor(math.log(0.56), requires_grad=True)

    def logp(sel):
        num = n_scm[sel] + k * p_pooled[sel]
        den = (n_cm[sel] + k).clamp(min=1e-6).unsqueeze(1)
        return torch.log((num / den).clamp(min=floor_p))

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
        acc = ((order[:, 0] == tg) & (tg >= 0)).float().mean()
    return float(acc), float(logT.exp()), float(logbeta.exp())


SHIPPED_T = 0.007545354776084423
SHIPPED_BETA = 0.5435083508491516

print("")
print("Refit at each floor, same split, k=0 (the shipped configuration):")
print("")
print("  %-28s %8s %12s %10s" % ("floor", "top-1", "T", "beta"))
rows = []
for name, fp in (("1e-12  reference, -27.63", 1e-12),
                 ("1e-9   client rank.ts, -20.72", 1e-9)):
    acc, T, beta = fit(fp)
    rows.append((name, acc, T, beta))
    print("  %-28s %7.2f%% %12.8f %10.6f" % (name, 100 * acc, T, beta))

print("")
print("Shipped constants:            %12.8f %10.6f" % (SHIPPED_T, SHIPPED_BETA))
print("")

# Which fitted pair do the shipped constants actually match?
for name, acc, T, beta in rows:
    dT = abs(T - SHIPPED_T) / SHIPPED_T
    db = abs(beta - SHIPPED_BETA) / SHIPPED_BETA
    print("  vs %-28s T off %6.2f%%  beta off %6.2f%%" % (name, 100 * dT, 100 * db))

print("")
print("Accuracy delta between the two floors: %.2f points" % (
    100 * (rows[0][1] - rows[1][1])))
