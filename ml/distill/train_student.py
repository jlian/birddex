#!/usr/bin/env python3
"""Phase 3: distill a MobileCLIP student from cached BioCLIP-2 teacher embeddings.

Feature distillation: the frozen BioCLIP-2 ViT-L/14 teacher's 768-d image
embeddings are already cached in embeddings/shard_*.npz (keys: photo_ids,
embeddings). We train a small MobileCLIP image encoder + linear projection to
reproduce those embeddings (cosine loss on L2-normalized vectors). No teacher
forward pass at train time; the student still sees raw pixels each step.

Because the student is trained INTO the teacher's embedding space, the existing
BioCLIP-2 text classifier matrix works on the student unchanged at inference.

Pilot-first: by default trains on the top --pilot-species most-photographed
species (fail fast) before committing to the full corpus.

Usage (smoke test):
  python train_student.py --smoke

Usage (500-species pilot):
  python train_student.py --pilot-species 500 --epochs 30 --out runs/pilot500

Usage (full run):
  python train_student.py --pilot-species 0 --epochs 40 --out runs/full
"""
import argparse
import glob
import os
import time

import numpy as np
import duckdb
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader
from PIL import Image
import open_clip


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def load_teacher_embeddings(emb_dir, wanted_ids=None):
    """Return dict photo_id -> np.float16[768] from all shards.

    If wanted_ids is a set, only keep those (saves RAM for the pilot subset).
    """
    shards = sorted(glob.glob(os.path.join(emb_dir, "shard_*.npz")))
    if not shards:
        raise SystemExit(f"no shards in {emb_dir}")
    table = {}
    for i, s in enumerate(shards):
        d = np.load(s)
        ids = d["photo_ids"]
        embs = d["embeddings"]
        if wanted_ids is not None:
            mask = np.isin(ids, list(wanted_ids))
            ids, embs = ids[mask], embs[mask]
        for pid, e in zip(ids.tolist(), embs):
            table[pid] = e
        if (i + 1) % 50 == 0:
            log(f"  loaded {i+1}/{len(shards)} shards, {len(table):,} embeddings")
    log(f"teacher embeddings loaded: {len(table):,}")
    return table


class BirdDistillDataset(Dataset):
    def __init__(self, rows, corpus_dir, emb_table, preprocess):
        # rows: list of (photo_id, inat_taxon_id, extension)
        self.corpus_dir = corpus_dir
        self.emb = emb_table
        self.preprocess = preprocess
        # derive the preprocess output HxW so the corrupt-image fallback matches
        # (ViT-B/16=224, MobileCLIP-S2=256, etc.) and won't break torch.stack.
        try:
            probe = preprocess(Image.new("RGB", (64, 64)))
            self._chw = tuple(probe.shape)
        except Exception:
            self._chw = (3, 224, 224)
        # keep only rows we have both an image path AND a teacher embedding for
        self.rows = []
        for pid, tid, ext in rows:
            if pid in emb_table:
                self.rows.append((pid, tid, (ext or "jpg")))

    def __len__(self):
        return len(self.rows)

    def _path(self, pid, tid, ext):
        return os.path.join(self.corpus_dir, str(tid), f"{pid}.{ext}")

    def __getitem__(self, idx):
        pid, tid, ext = self.rows[idx]
        path = self._path(pid, tid, ext)
        try:
            img = Image.open(path).convert("RGB")
            x = self.preprocess(img)
        except Exception:
            # missing/corrupt image (e.g. one of the 404 gaps): return a zero
            # sample flagged so the collate can drop it (shape matches preprocess).
            x = torch.zeros(*self._chw)
            return x, torch.zeros(768, dtype=torch.float32), False
        t = torch.from_numpy(self.emb[pid].astype(np.float32))
        return x, t, True


def collate(batch):
    xs, ts, oks = zip(*batch)
    oks = torch.tensor(oks, dtype=torch.bool)
    xs = torch.stack(xs)
    ts = torch.stack(ts)
    return xs[oks], ts[oks]


