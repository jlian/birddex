#!/usr/bin/env python3
"""Settle it: is training loader-bound or GPU-bound?

The sweep showed the loader alone delivers 1,000-2,500 img/s while real
training runs ~655. If the GPU step alone is also near 655, the loader is NOT
the bottleneck and every decode/transform optimisation is wasted effort.

Measures three things on the SAME model and batch shape:
  1. pure GPU fwd+bwd+step on synthetic data already resident on the GPU
  2. loader alone (no model)
  3. the real combined loop

Amdahl: if 1/rate_gpu + 1/rate_loader ~= 1/rate_combined, the two are serial
and overlapping them is the win. If rate_combined ~= rate_gpu, we are GPU-bound.
"""
import argparse
import glob
import os
import sys
import time

import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

SHARDS = "/mnt/nas/WingDex-Distill/wds-nabirds401/shard-*.tar"


def log(m):
    print("[%s] %s" % (time.strftime("%H:%M:%S"), m), flush=True)


def bench_gpu(model, batch, iters=40):
    """fwd+bwd+opt on synthetic GPU-resident data. No loader involved."""
    dev = torch.device("cuda")
    model = model.to(dev).train()
    opt = torch.optim.AdamW(model.parameters(), lr=7e-5)
    scaler = torch.amp.GradScaler("cuda")
    x = torch.randn(batch, 3, 224, 224, device=dev)
    y = torch.randn(batch, 768, device=dev)
    y = y / y.norm(dim=-1, keepdim=True)
    for _ in range(8):
        with torch.amp.autocast("cuda", dtype=torch.float16):
            out = model(x)
            loss = (1 - (out * y).sum(-1)).mean()
        scaler.scale(loss).backward()
        scaler.step(opt)
        scaler.update()
        opt.zero_grad(set_to_none=True)
    torch.cuda.synchronize()
    t0 = time.time()
    for _ in range(iters):
        with torch.amp.autocast("cuda", dtype=torch.float16):
            out = model(x)
            loss = (1 - (out * y).sum(-1)).mean()
        scaler.scale(loss).backward()
        scaler.step(opt)
        scaler.update()
        opt.zero_grad(set_to_none=True)
    torch.cuda.synchronize()
    el = time.time() - t0
    return iters * batch / el


def bench_loader(pp, sv, urls, batch, workers, prefetch, nbatch=40):
    import wds_loader
    import webdataset as wds
    orig = wds.WebLoader

    def patched(ds, **kw):
        if kw.get("num_workers", 0) and prefetch:
            kw["prefetch_factor"] = prefetch
        return orig(ds, **kw)

    wds.WebLoader = patched
    try:
        dl = wds_loader.make_wds_loader(urls, pp, batch, workers, shuffle=10000,
                                        is_train=True, epoch_samples=185000,
                                        val_frac=0.02, sv_targets=sv)
        it = iter(dl)
        for _ in range(8):
            next(it)
        n = 0
        t0 = time.time()
        for _ in range(nbatch):
            x, y = next(it)
            n += x.shape[0]
        el = time.time() - t0
        del it, dl
        return n / el
    finally:
        wds.WebLoader = orig


