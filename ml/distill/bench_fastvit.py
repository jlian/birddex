#!/usr/bin/env python
"""FastViT / MobileCLIP-S2 training-speed benchmark (trustworthy version).

WHY THIS EXISTS: the original ~17s/step figure (see ml/README.md) came from a
synthetic micro-bench (torch.randn noise, no dataloader, no cached embeddings, no
warmup) and is almost certainly a measurement artifact: ~3.8 img/s for a 35M model
vs 314 img/s for the 86M ViT-B is physically implausible. This harness measures
steady-state throughput properly so we get a real number.

RUN ONLY WHEN THE GPU IS FREE (not during a training run) -- a contended bench
reproduces the exact thrashing that made 17s bogus.

Two modes:
  (default) synthetic : pure GPU compute (torch.randn), isolates raw fwd+bwd step
            time. Good for "is the ARCH slow", bad for end-to-end (no I/O).
  --real              : reuse train_student.py's ACTUAL dataloader (pick_rows +
            BirdDistillDataset + collate over the cached embedding shards) so the
            number is apples-to-apples vs ViT-B's 314 img/s. Includes JPEG decode
            + resize + embedding lookup, i.e. the true training pipeline.

Lessons baked in:
  - warmup: discard first N steps (compile / cudnn autotune / allocator warmup)
  - cudnn.benchmark=True, tf32 on
  - AMP autocast + GradScaler (matches real training)
  - batch sweep (small batch under-saturates a 3080 -> looks slow; not a bug)
  - synthetic mode tests channels_last BOTH ways: our Jul-22 note said channels_last
    made FastViT WORSE here, contradicting the NHWC-faster-on-Ampere expectation.
    Measure it, don't assume.

Usage:
  python bench_fastvit.py                       # synthetic, batch sweep
  python bench_fastvit.py --real --pilot-species 500 --batches 96 256 512
  python bench_fastvit.py --arch ViT-B-16 --pretrained laion2b_s34b_b88k --real
"""
import argparse
import time

import torch
import torch.nn.functional as F
import open_clip

torch.backends.cuda.matmul.allow_tf32 = True
torch.backends.cudnn.allow_tf32 = True
torch.backends.cudnn.benchmark = True

DEV = "cuda"
TEACHER_DIM = 768


def build_model(arch, pretrained, res):
    model, _, preprocess = open_clip.create_model_and_transforms(arch, pretrained=pretrained)
    v = model.visual.to(DEV).train()
    with torch.no_grad():
        d = v(torch.zeros(1, 3, res, res, device=DEV)).shape[-1]
    proj = torch.nn.Linear(d, TEACHER_DIM).to(DEV)
    return v, proj, preprocess


def train_step(v, proj, opt, scaler, x, tg):
    with torch.amp.autocast("cuda"):
        p = F.normalize(proj(v(x)), dim=-1)
        loss = (1 - (p * tg).sum(-1)).mean()
    opt.zero_grad(set_to_none=True)
    scaler.scale(loss).backward()
    scaler.step(opt)
    scaler.update()
    torch.cuda.synchronize()


def bench_synthetic(arch, pretrained, batch, res, channels_last, warmup, steps):
    v, proj, _ = build_model(arch, pretrained, res)
    if channels_last:
        v = v.to(memory_format=torch.channels_last)
    opt = torch.optim.AdamW(list(v.parameters()) + list(proj.parameters()), lr=1e-4)
    scaler = torch.amp.GradScaler("cuda")
    torch.cuda.reset_peak_memory_stats()

    def step():
        x = torch.randn(batch, 3, res, res, device=DEV)
        if channels_last:
            x = x.to(memory_format=torch.channels_last)
        tg = F.normalize(torch.randn(batch, TEACHER_DIM, device=DEV), dim=-1)
        train_step(v, proj, opt, scaler, x, tg)

    for _ in range(warmup):
        step()
    t0 = time.time()
    for _ in range(steps):
        step()
    dt = time.time() - t0
    return dt / steps, batch * steps / dt, torch.cuda.max_memory_allocated() / 1e9