def build_train_preprocess(eval_preprocess, mode):
    """Train-time transform.

    'none' -> the eval transform (Resize+CenterCrop), i.e. EXACTLY the view the
    teacher was embedded from, so the cached target matches the student input.

    'light' -> RandomResizedCrop(scale 0.65-1.0) + horizontal flip. Deliberately
    milder than MobileCLIP's [0.08, 1.0]: their strong aug is only sound because
    they cache a teacher embedding PER AUGMENTED VIEW. We cache one center-crop
    embedding per image, so an aggressive crop would ask the student to reproduce
    an embedding of content it can no longer see. 0.65 keeps most of the frame.
    """
    from torchvision import transforms as T

    if mode == "none":
        return eval_preprocess

    # reuse the arch's own size + normalization from the eval pipeline
    size, normalize = None, None
    for t in getattr(eval_preprocess, "transforms", []):
        if isinstance(t, T.CenterCrop):
            size = t.size if isinstance(t.size, (tuple, list)) else (t.size, t.size)
        if isinstance(t, T.Normalize):
            normalize = t
    if size is None:
        size = (224, 224)
    if normalize is None:
        raise SystemExit("could not find Normalize in the eval preprocess")

    return T.Compose([
        T.RandomResizedCrop(size, scale=(0.65, 1.0), ratio=(0.85, 1.18),
                            interpolation=T.InterpolationMode.BICUBIC),
        T.RandomHorizontalFlip(),
        T.Lambda(lambda im: im.convert("RGB")),
        T.ToTensor(),
        normalize,
    ])


class Student(nn.Module):
    """MobileCLIP visual tower + projection into the teacher's 768-d space."""

    def __init__(self, arch, pretrained, teacher_dim=768):
        super().__init__()
        model, _, preprocess = open_clip.create_model_and_transforms(
            arch, pretrained=pretrained
        )
        self.visual = model.visual
        self.preprocess = preprocess
        # discover the student's native image embed dim with a dry forward,
        # using the preprocess's own output size (authoritative for this arch:
        # ViT-B/16->224, MobileCLIP-S2->256) so we never feed a wrong shape.
        with torch.no_grad():
            probe = preprocess(Image.new("RGB", (64, 64))).unsqueeze(0)
            feat = self.visual(probe)
        self.student_dim = feat.shape[-1]
        self.proj = (nn.Identity() if self.student_dim == teacher_dim
                     else nn.Linear(self.student_dim, teacher_dim))
        log(f"student dim={self.student_dim} -> teacher dim={teacher_dim} "
            f"({'identity' if self.student_dim == teacher_dim else 'linear proj'})")

    def forward(self, x):
        f = self.visual(x)
        f = self.proj(f)
        return F.normalize(f, dim=-1)


