#!/usr/bin/env python3
"""Plot batch-128 against the batch-96 TEACH-W baseline.

Same style as valcos_curve.py: one panel, twin y-axes, solid circles for
val_cos and dashed squares for train_loss. Colour = run, line style = metric.

The two runs share shards, teacher and recipe; only batch (96 -> 128), its
sqrt-scaled LR (7e-5 -> 8.1e-5) and the GPU config differ. NOTE the batch-128
run also has bf16 + channels_last + torch.compile on, so its epoch TIME
advantage is mostly torch.compile, NOT batch size. val_cos is the only fair
quality comparison here, and NABirds top-1 at the end is what decides.
"""
import argparse
import re

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

EPOCH_RE = re.compile(
    r"epoch (\d+)/(\d+)\s+train_loss=([\d.]+)\s+val_cos_sim=([\d.]+)\s+(\d+)s")


def parse_between(path, start_pat, stop_pat=None):
    """Pull epoch rows from the section of a log between two markers."""
    ep, val, loss, secs = [], [], [], []
    active = start_pat is None
    for ln in open(path, errors="replace"):
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
    return {"ep": ep, "val": val, "loss": loss, "secs": secs}


def table(name, r):
    if not r["val"]:
        print("(no epochs yet for %s)" % name)
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
    med = sorted(r["secs"][1:]) if len(r["secs"]) > 1 else r["secs"]
    print("epochs %d   median %ds/epoch (excl. epoch 1)   best val_cos %.4f"
          % (r["ep"][-1], med[len(med) // 2] if med else 0, max(r["val"])))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch-log", default="/home/jlian/wingdex-queue/batch.log")
    ap.add_argument("--base-log", default="/home/jlian/wingdex-queue/queue.log")
    ap.add_argument("--png", default="/home/jlian/wingdex-queue/batch_curve.png")
    args = ap.parse_args()

    b128 = parse_between(args.batch_log, r"STEP B1")
    b96 = parse_between(args.base_log, r"STEP 3a", r"STEP 3b")

    table("batch 96  lr 7e-5   (TEACH-W baseline)", b96)
    table("batch 128 lr 8.1e-5 (bf16+cl+compile)", b128)

    fig, ax1 = plt.subplots(figsize=(9.5, 5.5))
    ax2 = ax1.twinx()
    runs = [("batch 96  lr 7e-5", b96, "#1f77b4"),
            ("batch 128 lr 8.1e-5", b128, "#d62728")]
    for lab, r, c in runs:
        if not r["val"]:
            continue
        ax1.plot(r["ep"], r["val"], "o-", color=c, ms=4,
                 label="%s  val_cos (best %.4f)" % (lab, max(r["val"])))
        ax2.plot(r["ep"], r["loss"], "s--", color=c, ms=3, alpha=0.45,
                 label="%s  train_loss" % lab)

    ax1.set_xlabel("epoch")
    ax1.set_ylabel("val_cos_sim")
    ax1.grid(True, alpha=0.3)
    ax2.set_ylabel("train_loss")
    h1, l1 = ax1.get_legend_handles_labels()
    h2, l2 = ax2.get_legend_handles_labels()
    ax1.legend(h1 + h2, l1 + l2, fontsize=8, loc="center right")

    done = "batch128 %d/25" % (b128["ep"][-1] if b128["ep"] else 0)
    plt.title("Batch size sweep on NABirds-401: 96 vs 128 (LR sqrt-scaled)  [%s]\n"
              "same shards + teacher + recipe; NABirds top-1 decides, not val_cos" % done)
    fig.tight_layout()
    fig.savefig(args.png, dpi=110)
    print("")
    print("saved %s" % args.png)


if __name__ == "__main__":
    main()
