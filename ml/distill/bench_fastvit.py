#!/usr/bin/env python
"""FastViT / MobileCLIP-S2 training-speed benchmark (trustworthy version).

WHY THIS EXISTS: the original ~17s/step figure (see ml/README.md) came from a
synthetic micro-bench (torch.randn noise, no dataloader, no cached embeddings, no
warmup) and is almost certainly a measurement artifact: ~3.8 img/s for a 35M model
vs 314 img/s for the 86M ViT-B is physically implausible. This harness measures
steady-state throughput properly so we get a real number.

RUN ONLY WHEN THE GPU IS FREE (not during a training run) — a contended bench
reproduces the exact thrashing that made 17s bogus.

Bakes in the lessons:
  - warmup: discard the first N steps (compile / cudnn autotune / allocator warmup)
  - cudnn.benchmark=True, tf32 on
  - AMP autocast + GradScaler (matches real training)
  - batch sweep (small batch under-saturates a 3080 -> looks slow; not a bug)
  - test channels_last BOTH on and off: our Jul-22 note said channels_last made
    FastViT WORSE here, which contradicts the NHWC-is-faster textbook expectation.
    Measure it, don't assume.
  - optional --real to use the actual cached-embedding dataloader for an
    apples-to-apples end-to-end img/s vs ViT-B (default is synthetic-but-clean).

Usage:
  python bench_fastvit.py                      # synthetic, clean, batch sweep
  python bench_fastvit.py --batches 64 96 128 256 512
  python bench_fastvit.py --arch MobileCLIP-S2 --pretrained datacompdr
"""
import argparse, time, torch, open_clip
import torch.nn.functional as F

torch.backends.cuda.matmul.allow_tf32 = True
torch.backends.cudnn.allow_tf32 = True
torch.backends.cudnn.benchmark = True


def bench(arch, pretrained, batch, res, channels_last, warmup, steps, teacher_dim=768):
    dev = "cuda"
    model, _, _ = open_clip.create_model_and_transforms(arch, pretrained=pretrained)
    v = model.visual.to(dev).train()
    # discover student embed dim with a dry forward
    with torch.no_grad():
        d = v(torch.zeros(1, 3, res, res, device=dev)).shape[-1]
    proj = torch.nn.Linear(d, teacher_dim).to(dev)
    if channels_last:
        v = v.to(memory_format=torch.channels_last)
    opt = torch.optim.AdamW(list(v.parameters()) + list(proj.parameters()), lr=1e-4)
    scaler = torch.amp.GradScaler("cuda")

    def one_step():
        x = torch.randn(batch, 3, res, res, device=dev)
        if channels_last:
            x = x.to(memory_format=torch.channels_last)
        tg = F.normalize(torch.randn(batch, teacher_dim, device=dev), dim=-1)
        with torch.amp.autocast("cuda"):
            p = F.normalize(proj(v(x)), dim=-1)
            loss = (1 - (p * tg).sum(-1)).mean()
        opt.zero_grad(set_to_none=True)
        scaler.scale(loss).backward()
        scaler.step(opt)
        scaler.update()
        torch.cuda.synchronize()

    for _ in range(warmup):
        one_step()
    t0 = time.time()
    for _ in range(steps):
        one_step()
    dt = time.time() - t0
    sps = dt / steps
    imgs = batch * steps / dt
    mem = torch.cuda.max_memory_allocated() / 1e9
    torch.cuda.reset_peak_memory_stats()
    return sps, imgs, mem


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arch", default="MobileCLIP-S2")
    ap.add_argument("--pretrained", default="datacompdr")
    ap.add_argument("--res", type=int, default=256)  # MobileCLIP-S2 native
    ap.add_argument("--batches", type=int, nargs="+", default=[64, 96, 128, 256, 512])
    ap.add_argument("--warmup", type=int, default=5)
    ap.add_argument("--steps", type=int, default=15)
    args = ap.parse_args()

    print(f"arch={args.arch}/{args.pretrained} res={args.res} "
          f"warmup={args.warmup} steps={args.steps}", flush=True)
    print(f"{'batch':>6} {'chan_last':>10} {'s/step':>8} {'img/s':>9} {'peakGB':>7}", flush=True)
    for cl in (False, True):
        for b in args.batches:
            try:
                sps, imgs, mem = bench(args.arch, args.pretrained, b, args.res,
                                       cl, args.warmup, args.steps)
                print(f"{b:>6} {str(cl):>10} {sps:>8.3f} {imgs:>9.1f} {mem:>7.2f}", flush=True)
            except RuntimeError as e:
                msg = "OOM" if "out of memory" in str(e).lower() else str(e)[:40]
                print(f"{b:>6} {str(cl):>10} {'--':>8} {'--':>9} {msg:>7}", flush=True)
                torch.cuda.empty_cache()


if __name__ == "__main__":
    main()