def bench_combined(model, pp, sv, urls, batch, workers, prefetch, nbatch=40,
                   opt_cfg=False):
    import wds_loader
    import webdataset as wds
    orig = wds.WebLoader

    def patched(ds, **kw):
        if kw.get("num_workers", 0) and prefetch:
            kw["prefetch_factor"] = prefetch
        return orig(ds, **kw)

    wds.WebLoader = patched
    dev = torch.device("cuda")
    model = model.to(dev).train()
    dtype = torch.bfloat16 if opt_cfg else torch.float16
    if opt_cfg:
        model = model.to(memory_format=torch.channels_last)
        model = torch.compile(model)
    opt = torch.optim.AdamW(model.parameters(), lr=7e-5)
    scaler = torch.amp.GradScaler("cuda", enabled=not opt_cfg)
    try:
        dl = wds_loader.make_wds_loader(urls, pp, batch, workers, shuffle=10000,
                                        is_train=True, epoch_samples=185000,
                                        val_frac=0.02, sv_targets=sv)
        it = iter(dl)
        for _ in range(8):
            x, y = next(it)
            x = x.to(dev, non_blocking=True)
            if opt_cfg:
                x = x.to(memory_format=torch.channels_last)
            y = y.to(dev, non_blocking=True)
            with torch.amp.autocast("cuda", dtype=dtype):
                out = model(x)
                loss = (1 - (out * y).sum(-1)).mean()
            if opt_cfg:
                loss.backward()
                opt.step()
            else:
                scaler.scale(loss).backward()
                scaler.step(opt)
                scaler.update()
            opt.zero_grad(set_to_none=True)
        torch.cuda.synchronize()
        n = 0
        t0 = time.time()
        for _ in range(nbatch):
            x, y = next(it)
            x = x.to(dev, non_blocking=True)
            if opt_cfg:
                x = x.to(memory_format=torch.channels_last)
            y = y.to(dev, non_blocking=True)
            with torch.amp.autocast("cuda", dtype=dtype):
                out = model(x)
                loss = (1 - (out * y).sum(-1)).mean()
            if opt_cfg:
                loss.backward()
                opt.step()
            else:
                scaler.scale(loss).backward()
                scaler.step(opt)
                scaler.update()
            opt.zero_grad(set_to_none=True)
            n += x.shape[0]
        torch.cuda.synchronize()
        el = time.time() - t0
        del it, dl
        return n / el
    finally:
        wds.WebLoader = orig


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch", type=int, default=96)
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--prefetch", type=int, default=2)
    ap.add_argument("--nbatch", type=int, default=40)
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--opt", action="store_true",
                    help="apply the winning GPU config: bf16 + channels_last + compile")
    args = ap.parse_args()

    from train_student import Student
    from wds_loader import SingleViewTargets

    urls = sorted(glob.glob(SHARDS))
    sv = SingleViewTargets("embeddings_wingclip_nb401")
    st = Student("timm:vit_medium_patch16_clip_224.tinyclip_yfcc15m", "pretrained")
    pp = st.preprocess

    print("")
    print("batch=%d workers=%d prefetch=%d   (%d reps, median)"
          % (args.batch, args.workers, args.prefetch, args.reps))
    print("-" * 58)

    def med(f):
        vals = sorted(f() for _ in range(args.reps))
        return vals[len(vals) // 2], vals

    g, gv = med(lambda: bench_gpu(st, args.batch, args.nbatch))
    print("  GPU step only (synthetic)   %8.1f img/s   %s"
          % (g, ["%.0f" % v for v in gv]))

    l, lv = med(lambda: bench_loader(pp, sv, urls, args.batch, args.workers,
                                     args.prefetch, args.nbatch))
    print("  loader only (no model)      %8.1f img/s   %s"
          % (l, ["%.0f" % v for v in lv]))

    c, cv = med(lambda: bench_combined(st, pp, sv, urls, args.batch,
                                       args.workers, args.prefetch, args.nbatch,
                                       opt_cfg=args.opt))
    print("  combined (real training)    %8.1f img/s   %s"
          % (c, ["%.0f" % v for v in cv]))

    print("")
    serial = 1.0 / (1.0 / g + 1.0 / l)
    print("  if perfectly SERIAL  -> %.1f img/s" % serial)
    print("  if perfectly OVERLAPPED -> %.1f img/s" % min(g, l))
    print("  measured                -> %.1f img/s" % c)
    print("")
    if c >= 0.92 * min(g, l):
        print("  VERDICT: already well overlapped; bounded by the SLOWER of the two.")
    elif c <= 1.12 * serial:
        print("  VERDICT: SERIAL. Loader and GPU are NOT overlapping -- this is the bug.")
    else:
        print("  VERDICT: partial overlap; some headroom remains.")
    if g < l:
        print("  GPU is the slower side -> loader optimisation is WASTED.")
    else:
        print("  Loader is the slower side -> loader optimisation pays.")


if __name__ == "__main__":
    main()
