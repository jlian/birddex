#!/usr/bin/env python3
"""Ground-truth fine-tune of a distilled student, WiSE-FT style.

WHY THIS EXISTS
---------------
Distillation caps the student at ~teacher: the teacher embedding IS the target,
so you cannot exceed what you copy. To BEAT the teacher on real bird-ID accuracy
we fine-tune on TRUE species labels from photos the distillation never saw
(`build_groundtruth_split.py` -> `pull_images.py`).

THE KEY DESIGN CONSTRAINT
-------------------------
Every eval we have (eval_nabirds.py, eval_heldout.py) scores by
`image_embedding @ text_features.T` against BioCLIP-2's FROZEN text tower. So a
naive fine-tune with a fresh nn.Linear classification head would:
  * silently invalidate every eval,
  * destroy open-vocabulary capability (the whole point of a CLIP student),
  * and break WiSE-FT, which interpolates two checkpoints in the SAME parameter
    space.

Instead we use the frozen text classifier as FIXED class weights: logits are
`logit_scale * student_emb @ text_feats.T`, and cross-entropy trains only the
image tower. Output geometry is unchanged, so every eval stays valid and the
model stays open-vocab.

WiSE-FT (Wortsman et al. 2022, arXiv 2109.01903): naive fine-tuning raises
in-distribution accuracy but degrades OOD robustness. The fix is a post-hoc
weight interpolation, theta = (1-alpha)*distilled + alpha*finetuned. Alpha is
swept AFTER training -- it costs one eval per value, not one run, so there is no
reason to guess it.

Usage:
  # train
  python finetune_groundtruth.py --checkpoint runs/full7555_vitb/best.pt \\
      --gt-manifest groundtruth_heldout.parquet \\
      --gt-corpus ~/wingdex/ml/groundtruth/corpus \\
      --epochs 15 --lr 1e-5 --out runs/ft_full7555

  # then interpolate (cheap, no training)
  python finetune_groundtruth.py --wise-only \\
      --checkpoint runs/full7555_vitb/best.pt \\
      --finetuned runs/ft_full7555/best.pt \\
      --alpha 0.5 --out runs/ft_full7555
"""
import argparse
import json
import os
import time

import duckdb
import numpy as np
import open_clip
import torch
import torch.nn.functional as F
from PIL import Image
from torch.utils.data import DataLoader, Dataset

from train_student import Student, build_train_preprocess, log

TEACHER = "hf-hub:imageomics/bioclip-2"


class GroundTruthDataset(Dataset):
    """(image, class_idx) from the leak-free ground-truth pull."""

    def __init__(self, rows, corpus, preprocess, cls_of_taxon):
        self.rows = rows
        self.corpus = corpus
        self.pp = preprocess
        self.cls_of_taxon = cls_of_taxon

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        pid, tid, ext = self.rows[i]
        path = os.path.join(self.corpus, str(tid), f"{pid}.{ext}")
        try:
            x = self.pp(Image.open(path).convert("RGB"))
        except Exception:
            return None
        return x, self.cls_of_taxon[tid]


def collate(batch):
    batch = [b for b in batch if b is not None]
    if not batch:
        return None, None
    xs, ys = zip(*batch)
    return torch.stack(xs), torch.tensor(ys, dtype=torch.long)


def build_text_classifier(taxo, device, batch=512):
    """BioCLIP-2's frozen text embeddings.

    The prompt template MUST match eval_nabirds.py / eval_heldout.py exactly --
    a different wording yields a different classifier and the fine-tuned model
    would no longer be comparable to any previous number.
    taxonomy.json rows are lists: [common, scientific, code, ..., taxon_id].
    """
    commons = [r[0] for r in taxo]
    scis = [r[1] for r in taxo]
    model, _, _ = open_clip.create_model_and_transforms(TEACHER)
    model = model.to(device).eval()
    tok = open_clip.get_tokenizer(TEACHER)
    feats = []
    with torch.no_grad():
        for i in range(0, len(commons), batch):
            b = [f"a photo of {commons[j]}, {scis[j]}, a species of bird."
                 for j in range(i, min(i + batch, len(commons)))]
            tf = model.encode_text(tok(b).to(device))
            feats.append(F.normalize(tf, dim=-1).float().cpu())
    del model
    torch.cuda.empty_cache()
    out = torch.cat(feats)
    log(f"text classifier {tuple(out.shape)} (frozen BioCLIP-2 text tower, "
        f"eval-matched prompt)")
    return out


