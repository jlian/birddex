#!/usr/bin/env python3
"""Plot TEACH-W vs TEACH-B val_cos curves in the original valcos_curve.py style.

Keeps what worked before: ONE panel, twin y-axes (val_cos left, train_loss
right), solid circles for val_cos, dashed squares for loss, plus the printed
per-epoch delta table. Extends it to overlay both teacher runs, since they
share every hyperparameter and only the teacher differs.

Colour = run identity (blue = TEACH-W, red = TEACH-B).
Line style = metric (solid/o = val_cos, dashed/s = train_loss).

Usage:  python jobs/teacher_curve.py [--png ...]
"""
import argparse
import re

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

LOG = "/home/jlian/wingdex-queue/queue.log"
STEP_RE = re.compile(r"STEP (\d+[ab]?): (.+)")
EPOCH_RE = re.compile(
    r"epoch (\d+)/(\d+)\s+train_loss=([\d.]+)\s+val_cos_sim=([\d.]+)\s+(\d+)s")

COLORS = {"TEACH-W": "#1f77b4", "TEACH-B": "#d62728"}
TITLES = {"TEACH-W": "TEACH-W  WingCLIP-0.1 teacher",
          "TEACH-B": "TEACH-B  BioCLIP-2 teacher"}


def parse(path):
    runs = []
    cur = None
    for ln in open(path, errors="replace"):
        m = STEP_RE.search(ln)
        if m:
            lab = m.group(2)
            key = "TEACH-W" if "TEACH-W" in lab else ("TEACH-B" if "TEACH-B" in lab else None)
            if key:
                cur = {"key": key, "ep": [], "val": [], "loss": [], "secs": [], "total": 25}
                runs.append(cur)
            else:
                cur = None
            continue
        m2 = EPOCH_RE.search(ln)
        if m2 and cur is not None:
            cur["ep"].append(int(m2.group(1)))
            cur["total"] = int(m2.group(2))
            cur["loss"].append(float(m2.group(3)))
            cur["val"].append(float(m2.group(4)))
            cur["secs"].append(int(m2.group(5)))
    return [r for r in runs if r["val"]]


def table(r):
    print("")
    print("=== %s ===" % TITLES[r["key"]])
    print("%3s %11s %9s %9s %9s" % ("ep", "train_loss", "val_cos", "d_val", "d_loss"))
    pv = pl = None
    for ep, tl, v in zip(r["ep"], r["loss"], r["val"]):
        dv = ("%+.4f" % (v - pv)) if pv is not None else "   --   "
        dl = ("%+.4f" % (tl - pl)) if pl is not None else "   --   "
        print("%3d %11.4f %9.4f %9s %9s" % (ep, tl, v, dv, dl))
        pv, pl = v, tl
    if len(r["val"]) >= 3:
        print("last-3-epoch avg val_cos gain/epoch: %+.5f"
              % ((r["val"][-1] - r["val"][-3]) / 2))
    if len(r["val"]) >= 5:
        print("first-5-epoch avg val_cos gain/epoch: %+.5f"
              % ((r["val"][4] - r["val"][0]) / 4))
    print("progress: %d/%d epochs   %ds/epoch   best val_cos %.4f"
          % (r["ep"][-1], r["total"], r["secs"][-1], max(r["val"])))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", default=LOG)
    ap.add_argument("--png", default="/home/jlian/wingdex-queue/curve.png")
    args = ap.parse_args()

    runs = parse(args.log)
    if not runs:
        print("no TEACH-W / TEACH-B epochs found yet")
        return

    for r in runs:
        table(r)

    fig, ax1 = plt.subplots(figsize=(9, 5.5))
    ax2 = ax1.twinx()

    for r in runs:
        c = COLORS[r["key"]]
        ax1.plot(r["ep"], r["val"], "o-", color=c, ms=4,
                 label="%s  val_cos (best %.4f)" % (r["key"], max(r["val"])))
        ax2.plot(r["ep"], r["loss"], "s--", color=c, ms=3, alpha=0.45,
                 label="%s  train_loss" % r["key"])

    ax1.set_xlabel("epoch")
    ax1.set_ylabel("val_cos_sim")
    ax1.grid(True, alpha=0.3)
    ax2.set_ylabel("train_loss")

    h1, l1 = ax1.get_legend_handles_labels()
    h2, l2 = ax2.get_legend_handles_labels()
    ax1.legend(h1 + h2, l1 + l2, fontsize=8, loc="center right")

    done = ", ".join("%s %d/%d" % (r["key"], r["ep"][-1], r["total"]) for r in runs)
    plt.title("TinyCLIP-39M teacher comparison, NABirds-401 pilot  (%s)\n"
              "identical recipe, only the teacher differs" % done)
    fig.tight_layout()
    fig.savefig(args.png, dpi=110)
    print("")
    print("saved %s" % args.png)


if __name__ == "__main__":
    main()