def bench_real(arch, pretrained, batch, warmup, steps, pilot_species, workers,
               train_manifest, embeddings_dir, corpus):
    # Reuse the EXACT dataloader path from train_student.py for apples-to-apples.
    import train_student as ts
    v, proj, preprocess = build_model(arch, pretrained, 256)
    rows, nsp = ts.pick_rows(train_manifest, pilot_species)
    wanted = {r[0] for r in rows} if (pilot_species and pilot_species > 0) else None
    emb = ts.load_teacher_embeddings(embeddings_dir, wanted)
    ds = ts.BirdDistillDataset(rows, corpus, emb, preprocess)
    dl = torch.utils.data.DataLoader(
        ds, batch_size=batch, shuffle=True, num_workers=workers,
        collate_fn=ts.collate, pin_memory=True, drop_last=True,
        persistent_workers=workers > 0)
    opt = torch.optim.AdamW(list(v.parameters()) + list(proj.parameters()), lr=1e-4)
    scaler = torch.amp.GradScaler("cuda")
    torch.cuda.reset_peak_memory_stats()

    it = iter(dl)
    done = 0
    t0 = None
    seen = 0
    total = warmup + steps
    while done < total:
        try:
            x, tg = next(it)
        except StopIteration:
            it = iter(dl)
            x, tg = next(it)
        if x.shape[0] == 0:
            continue
        x = x.to(DEV, non_blocking=True)
        tg = F.normalize(tg.to(DEV, non_blocking=True), dim=-1)
        train_step(v, proj, opt, scaler, x, tg)
        done += 1
        if done == warmup:
            t0 = time.time()
            seen = 0
        elif done > warmup:
            seen += x.shape[0]
    dt = time.time() - t0
    return dt / steps, seen / dt, torch.cuda.max_memory_allocated() / 1e9


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arch", default="MobileCLIP-S2")
    ap.add_argument("--pretrained", default="datacompdr")
    ap.add_argument("--res", type=int, default=256)  # MobileCLIP-S2 native
    ap.add_argument("--batches", type=int, nargs="+", default=[64, 96, 128, 256, 512])
    ap.add_argument("--warmup", type=int, default=5)
    ap.add_argument("--steps", type=int, default=20)
    ap.add_argument("--real", action="store_true",
                    help="use the real train_student.py dataloader (end-to-end img/s)")
    ap.add_argument("--pilot-species", type=int, default=500)
    ap.add_argument("--workers", type=int, default=10)
    ap.add_argument("--train-manifest", default="train_manifest.parquet")
    ap.add_argument("--embeddings-dir", default="embeddings")
    ap.add_argument("--corpus", default="corpus")
    args = ap.parse_args()

    mode = "REAL dataloader (end-to-end)" if args.real else "SYNTHETIC (raw compute)"
    print(f"arch={args.arch}/{args.pretrained} res={args.res} mode={mode} "
          f"warmup={args.warmup} steps={args.steps}", flush=True)
    print(f"{'batch':>6} {'chan_last':>10} {'s/step':>8} {'img/s':>9} {'peakGB':>7}", flush=True)

    cl_opts = (False,) if args.real else (False, True)
    for cl in cl_opts:
        for b in args.batches:
            try:
                if args.real:
                    sps, imgs, mem = bench_real(
                        args.arch, args.pretrained, b, args.warmup, args.steps,
                        args.pilot_species, args.workers, args.train_manifest,
                        args.embeddings_dir, args.corpus)
                else:
                    sps, imgs, mem = bench_synthetic(
                        args.arch, args.pretrained, b, args.res, cl,
                        args.warmup, args.steps)
                print(f"{b:>6} {str(cl):>10} {sps:>8.3f} {imgs:>9.1f} {mem:>7.2f}", flush=True)
            except RuntimeError as e:
                msg = "OOM" if "out of memory" in str(e).lower() else str(e)[:40]
                print(f"{b:>6} {str(cl):>10} {'--':>8} {'--':>9} {msg:>7}", flush=True)
                torch.cuda.empty_cache()


if __name__ == "__main__":
    main()
