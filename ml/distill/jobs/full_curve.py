#!/usr/bin/env python3
"""Curve for the FULL 7,555-species run, in the valcos_curve.py house style.

One panel, twin y-axes: val_cos solid circles on the left, train_loss dashed
squares on the right. Also overlays the NABirds-401 pilot (TEACH-W) as a faint
reference line so progress has context, though note the two are NOT directly
comparable: different species counts and different val target sets.
"""
import argparse
import re

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

EPOCH_RE = re.compile(
    r"epoch (\d+)/(\d+)\s+train_loss=([\d.]+)\s+val_cos_sim=([\d.]+)\s+(\d+)s")


def parse(path, start_pat=None, stop_pat=None):
    ep, val, loss, secs = [], [], [], []
    active = start_pat is None
    try:
        fh = open(path, errors="replace")
    except IOError:
        return {"ep": ep, "val": val, "loss": loss, "secs": secs}
    for ln in fh:
        if start_pat and re.search(start_pat, ln):
            active = True
            continue
        if active and stop_pat and re.search(stop_pat, ln):
            break
        if not active:
            continue
        m = EPOCH_RE.search(ln)
        if m:
            ep.append(int(m.group(1)))
            loss.append(float(m.group(3)))
            val.append(float(m.group(4)))
            secs.append(int(m.group(5)))
    fh.close()
    return {"ep": ep, "val": val, "loss": loss, "secs": secs}


def table(name, r):
    if not r["val"]:
        print("(no epochs yet: %s)" % name)
        return
    print("")
    print("=== %s ===" % name)
    print("%3s %11s %9s %9s %8s" % ("ep", "train_loss", "val_cos", "d_val", "sec"))
    pv = None
    for e, tl, v, sc in zip(r["ep"], r["loss"], r["val"], r["secs"]):
        dv = ("%+.4f" % (v - pv)) if pv is not None else "   --   "
        print("%3d %11.4f %9.4f %9s %8d" % (e, tl, v, dv, sc))
        pv = v
    if len(r["val"]) >= 3:
        print("last-3-epoch avg val_cos gain/epoch: %+.5f"
              % ((r["val"][-1] - r["val"][-3]) / 2))
    tail = r["secs"][1:] if len(r["secs"]) > 1 else r["secs"]
    med = sorted(tail)[len(tail) // 2] if tail else 0
    done = r["ep"][-1]
    print("epoch %d/25   median %ds/epoch (excl. ep1)   best val_cos %.4f"
          % (done, med, max(r["val"])))
    if med and done < 25:
        print("ETA: %.1f h remaining" % ((25 - done) * med / 3600.0))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", default="/home/jlian/wingdex-queue/full/full.log")
    ap.add_argument("--pilot-log", default="/home/jlian/wingdex-queue/queue.log")
    ap.add_argument("--png", default="/home/jlian/wingdex-queue/full/full_curve.png")
    args = ap.parse_args()

    full = parse(args.log, r"STEP 2/3")
    pilot = parse(args.pilot_log, r"STEP 3a", r"STEP 3b")

    table("FULL 7,555 species (TinyCLIP-39M, WingCLIP-0.1 teacher)", full)

    fig, ax1 = plt.subplots(figsize=(9.5, 5.5))
    ax2 = ax1.twinx()

    if pilot["val"]:
        ax1.plot(pilot["ep"], pilot["val"], "o-", color="#999999", ms=3,
                 alpha=0.55,
                 label="NABirds-401 pilot (reference, best %.4f)" % max(pilot["val"]))
    if full["val"]:
        ax1.plot(full["ep"], full["val"], "o-", color="#1f77b4", ms=4,
                 label="FULL 7,555sp  val_cos (best %.4f)" % max(full["val"]))
        ax2.plot(full["ep"], full["loss"], "s--", color="#d62728", ms=3,
                 alpha=0.5, label="FULL 7,555sp  train_loss")

    ax1.set_xlabel("epoch")
    ax1.set_ylabel("val_cos_sim")
    ax1.grid(True, alpha=0.3)
    ax2.set_ylabel("train_loss")
    h1, l1 = ax1.get_legend_handles_labels()
    h2, l2 = ax2.get_legend_handles_labels()
    ax1.legend(h1 + h2, l1 + l2, fontsize=8, loc="center right")

    n = full["ep"][-1] if full["ep"] else 0
    plt.title("FULL 7,555-species distill: TinyCLIP-39M from WingCLIP-0.1  "
              "[epoch %d/25]\nbatch 128, lr 8.1e-5, bf16+channels_last+compile"
              % n)
    fig.tight_layout()
    fig.savefig(args.png, dpi=110)
    print("")
    print("saved %s" % args.png)


if __name__ == "__main__":
    main()
