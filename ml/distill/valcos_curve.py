#!/usr/bin/env python3
"""Dump val_cos-vs-epoch curve + per-epoch slope from a train.log."""
import argparse, re, sys, os


def parse(logpath):
    pat = re.compile(r"epoch (\d+)/(\d+)\s+train_loss=([0-9.]+)\s+val_cos_sim=([0-9.]+)")
    rows = []
    for line in open(logpath):
        m = pat.search(line)
        if m:
            rows.append((int(m.group(1)), int(m.group(2)),
                         float(m.group(3)), float(m.group(4))))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("log")
    ap.add_argument("--png", default=None)
    a = ap.parse_args()
    rows = parse(a.log)
    if not rows:
        print("no epoch lines found", file=sys.stderr)
        sys.exit(1)

    total = rows[-1][1]
    print(f"{'ep':>3} {'train_loss':>11} {'val_cos':>9} {'d_val':>9} {'d_loss':>9}")
    prev_v = prev_l = None
    eps, vals, losses = [], [], []
    for ep, tot, tl, v in rows:
        dv = f"{v-prev_v:+.4f}" if prev_v is not None else "   --   "
        dl = f"{tl-prev_l:+.4f}" if prev_l is not None else "   --   "
        print(f"{ep:>3} {tl:>11.4f} {v:>9.4f} {dv:>9} {dl:>9}")
        prev_v, prev_l = v, tl
        eps.append(ep)
        vals.append(v)
        losses.append(tl)

    if len(vals) >= 3:
        tail = (vals[-1] - vals[-3]) / 2
        print(f"\nlast-3-epoch avg val_cos gain/epoch: {tail:+.5f}")
    if len(vals) >= 5:
        early = (vals[4] - vals[0]) / 4
        print(f"first-5-epoch avg val_cos gain/epoch: {early:+.5f}")
    print(f"progress: {rows[-1][0]}/{total} epochs logged")

    png = a.png or os.path.join(os.path.dirname(os.path.abspath(a.log)), "valcos_curve.png")
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        fig, ax1 = plt.subplots(figsize=(8, 5))
        ax1.plot(eps, vals, "o-", color="#1f77b4", label="val_cos_sim")
        ax1.set_xlabel("epoch")
        ax1.set_ylabel("val_cos_sim", color="#1f77b4")
        ax1.tick_params(axis="y", labelcolor="#1f77b4")
        ax1.grid(True, alpha=0.3)
        ax2 = ax1.twinx()
        ax2.plot(eps, losses, "s--", color="#d62728", label="train_loss", alpha=0.6)
        ax2.set_ylabel("train_loss", color="#d62728")
        ax2.tick_params(axis="y", labelcolor="#d62728")
        plt.title(f"Distill val_cos & train_loss  ({rows[-1][0]}/{total} epochs)")
        fig.tight_layout()
        fig.savefig(png, dpi=110)
        print(f"saved {png}")
    except Exception as e:
        print(f"(plot skipped: {e})")


if __name__ == "__main__":
    main()
