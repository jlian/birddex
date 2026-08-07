"""G20 x G16: does fitting the absence floor change the month result?

Two reasons this matters more with a monthly prior than a pooled one:

  1. The +1.17 was measured with the floor at log(1e-12) = -27.63, because that
     is where torch clamps. The shipping client uses log(1e-9) = -20.72. So the
     number we quoted is not the number that would ship.

  2. Month makes absence far more common. Only 9.4% of candidate slots carry a
     monthly count against 13.3% pooled, so roughly 90% of slots hit the floor.
     A constant nobody fitted is now a main term, not a rare correction.

The floor is made differentiable with logaddexp, which is exactly adding a
pseudo-probability:

    log P_eff = log( P + exp(floor) ) = logaddexp( log P, floor )

so it is smooth everywhere and can be optimised alongside T, beta and k.

Arms, all on the same 30% validation split:
    A  pooled, floor pinned to the client value      (what ships today)
    B  pooled, floor fitted                          (is the floor costing us?)
    C  month,  floor pinned to -27.63                (what we measured before)
    D  month,  floor pinned to the client -20.72     (what would ship as-is)
    E  month,  floor fitted jointly                  (best case)
"""
import argparse
import math

import numpy as np
import pandas as pd
import torch
import torch.nn.functional as F

CLIENT_FLOOR = math.log(1e-9)
TORCH_CLAMP_FLOOR = math.log(1e-12)


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

    g = torch.Generator().manual_seed(args.seed)
    perm = torch.randperm(N, generator=g)
    ncut = int(N * (1 - args.val_frac))
    tr, va = perm[:ncut], perm[ncut:]

    def run(use_month, k_fixed, floor_fixed, fit_floor, fit_k):
        logT = torch.tensor(math.log(0.0076), requires_grad=True)
        logbeta = torch.tensor(math.log(0.56), requires_grad=True)
        logk = torch.tensor(math.log(max(k_fixed, 1e-6)), requires_grad=fit_k)
        floor = torch.tensor(float(floor_fixed), requires_grad=fit_floor)

        params = [logT, logbeta]
        if fit_k:
            params.append(logk)
        if fit_floor:
            params.append(floor)

        def score(sel):
            if use_month:
                k = logk.exp()
                p = (n_scm[sel] + k * p_pooled[sel]) / (n_cm[sel] + k).clamp(min=1e-6).unsqueeze(1)
            else:
                p = p_pooled[sel]
            lp = torch.logaddexp(torch.log(p.clamp(min=1e-30)), floor)
            return sims[sel] / logT.exp() + logbeta.exp() * lp

        opt = torch.optim.LBFGS(params, lr=0.05, max_iter=300, tolerance_grad=1e-9)

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
                float(logbeta.exp()), float(logk.exp()), float(floor))

    log("")
    log("%-52s %9s %8s %8s %9s" % ("arm", "top-1", "k", "floor", "beta"))
    log("-" * 92)

    aA = run(False, 0.0, CLIENT_FLOOR, False, False)
    log("%-52s %8.2f%% %8s %8.2f %9.3f"
        % ("A pooled, floor pinned to client log(1e-9)", 100 * aA[0], "-", aA[5], aA[3]))

    aB = run(False, 0.0, CLIENT_FLOOR, True, False)
    log("%-52s %8.2f%% %8s %8.2f %9.3f"
        % ("B pooled, floor FITTED", 100 * aB[0], "-", aB[5], aB[3]))

    best_c = None
    for k in [0.0, 1.0, 3.0, 10.0]:
        r = run(True, k, TORCH_CLAMP_FLOOR, False, False)
        if best_c is None or r[0] > best_c[0]:
            best_c = r
            best_ck = k
    log("%-52s %8.2f%% %8.0f %8.2f %9.3f"
        % ("C month, floor pinned to -27.63 (what we measured)",
           100 * best_c[0], best_ck, best_c[5], best_c[3]))

    best_d = None
    for k in [0.0, 1.0, 3.0, 10.0]:
        r = run(True, k, CLIENT_FLOOR, False, False)
        if best_d is None or r[0] > best_d[0]:
            best_d = r
            best_dk = k
    log("%-52s %8.2f%% %8.0f %8.2f %9.3f"
        % ("D month, floor pinned to client -20.72 (would ship)",
           100 * best_d[0], best_dk, best_d[5], best_d[3]))

    best_e = None
    for k in [0.0, 1.0, 3.0, 10.0]:
        r = run(True, k, CLIENT_FLOOR, True, False)
        if best_e is None or r[0] > best_e[0]:
            best_e = r
            best_ek = k
    log("%-52s %8.2f%% %8.0f %8.2f %9.3f"
        % ("E month, floor FITTED", 100 * best_e[0], best_ek, best_e[5], best_e[3]))

    aF = run(True, 1.0, CLIENT_FLOOR, True, True)
    log("%-52s %8.2f%% %8.3f %8.2f %9.3f"
        % ("F month, k AND floor fitted jointly", 100 * aF[0], aF[4], aF[5], aF[3]))

    log("")
    log("=== what this says ===")
    log("  fixing the floor on the POOLED prior:   %+.2f points" % (100 * (aB[0] - aA[0])))
    log("  month with the floor as-shipped:        %+.2f points" % (100 * (best_d[0] - aA[0])))
    log("  month with the floor fitted:            %+.2f points" % (100 * (best_e[0] - aA[0])))

    rng = np.random.default_rng(0)
    n = len(aA[1])
    for label, arm in [("month, floor fitted", best_e)]:
        d = np.empty(args.boot)
        for b in range(args.boot):
            s = rng.integers(0, n, n)
            d[b] = arm[1][s].mean() - aA[1][s].mean()
        lo, hi = np.percentile(d, [2.5, 97.5])
        log("")
        log("  paired bootstrap, %s vs arm A: 95%% CI [%+.2f, %+.2f]"
            % (label, 100 * lo, 100 * hi))


if __name__ == "__main__":
    main()