def wise_ft(distilled_sd, finetuned_sd, alpha):
    """theta = (1-alpha)*distilled + alpha*finetuned, per Wortsman et al."""
    out = {}
    for k in distilled_sd:
        a, b = distilled_sd[k], finetuned_sd[k]
        if a.dtype.is_floating_point:
            out[k] = (1.0 - alpha) * a + alpha * b
        else:
            out[k] = b
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True,
                    help="distilled student to fine-tune FROM")
    ap.add_argument("--gt-manifest", default="groundtruth_heldout.parquet")
    ap.add_argument("--gt-corpus",
                    default="/home/jlian/wingdex/ml/groundtruth/corpus")
    ap.add_argument("--taxonomy", default="taxonomy.json")
    ap.add_argument("--target-taxa", default="target_taxa.csv",
                    help="authoritative app_idx <-> inat_taxon_id bridge")
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=15)
    ap.add_argument("--lr", type=float, default=1e-5,
                    help="MUCH lower than distillation: we are nudging an "
                         "already-good model, not training one")
    ap.add_argument("--wd", type=float, default=0.1)
    ap.add_argument("--batch", type=int, default=96)
    ap.add_argument("--workers", type=int, default=10)
    ap.add_argument("--warmup", type=int, default=200)
    ap.add_argument("--grad-clip", type=float, default=1.0)
    ap.add_argument("--aug", default="light", choices=["none", "light"])
    ap.add_argument("--val-frac", type=float, default=0.1)
    ap.add_argument("--pilot-species", type=int, default=0,
                    help="0=all; N=top-N species only (cheap iteration)")
    ap.add_argument("--label-smoothing", type=float, default=0.1)
    # WiSE-FT-only mode
    ap.add_argument("--wise-only", action="store_true")
    ap.add_argument("--finetuned", default="")
    ap.add_argument("--alpha", type=float, default=0.5)
    a = ap.parse_args()

    os.makedirs(a.out, exist_ok=True)
    dev = "cuda" if torch.cuda.is_available() else "cpu"

    if a.wise_only:
        d = torch.load(a.checkpoint, map_location="cpu")
        f = torch.load(a.finetuned, map_location="cpu")
        merged = wise_ft(d["model"], f["model"], a.alpha)
        out = {"model": merged, "args": f.get("args", {}),
               "wise_ft_alpha": a.alpha,
               "wise_ft_from": [a.checkpoint, a.finetuned]}
        p = os.path.join(a.out, f"wise_a{a.alpha:.2f}.pt")
        torch.save(out, p)
        log(f"wrote {p} (alpha={a.alpha})")
        return

    taxo_raw = json.load(open(a.taxonomy))
    # taxonomy.json is indexed by APP_IDX (list position), NOT by taxon id --
    # row layout is [common, scientific, code, common2, thumb, wikipedia_id].
    # target_taxa.csv is the authoritative app_idx <-> inat_taxon_id bridge, and
    # nabirds_to_taxo.json likewise maps to POSITIONS. Joining on r[5] silently
    # matches nothing (it is a wikipedia page id).
    bridge = duckdb.connect().execute(
        f"SELECT DISTINCT TRY_CAST(inat_taxon_id AS BIGINT), "
        f"TRY_CAST(app_idx AS BIGINT) "
        f"FROM read_csv('{a.target_taxa}', header=true, all_varchar=true)"
    ).fetchall()
    taxo_all = []
    for tid, idx in bridge:
        if tid is None or idx is None or not (0 <= idx < len(taxo_raw)):
            continue
        taxo_all.append((int(tid), taxo_raw[int(idx)]))
    log(f"taxonomy: {len(taxo_all):,} taxon_id -> app_idx entries "
        f"(via {a.target_taxa})")

    con = duckdb.connect()
    M = f"read_parquet('{a.gt_manifest}')"
    where = "TRUE"
    if a.pilot_species > 0:
        top = con.execute(f"SELECT inat_taxon_id FROM {M} GROUP BY 1 "
                          f"ORDER BY count(*) DESC LIMIT {a.pilot_species}").fetchall()
        where = "inat_taxon_id IN (" + ",".join(str(r[0]) for r in top) + ")"
    rows = con.execute(
        f"SELECT photo_id, inat_taxon_id, extension FROM {M} WHERE {where}").fetchall()
    log(f"ground-truth photos: {len(rows):,}")

    by_taxon = dict(taxo_all)
    present = sorted({int(r[1]) for r in rows if int(r[1]) in by_taxon})
    dropped = len({int(r[1]) for r in rows}) - len(present)
    if dropped:
        log(f"WARNING: {dropped} species in the ground-truth set are missing "
            f"from taxonomy.json and are excluded")
        rows = [r for r in rows if int(r[1]) in by_taxon]
    cls_of_taxon = {t: i for i, t in enumerate(present)}
    sub_taxo = [by_taxon[t] for t in present]
    log(f"classes: {len(present):,} species, {len(rows):,} usable photos")

    text_feats = build_text_classifier(sub_taxo, dev).to(dev)

    ck = torch.load(a.checkpoint, map_location="cpu")
    sd_args = ck.get("args", {})
    arch = sd_args.get("arch", "ViT-B-16")
    pre = sd_args.get("pretrained", "laion2b_s34b_b88k")
    student = Student(arch, pre).to(dev)
    student.load_state_dict(ck["model"])
    log(f"loaded distilled student from {a.checkpoint} "
        f"(val_cos_sim={ck.get('val_cos_sim')})")
    distilled_sd = {k: v.clone() for k, v in ck["model"].items()}

    train_pp = build_train_preprocess(student.preprocess, a.aug)
    rows = [(int(p), int(t), (e or "jpg")) for p, t, e in rows]
    g = torch.Generator().manual_seed(42)
    perm = torch.randperm(len(rows), generator=g).tolist()
    n_val = max(1, int(len(rows) * a.val_frac))
    val_rows = [rows[i] for i in perm[:n_val]]
    tr_rows = [rows[i] for i in perm[n_val:]]
    log(f"train={len(tr_rows):,} val={len(val_rows):,}")

    tr_ds = GroundTruthDataset(tr_rows, a.gt_corpus, train_pp, cls_of_taxon)
    va_ds = GroundTruthDataset(val_rows, a.gt_corpus, student.preprocess, cls_of_taxon)
    tr_dl = DataLoader(tr_ds, batch_size=a.batch, shuffle=True, num_workers=a.workers,
                       collate_fn=collate, pin_memory=True, drop_last=True,
                       persistent_workers=a.workers > 0)
    va_dl = DataLoader(va_ds, batch_size=a.batch, shuffle=False, num_workers=max(1, a.workers // 2),
                       collate_fn=collate, pin_memory=True)

    opt = torch.optim.AdamW(student.parameters(), lr=a.lr, weight_decay=a.wd)
    steps = max(1, len(tr_dl) * a.epochs)
    warm = min(a.warmup, steps - 1)

    def lr_lambda(step):
        if warm and step < warm:
            return (step + 1) / warm
        p = (step - warm) / max(1, steps - warm)
        return 0.5 * (1.0 + np.cos(np.pi * min(1.0, max(0.0, p))))

    sched = torch.optim.lr_scheduler.LambdaLR(opt, lr_lambda)
    scaler = torch.cuda.amp.GradScaler(enabled=dev == "cuda")
    logit_scale = 100.0      # standard CLIP inference scale

    @torch.no_grad()
    def run_val():
        student.eval()
        ok = tot = 0
        for xs, ys in va_dl:
            if xs is None:
                continue
            with torch.cuda.amp.autocast(enabled=dev == "cuda"):
                e = student(xs.to(dev, non_blocking=True))
                pred = (e @ text_feats.T).argmax(-1).cpu()
            ok += (pred == ys).sum().item()
            tot += len(ys)
        student.train()
        return 100.0 * ok / max(1, tot)

    base_acc = run_val()
    log(f"BASELINE (distilled, before fine-tune) val top-1 = {base_acc:.2f}%")

    best = -1.0
    t0 = time.time()
    for ep in range(a.epochs):
        run_loss = seen = 0
        te = time.time()
        for bi, (xs, ys) in enumerate(tr_dl):
            if xs is None:
                continue
            xs = xs.to(dev, non_blocking=True)
            ys = ys.to(dev, non_blocking=True)
            with torch.cuda.amp.autocast(enabled=dev == "cuda"):
                e = student(xs)
                loss = F.cross_entropy(logit_scale * (e @ text_feats.T), ys,
                                       label_smoothing=a.label_smoothing)
            opt.zero_grad(set_to_none=True)
            scaler.scale(loss).backward()
            if a.grad_clip > 0:
                scaler.unscale_(opt)
                torch.nn.utils.clip_grad_norm_(student.parameters(), a.grad_clip)
            prev = scaler.get_scale()
            scaler.step(opt)
            scaler.update()
            if scaler.get_scale() >= prev:
                sched.step()
            run_loss += loss.item() * len(ys)
            seen += len(ys)
            if (bi + 1) % 50 == 0:
                log(f"  ep{ep+1} step {bi+1}/{len(tr_dl)} loss={run_loss/max(1,seen):.4f}")
        acc = run_val()
        log(f"epoch {ep+1}/{a.epochs}  train_loss={run_loss/max(1,seen):.4f}  "
            f"val_top1={acc:.2f}%  (baseline {base_acc:.2f}%)  {time.time()-te:.0f}s")
        ckpt = {"model": student.state_dict(), "args": vars(a), "epoch": ep + 1,
                "val_top1": acc, "baseline_top1": base_acc}
        torch.save(ckpt, os.path.join(a.out, "last.pt"))
        if acc > best:
            best = acc
            torch.save(ckpt, os.path.join(a.out, "best.pt"))
            log(f"  new best val_top1={acc:.2f}% -> best.pt")

    log(f"done. baseline={base_acc:.2f}% best={best:.2f}% "
        f"delta={best-base_acc:+.2f}pts in {(time.time()-t0)/60:.1f} min")
    torch.save({"model": distilled_sd}, os.path.join(a.out, "distilled_ref.pt"))
    log("saved distilled_ref.pt for WiSE-FT interpolation")


if __name__ == "__main__":
    main()
