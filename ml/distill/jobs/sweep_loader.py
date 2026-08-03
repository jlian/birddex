#!/usr/bin/env python3
"""End-to-end loader throughput sweep. Measures what training ACTUALLY gets.

Context: micro-benchmarks said the pieces are fast (raw SMB 2,005 img/s; decode
706; full transform pipeline 285 x12 workers = 3,422 ideal) yet the real loader
delivers only ~1,012 and training ~655. So the loss is in DELIVERY -- worker
IPC, pickling, collation, main-process GIL -- not in any single op. This sweeps
the knobs that govern delivery and measures end to end.

Each config is timed on the real WebDataset pipeline with real shards.
"""
import argparse
import os
import sys
import time

import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

SHARDS = "/mnt/nas/WingDex-Distill/wds-nabirds401/shard-*.tar"


def log(m):
    print("[%s] %s" % (time.strftime("%H:%M:%S"), m), flush=True)


def run_cfg(preprocess, workers, batch, prefetch, nbatch, sv, shards,
            to_cuda=False):
    """Time `nbatch` batches through the real loader. Returns img/s."""
    import wds_loader
    import webdataset as wds

    # monkeypatch WebLoader so we can inject prefetch_factor without touching
    # the production signature
    orig = wds.WebLoader

    def patched(ds, **kw):
        if kw.get("num_workers", 0) and prefetch is not None:
            kw["prefetch_factor"] = prefetch
        return orig(ds, **kw)

    wds.WebLoader = patched
    try:
        # epoch_samples MUST be set: production always sets it, and with_epoch()
        # is what makes the iterable terminate/repeat sanely. Passing None made
        # every config StopIteration on the first batch.
        dl = wds_loader.make_wds_loader(
            shards, preprocess, batch, workers,
            shuffle=10000, is_train=True, epoch_samples=185000,
            val_frac=0.02, sv_targets=sv)
        it = iter(dl)
        # warmup: worker spin-up must not count
        t_warm = time.time()
        for _ in range(8):
            next(it)
        warm = time.time() - t_warm
        n = 0
        t0 = time.time()
        for _ in range(nbatch):
            x, y = next(it)
            if to_cuda:
                x = x.cuda(non_blocking=True)
                y = y.cuda(non_blocking=True)
                torch.cuda.synchronize()
            n += x.shape[0]
        el = time.time() - t0
        del it, dl
        return n / el, warm
    finally:
        wds.WebLoader = orig


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shards", default=SHARDS)
    # NOTE: the shard list MUST be a pre-expanded list. Passing the raw glob
    # PATTERN to make_wds_loader yields zero samples (StopIteration on the first
    # batch) -- train_student.py always sorted(glob.glob(...)) first, so this
    # only bites callers that skip that step. Cost me a full debug cycle.
    ap.add_argument("--nbatch", type=int, default=60)
    ap.add_argument("--sv", default="embeddings_wingclip_nb401")
    ap.add_argument("--cuda", action="store_true",
                    help="also move batches to GPU, i.e. what training does")
    args = ap.parse_args()

    import glob as _glob
    shard_list = sorted(_glob.glob(args.shards)) if "*" in args.shards else args.shards
    log("shards: %d" % (len(shard_list) if isinstance(shard_list, list) else 1))

    from train_student import Student
    from wds_loader import SingleViewTargets

    st = Student("timm:vit_medium_patch16_clip_224.tinyclip_yfcc15m", "pretrained")
    pp = st.preprocess
    sv = SingleViewTargets(args.sv) if args.sv else None
    log("targets: %s" % (args.sv or "shard-baked"))

    # (workers, batch, prefetch_factor)
    configs = [
        (12, 96, 2),
        (12, 96, 4),
        (12, 96, 6),
        (12, 96, 8),
        (8, 96, 6),
        (16, 96, 6),
        (14, 96, 6),
        (12, 128, 6),
        (12, 192, 6),
        (12, 256, 6),
    ]

    print("")
    print("%-9s %-7s %-9s %10s %9s" % ("workers", "batch", "prefetch", "img/s", "warmup_s"))
    print("-" * 50)
    best = (0, None)
    results = []
    for w, b, pf in configs:
        try:
            rate, warm = run_cfg(pp, w, b, pf, args.nbatch, sv, shard_list,
                                 to_cuda=args.cuda)
            results.append((w, b, pf, rate))
            flag = ""
            if rate > best[0]:
                best = (rate, (w, b, pf))
                flag = "  <-- best"
            print("%-9d %-7d %-9d %10.1f %9.1f%s" % (w, b, pf, rate, warm, flag))
        except Exception as e:
            import traceback
            print("%-9d %-7d %-9d %10s   %s: %s"
                  % (w, b, pf, "FAIL", type(e).__name__, str(e)[:80]))
            traceback.print_exc()

    print("")
    print("=" * 60)
    print("baseline (12/96/2, what production uses today): ", end="")
    base = [r for r in results if r[:3] == (12, 96, 2)]
    if base:
        print("%.1f img/s" % base[0][3])
        if best[1]:
            print("best: workers=%d batch=%d prefetch=%d -> %.1f img/s (%.2fx)"
                  % (best[1][0], best[1][1], best[1][2], best[0],
                     best[0] / base[0][3]))
    print("reference: training measured ~655 img/s end to end")
    print("=" * 60)


if __name__ == "__main__":
    main()