def pick_rows(train_manifest, pilot_species):
    con = duckdb.connect()
    M = f"read_parquet('{train_manifest}')"
    if pilot_species and pilot_species > 0:
        top = con.execute(f"""
            SELECT inat_taxon_id FROM {M}
            GROUP BY 1 ORDER BY count(*) DESC LIMIT {pilot_species}
        """).fetchall()
        ids = [r[0] for r in top]
        where = "inat_taxon_id IN (" + ",".join(str(i) for i in ids) + ")"
    else:
        where = "TRUE"
    rows = con.execute(f"""
        SELECT photo_id, inat_taxon_id, extension FROM {M} WHERE {where}
    """).fetchall()
    nsp = con.execute(f"SELECT count(DISTINCT inat_taxon_id) FROM {M} WHERE {where}").fetchone()[0]
    return rows, nsp


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train-manifest", default="train_manifest.parquet")
    ap.add_argument("--embeddings-dir", default="embeddings")
    ap.add_argument("--corpus", default="corpus")
    ap.add_argument("--arch", default="ViT-B-16")
    ap.add_argument("--pretrained", default="laion2b_s34b_b88k")
    ap.add_argument("--pilot-species", type=int, default=500,
                    help="0 = full corpus; else top-N most-photographed species")
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--wd", type=float, default=0.1)
    ap.add_argument("--beta2", type=float, default=0.999,
                    help="AdamW beta2. MobileCLIP2 uses 0.95 (faster adaptation, "
                         "standard for large-scale CLIP/distillation training)")
    ap.add_argument("--warmup", type=int, default=0,
                    help="linear LR warmup steps (MobileCLIP2 uses ~2k iters). "
                         "0 disables. Prevents the large early updates that a "
                         "cold optimizer + full LR produce")
    ap.add_argument("--grad-clip", type=float, default=0.0,
                    help="clip grad-norm to this value (MobileCLIP2 uses 1.0). "
                         "0 disables")
    ap.add_argument("--min-lr", type=float, default=0.0,
                    help="cosine schedule floor (MobileCLIP2 anneals 1e-3 -> 1e-6, "
                         "i.e. min_lr = lr/1000). 0 = anneal to zero")
    ap.add_argument("--aug", default="none", choices=["none", "light"],
                    help="train-time augmentation. 'none' = the same center-crop "
                         "view the teacher was embedded from (target-matched). "
                         "'light' = RandomResizedCrop(scale 0.65-1.0) + hflip, "
                         "which stays close enough to the cached target to be "
                         "safe. STRONG aug (RRC 0.08-1.0 + RandAugment) is NOT "
                         "offered: our teacher cache has ONE center-crop embedding "
                         "per image, so an aggressive crop would train against a "
                         "target describing content the student cannot see. That "
                         "needs multi-view embedding caching first (SSOT gap #2)")
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--val-frac", type=float, default=0.02)
    ap.add_argument("--patience", type=int, default=3,
                    help="early-stop after N epochs w/o val_cos_sim improvement; 0 disables")
    ap.add_argument("--out", default="runs/pilot")
    ap.add_argument("--resume", default="",
                    help="path to a checkpoint (last.pt) to resume from: restores "
                         "model+optimizer+scheduler+scaler+epoch so training "
                         "continues the SAME LR trajectory (not a warm restart)")
    ap.add_argument("--wds", default="",
                    help="WebDataset mode: shard glob/brace pattern, e.g. "
                         "'/mnt/nas/WingDex-Distill/wds/shard-{00000..00249}.tar'. "
                         "Streams tar shards sequentially instead of opening "
                         "millions of individual corpus files at random.")
    ap.add_argument("--wds-val", default="",
                    help="shard pattern held out for validation (default: last shard)")
    ap.add_argument("--wds-epoch-samples", type=int, default=0,
                    help="samples per epoch in --wds mode (REQUIRED with --wds: an "
                         "IterableDataset has no len(), and the cosine LR schedule "
                         "needs steps/epoch)")
    ap.add_argument("--wds-shuffle", type=int, default=10000,
                    help="within-shard shuffle buffer; shards are packed in taxon "
                         "order so a small buffer gives taxon-correlated batches")
    ap.add_argument("--smoke", action="store_true",
                    help="tiny end-to-end validation: 3 species, 2 steps")
    args = ap.parse_args()

    if args.smoke:
        args.pilot_species = 3
        args.epochs = 1
        args.batch = 32
        args.workers = 4

    os.makedirs(args.out, exist_ok=True)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    if dev == "cuda":
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        torch.backends.cudnn.benchmark = True
    log(f"device={dev} arch={args.arch}/{args.pretrained} "
        f"pilot_species={args.pilot_species} epochs={args.epochs} batch={args.batch}")

    if args.wds:
        # ---- WebDataset path: stream .tar shards (no per-file random opens) ----
        from wds_loader import make_wds_loader
        if not args.wds_epoch_samples:
            raise SystemExit("--wds requires --wds-epoch-samples (IterableDataset "
                             "has no len(), and the cosine LR schedule needs "
                             "steps/epoch)")
        student = Student(args.arch, args.pretrained).to(dev)
        train_pp = build_train_preprocess(student.preprocess, args.aug)
        if args.wds_val:
            # explicit override: caller supplied a separate val shard set
            train_urls, val_urls = args.wds, args.wds_val
            split_frac = 0.0
            log("wds: using explicit --wds-val shard set (no hash split)")
        else:
            # SAME shards for both; train/val separated by a deterministic hash
            # of the sample key. Do NOT hold out a shard: shards are packed in
            # taxon order, so one shard covers only a handful of species
            # (measured: the last pilot shard had 15 of 500), which is not
            # comparable to the original random 2% split and would rank sweep
            # runs on ~3% of the species.
            train_urls = val_urls = sorted(glob.glob(args.wds)) \
                if "*" in args.wds else args.wds
            split_frac = args.val_frac
            log(f"wds: hash-based {split_frac:.1%} val split across ALL shards "
                f"(stratified; covers every species)")
        train_dl = make_wds_loader(train_urls, train_pp, args.batch,
                                   args.workers, shuffle=args.wds_shuffle,
                                   is_train=True,
                                   epoch_samples=args.wds_epoch_samples,
                                   val_frac=split_frac)
        val_samples = max(args.batch, args.wds_epoch_samples // 50)
        val_dl = make_wds_loader(val_urls, student.preprocess, args.batch,
                                 max(1, args.workers // 2), shuffle=0,
                                 is_train=False, epoch_samples=val_samples,
                                 val_frac=split_frac)
        steps_per_epoch = max(1, args.wds_epoch_samples // args.batch)
        log(f"wds mode: {args.wds_epoch_samples:,} samples/epoch -> "
            f"{steps_per_epoch:,} steps/epoch, val~{val_samples:,} samples")
    else:
        rows, nsp = pick_rows(args.train_manifest, args.pilot_species)
        log(f"selected {len(rows):,} images across {nsp} species")

        wanted = {r[0] for r in rows} if (args.pilot_species and args.pilot_species > 0) else None
        emb = load_teacher_embeddings(args.embeddings_dir, wanted)

        student = Student(args.arch, args.pretrained).to(dev)
        train_pp = build_train_preprocess(student.preprocess, args.aug)
        ds = BirdDistillDataset(rows, args.corpus, emb, student.preprocess)
        log(f"dataset usable (img+embedding present): {len(ds):,}")

        n_val = max(1, int(len(ds) * args.val_frac))
        g = torch.Generator().manual_seed(42)
        perm = torch.randperm(len(ds), generator=g).tolist()
        val_idx, train_idx = set(perm[:n_val]), perm[n_val:]
        if args.smoke:
            train_idx = train_idx[:64]
        train_ds = torch.utils.data.Subset(ds, train_idx)
        val_ds = torch.utils.data.Subset(ds, sorted(val_idx))
        if args.aug != "none":
            # train subset gets the augmented view; val keeps the center crop
            train_ds = torch.utils.data.Subset(
                BirdDistillDataset(rows, args.corpus, emb, train_pp), train_idx)

        train_dl = DataLoader(train_ds, batch_size=args.batch, shuffle=True,
                              num_workers=args.workers, collate_fn=collate,
                              pin_memory=True, drop_last=True, persistent_workers=args.workers > 0)
        val_dl = DataLoader(val_ds, batch_size=args.batch, shuffle=False,
                            num_workers=args.workers, collate_fn=collate, pin_memory=True)
        steps_per_epoch = len(train_dl)
        log(f"train={len(train_ds):,} val={len(val_ds):,}")

    opt = torch.optim.AdamW(student.parameters(), lr=args.lr,
                            betas=(0.9, args.beta2), weight_decay=args.wd)
    steps = max(1, steps_per_epoch * args.epochs)
    if args.warmup > 0 or args.min_lr > 0:
        # linear warmup -> cosine decay to min_lr (MobileCLIP2 schedule shape).
        # Implemented as a LambdaLR multiplier on the base LR so warmup and the
        # cosine floor compose correctly.
        import math as _math
        warm = max(0, min(args.warmup, steps - 1))
        floor = (args.min_lr / args.lr) if args.lr > 0 else 0.0

        def _lr_lambda(step):
            if warm and step < warm:
                return (step + 1) / warm
            prog = (step - warm) / max(1, steps - warm)
            prog = min(1.0, max(0.0, prog))
            cos = 0.5 * (1.0 + _math.cos(_math.pi * prog))
            return floor + (1.0 - floor) * cos

        sched = torch.optim.lr_scheduler.LambdaLR(opt, _lr_lambda)
        log(f"schedule: warmup={warm} steps -> cosine to min_lr={args.min_lr:g} "
            f"(floor={floor:.4g}) over {steps:,} steps")
    else:
        sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=steps)
    if args.beta2 != 0.999 or args.grad_clip or args.aug != "none":
        log(f"recipe: beta2={args.beta2} wd={args.wd} grad_clip={args.grad_clip} "
            f"aug={args.aug}")
    scaler = torch.cuda.amp.GradScaler(enabled=dev == "cuda")

    # --- resume: restore full training state so we continue the SAME schedule ---
    start_epoch = 0
    best_val = -1.0
    epochs_since_best = 0
    gstep = 0
    if args.resume:
        if not os.path.exists(args.resume):
            raise SystemExit(f"--resume path not found: {args.resume}")
        ck = torch.load(args.resume, map_location=dev)
        student.load_state_dict(ck["model"])
        if "epochs" in ck and ck.get("epochs") != args.epochs:
            log(f"WARNING: checkpoint was for epochs={ck.get('epochs')} but "
                f"--epochs={args.epochs}; the cosine T_max differs, so the LR "
                f"trajectory will only match if you pass the SAME --epochs.")
        if "opt" in ck and ck["opt"] is not None:
            opt.load_state_dict(ck["opt"])
            sched.load_state_dict(ck["sched"])
            scaler.load_state_dict(ck["scaler"])
            start_epoch = ck.get("epoch", 0)
            best_val = ck.get("best_val", ck.get("val_cos_sim", -1.0))
            epochs_since_best = ck.get("epochs_since_best", 0)
            gstep = ck.get("gstep", start_epoch * steps_per_epoch)
            log(f"resumed FULL state from {args.resume}: start_epoch={start_epoch} "
                f"best_val={best_val:.4f} gstep={gstep} "
                f"lr={sched.get_last_lr()[0]:.2e}")
        else:
            # legacy checkpoint (weights only) -> warm restart, fresh opt/sched
            log(f"WARNING: {args.resume} has no optimizer/scheduler state (legacy "
                f"checkpoint). Loaded WEIGHTS ONLY -> this is a WARM RESTART with a "
                f"fresh LR schedule, not a true resume.")

    def run_val():
        student.eval()
        sims, n = 0.0, 0
        with torch.no_grad():
            for x, t in val_dl:
                if x.numel() == 0:
                    continue
                x, t = x.to(dev, non_blocking=True), t.to(dev, non_blocking=True)
                with torch.cuda.amp.autocast(enabled=dev == "cuda"):
                    p = student(x)
                t = F.normalize(t, dim=-1)
                sims += (p * t).sum(-1).sum().item()
                n += x.shape[0]
        student.train()
        return sims / max(1, n)

    log(f"steps/epoch={steps_per_epoch:,}")
    LOG_EVERY = 50
    for ep in range(start_epoch, args.epochs):
        t0 = time.time()
        run_loss, seen = 0.0, 0
        tstep = time.time()
        for bi, (x, t) in enumerate(train_dl):
            if x.numel() == 0:
                continue
            x, t = x.to(dev, non_blocking=True), t.to(dev, non_blocking=True)
            t = F.normalize(t, dim=-1)
            with torch.cuda.amp.autocast(enabled=dev == "cuda"):
                p = student(x)
                loss = (1 - (p * t).sum(-1)).mean()
            opt.zero_grad(set_to_none=True)
            scaler.scale(loss).backward()
            if args.grad_clip and args.grad_clip > 0:
                # must unscale BEFORE clipping, otherwise we'd clip the
                # loss-scaled gradients and the threshold would be meaningless
                scaler.unscale_(opt)
                torch.nn.utils.clip_grad_norm_(student.parameters(), args.grad_clip)
            prev_scale = scaler.get_scale()
            scaler.step(opt)
            scaler.update()
            # only advance the LR schedule when the optimizer actually stepped
            # (AMP skips the step on inf/nan grads, notably the very first step)
            if scaler.get_scale() >= prev_scale:
                sched.step()
            run_loss += loss.item() * x.shape[0]
            seen += x.shape[0]
            gstep += 1
            if gstep % LOG_EVERY == 0:
                dt = time.time() - tstep
                ips = (LOG_EVERY * x.shape[0]) / max(1e-6, dt)
                log(f"  ep{ep+1} step {bi+1}/{steps_per_epoch} "
                    f"loss={loss.item():.4f} cos={1-loss.item():.4f} "
                    f"{ips:.0f} img/s")
                tstep = time.time()
            if args.smoke and gstep >= 2:
                log(f"SMOKE ok: 2 steps ran, last loss={loss.item():.4f}, "
                    f"cos_sim={1-loss.item():.4f}")
                val = run_val()
                log(f"SMOKE val cos_sim={val:.4f}")
                torch.save({"model": student.state_dict(), "args": vars(args)},
                           os.path.join(args.out, "smoke.pt"))
                log("SMOKE complete; checkpoint saved. Exiting.")
                return
        tr = run_loss / max(1, seen)
        val = run_val()
        dt = time.time() - t0
        log(f"epoch {ep+1}/{args.epochs}  train_loss={tr:.4f}  "
            f"val_cos_sim={val:.4f}  {dt:.0f}s")
        # update best-val bookkeeping BEFORE checkpointing so last.pt captures the
        # post-comparison state (a resume from last.pt keeps correct best tracking)
        improved = val > best_val
        if improved:
            best_val = val
            epochs_since_best = 0
        else:
            epochs_since_best += 1
        # save FULL training state so --resume continues the exact same trajectory
        ckpt = {"model": student.state_dict(), "args": vars(args),
                "epoch": ep + 1, "epochs": args.epochs, "val_cos_sim": val,
                "opt": opt.state_dict(), "sched": sched.state_dict(),
                "scaler": scaler.state_dict(), "gstep": gstep,
                "best_val": best_val, "epochs_since_best": epochs_since_best}
        torch.save(ckpt, os.path.join(args.out, "last.pt"))
        # keep the best-generalizing checkpoint (peak val_cos_sim), not just last
        if improved:
            torch.save(ckpt, os.path.join(args.out, "best.pt"))
            log(f"  new best val_cos_sim={val:.4f} -> best.pt")
        else:
            # early stop: val stopped improving for `patience` epochs (overfitting)
            if args.patience > 0 and epochs_since_best >= args.patience:
                log(f"early stop: no val improvement for {args.patience} epochs "
                    f"(best={best_val:.4f} at epoch {ep+1-epochs_since_best})")
                break
    log(f"done. best val_cos_sim={best_val:.4f}. checkpoints in {args.out}")


if __name__ == "__main__":
    main()
