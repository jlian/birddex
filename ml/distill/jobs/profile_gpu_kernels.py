#!/usr/bin/env python3
"""Where does the GPU time actually go? Kernel-level profile.

We are at ~30% of the RTX 3080 dense bf16 peak (38.9 of 119 TFLOP/s) while
60-70% is typical for tuned ViT training. Flash/SDPA attention is already ON
(timm use_fused_attn()=True), so the gap is elsewhere. This finds it instead of
guessing:

  1. torch profiler top kernels by self CUDA time
  2. fwd vs bwd vs optimizer split
  3. fused/foreach AdamW comparison

Run with the GPU otherwise IDLE or the numbers are meaningless.
"""
import argparse
import os
import sys
import time

import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def build(compile_it, channels_last):
    from train_student import Student
    m = Student("timm:vit_medium_patch16_clip_224.tinyclip_yfcc15m", "pretrained")
    m = m.cuda().train()
    if channels_last:
        m = m.to(memory_format=torch.channels_last)
    if compile_it:
        m = torch.compile(m)
    return m


def phases(model, opt, B, iters=20):
    """Time fwd, bwd and optimizer separately with explicit syncs."""
    x = torch.randn(B, 3, 224, 224, device="cuda")
    y = torch.randn(B, 768, device="cuda")
    y = y / y.norm(dim=-1, keepdim=True)
    t_f = t_b = t_o = 0.0
    for i in range(iters + 5):
        torch.cuda.synchronize()
        a = time.time()
        with torch.amp.autocast("cuda", dtype=torch.bfloat16):
            out = model(x)
            loss = (1 - (out * y).sum(-1)).mean()
        torch.cuda.synchronize()
        b = time.time()
        loss.backward()
        torch.cuda.synchronize()
        c = time.time()
        opt.step()
        opt.zero_grad(set_to_none=True)
        torch.cuda.synchronize()
        d = time.time()
        if i >= 5:
            t_f += b - a
            t_b += c - b
            t_o += d - c
    tot = t_f + t_b + t_o
    return t_f / tot, t_b / tot, t_o / tot, iters * B / tot


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch", type=int, default=96)
    ap.add_argument("--iters", type=int, default=20)
    ap.add_argument("--profile", action="store_true")
    args = ap.parse_args()

    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    torch.backends.cudnn.benchmark = True

    print("")
    print("=== PHASE SPLIT (bf16 + channels_last + compile) ===")
    m = build(True, True)
    for label, kw in [("AdamW default", {}),
                      ("AdamW foreach", {"foreach": True}),
                      ("AdamW fused", {"fused": True})]:
        try:
            opt = torch.optim.AdamW(m.parameters(), lr=7e-5, **kw)
            f, b, o, rate = phases(m, opt, args.batch, args.iters)
            print("  %-16s fwd %4.1f%%  bwd %4.1f%%  opt %4.1f%%   %6.1f img/s"
                  % (label, 100 * f, 100 * b, 100 * o, rate))
        except Exception as e:
            print("  %-16s FAIL %s" % (label, str(e)[:40]))

    if args.profile:
        print("")
        print("=== TOP KERNELS by self CUDA time ===")
        from torch.profiler import profile, ProfilerActivity
        opt = torch.optim.AdamW(m.parameters(), lr=7e-5, fused=True)
        x = torch.randn(args.batch, 3, 224, 224, device="cuda")
        y = torch.randn(args.batch, 768, device="cuda")
        y = y / y.norm(dim=-1, keepdim=True)

        def step():
            with torch.amp.autocast("cuda", dtype=torch.bfloat16):
                out = m(x)
                loss = (1 - (out * y).sum(-1)).mean()
            loss.backward()
            opt.step()
            opt.zero_grad(set_to_none=True)

        for _ in range(8):
            step()
        torch.cuda.synchronize()
        with profile(activities=[ProfilerActivity.CUDA], record_shapes=False) as prof:
            for _ in range(6):
                step()
            torch.cuda.synchronize()
        print(prof.key_averages().table(sort_by="self_cuda_time_total", row_limit=18))


if __name__ == "__main__":
    main()
