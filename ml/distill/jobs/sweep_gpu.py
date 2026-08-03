#!/usr/bin/env python3
"""GPU-side optimisation sweep -- the side that ACTUALLY binds.

bench_bound.py settled it: GPU step 700 img/s, loader 1,383, combined 652.
The loader delivers 2.1x more than the GPU consumes, and combined is 93% of the
GPU-only ceiling, so training is GPU-BOUND and already well overlapped. Every
data-path idea (pre-resize, DALI, prefetch_factor) is therefore wasted effort.

This sweeps the GPU-side knobs on synthetic resident data, so the loader cannot
confound the measurement:
  - baseline fp16 + GradScaler (what we run today)
  - channels_last memory format
  - bf16 (no GradScaler needed on Ampere)
  - torch.compile
  - combinations, and larger batches
"""
import argparse
import os
import sys
import time

import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def log(m):
    print("[%s] %s" % (time.strftime("%H:%M:%S"), m), flush=True)


def bench(make_model, batch, dtype, channels_last, compile_it, iters=30,
          warm=10):
    dev = torch.device("cuda")
    model = make_model().to(dev).train()
    if channels_last:
        model = model.to(memory_format=torch.channels_last)
    if compile_it:
        model = torch.compile(model)
    opt = torch.optim.AdamW(model.parameters(), lr=7e-5)
    use_scaler = (dtype == torch.float16)
    scaler = torch.amp.GradScaler("cuda", enabled=use_scaler)
    x = torch.randn(batch, 3, 224, 224, device=dev)
    if channels_last:
        x = x.to(memory_format=torch.channels_last)
    y = torch.randn(batch, 768, device=dev)
    y = y / y.norm(dim=-1, keepdim=True)

    def step():
        with torch.amp.autocast("cuda", dtype=dtype):
            out = model(x)
            loss = (1 - (out * y).sum(-1)).mean()
        if use_scaler:
            scaler.scale(loss).backward()
            scaler.step(opt)
            scaler.update()
        else:
            loss.backward()
            opt.step()
        opt.zero_grad(set_to_none=True)

    for _ in range(warm):
        step()
    torch.cuda.synchronize()
    t0 = time.time()
    for _ in range(iters):
        step()
    torch.cuda.synchronize()
    el = time.time() - t0
    peak = torch.cuda.max_memory_allocated() / 1e9
    torch.cuda.reset_peak_memory_stats()
    del model, opt, x, y
    torch.cuda.empty_cache()
    return iters * batch / el, peak


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--iters", type=int, default=30)
    args = ap.parse_args()

    from train_student import Student
    ARCH = "timm:vit_medium_patch16_clip_224.tinyclip_yfcc15m"

    def mk():
        return Student(ARCH, "pretrained")

    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    torch.backends.cudnn.benchmark = True

    # (label, batch, dtype, channels_last, compile)
    cfgs = [
        ("baseline fp16 (today)", 96, torch.float16, False, False),
        ("fp16 + channels_last", 96, torch.float16, True, False),
        ("bf16 (no scaler)", 96, torch.bfloat16, False, False),
        ("bf16 + channels_last", 96, torch.bfloat16, True, False),
        ("fp16 + compile", 96, torch.float16, False, True),
        ("fp16 + channels_last + compile", 96, torch.float16, True, True),
        ("bf16 + channels_last + compile", 96, torch.bfloat16, True, True),
        ("fp16 batch128", 128, torch.float16, False, False),
        ("fp16 + cl + compile batch128", 128, torch.float16, True, True),
        ("fp16 + cl + compile batch192", 192, torch.float16, True, True),
    ]

    print("")
    print("%-34s %7s %11s %8s %8s" % ("config", "batch", "img/s", "vs base", "peakGB"))
    print("-" * 74)
    base = None
    best = (0, None)
    for label, b, dt, cl, comp in cfgs:
        try:
            r, peak = bench(mk, b, dt, cl, comp, iters=args.iters)
            if base is None:
                base = r
            flag = ""
            if r > best[0]:
                best = (r, label)
                flag = "  <--"
            print("%-34s %7d %11.1f %7.2fx %8.2f%s"
                  % (label, b, r, r / base, peak, flag))
        except Exception as e:
            print("%-34s %7d %11s   %s" % (label, b, "FAIL", str(e)[:34]))

    print("")
    print("=" * 74)
    if base and best[1]:
        print("baseline %.1f img/s -> best %.1f img/s (%.2fx) via: %s"
              % (base, best[0], best[0] / base, best[1]))
    print("loader delivers ~1,383 img/s, so GPU gains translate almost 1:1")
    print("=" * 74)


if __name__ == "__main__":
    main()
