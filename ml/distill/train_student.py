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
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--val-frac", type=float, default=0.02)
    ap.add_argument("--out", default="runs/pilot")
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

    rows, nsp = pick_rows(args.train_manifest, args.pilot_species)
    log(f"selected {len(rows):,} images across {nsp} species")

    wanted = {r[0] for r in rows} if (args.pilot_species and args.pilot_species > 0) else None
    emb = load_teacher_embeddings(args.embeddings_dir, wanted)

    student = Student(args.arch, args.pretrained).to(dev)
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

    train_dl = DataLoader(train_ds, batch_size=args.batch, shuffle=True,
                          num_workers=args.workers, collate_fn=collate,
                          pin_memory=True, drop_last=True, persistent_workers=args.workers > 0)
    val_dl = DataLoader(val_ds, batch_size=args.batch, shuffle=False,
                        num_workers=args.workers, collate_fn=collate, pin_memory=True)

    opt = torch.optim.AdamW(student.parameters(), lr=args.lr, weight_decay=args.wd)
    steps = max(1, len(train_dl) * args.epochs)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=steps)
    scaler = torch.cuda.amp.GradScaler(enabled=dev == "cuda")

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

    log(f"train={len(train_ds):,} val={len(val_ds):,} steps/epoch={len(train_dl)}")
    gstep = 0
    LOG_EVERY = 50
    for ep in range(args.epochs):
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
                log(f"  ep{ep+1} step {bi+1}/{len(train_dl)} "
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
        torch.save({"model": student.state_dict(), "args": vars(args), "epoch": ep + 1,
                    "val_cos_sim": val},
                   os.path.join(args.out, "last.pt"))
    log(f"done. checkpoints in {args.out}")


if __name__ == "__main__":
    main()
