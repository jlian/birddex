"""Is the abstention gate still good AFTER reranking?

eval_nabirds.py measures confidence as softmax over raw vision-to-text
similarity, with no geographic prior and no month. That is pre-rerank. The
shipping pipeline scores sim/T + beta*log P(species|cell,month), so its final
distribution is different, and the 77% coverage at 96.02% accuracy does not
automatically carry over.

Two candidate gates, measured on the same calibration validation split:

  A vision-only softmax, what eval_nabirds.py reports today
  B post-rerank softmax over the final scores

B has more information, so it ought to separate better. But it is also
sharpened by beta and by a geographic prior that can be confidently WRONG for a
genuine vagrant, which is exactly when a user most wants an honest low-confidence
answer. So this is worth measuring rather than assuming.

Reports coverage and accuracy-on-kept for both, on the same photos.
"""
import argparse
import math

import numpy as np
import pandas as pd
import torch


def log(m):
    print(m, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidates", required=True)
    ap.add_argument("--month-npz", required=True)
    ap.add_argument("--val-frac", type=float, default=0.3)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--temperature", type=float, default=0.00754)
    ap.add_argument("--beta", type=float, default=0.542)
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
    n_cm = torch.tensor(z["n_cm"], dtype=torch.float32)

    g = torch.Generator().manual_seed(args.seed)
    perm = torch.randperm(N, generator=g)
    va = perm[int(N * (1 - args.val_frac)):]

    # k = 0, the fitted value: P = n_scm / n_cm.
    p = n_scm[va] / n_cm[va].clamp(min=1e-6).unsqueeze(1)
    lp = torch.logaddexp(torch.log(p.clamp(min=1e-30)),
                         torch.tensor(math.log(1e-9)))
    post = sims[va] / args.temperature + args.beta * lp

    tg = target[va]
    valid = (tg >= 0).numpy()

    # A: vision only, matching eval_nabirds.py.
    conf_a = (sims[va] * 100).softmax(-1).max(-1).values.numpy()
    ok_a = (sims[va].argmax(-1) == tg).numpy() & valid

    # B: post-rerank.
    conf_b = post.softmax(-1).max(-1).values.numpy()
    ok_b = (post.argmax(-1) == tg).numpy() & valid

    log("")
    log("photos: %d (validation split)" % len(va))
    log("")
    log("%-34s %10s %14s" % ("gate", "coverage", "acc on kept"))
    log("-" * 62)
    for label, conf, ok in [("A vision-only softmax (today)", conf_a, ok_a),
                            ("B post-rerank softmax", conf_b, ok_b)]:
        log("  %s" % label)
        for thr in [0.0, 0.3, 0.5, 0.7, 0.9]:
            keep = conf >= thr
            cov = 100.0 * keep.mean()
            acc = 100.0 * ok[keep].mean() if keep.any() else 0.0
            log("    thr %.1f %26.1f%% %13.2f%%" % (thr, cov, acc))
        log("")

    log("What to look for: the gate is useful when accuracy on kept rises")
    log("steeply while coverage stays high. If B is sharper, prefer it, since")
    log("it is the distribution the user actually sees.")


if __name__ == "__main__":
    main()
