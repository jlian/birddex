#!/usr/bin/env python3
"""Precompute frozen BioCLIP-2 teacher embeddings for the corpus (one-time).

Runs each image through BioCLIP-2 ViT-L/14 once and caches its L2-normalized
768-d image embedding to disk (float16). The student then trains against these
cached targets, so the giant teacher never runs during distillation.

Catch-up friendly: skips images already embedded, so it can run WHILE the
image pull is still going (embedding is GPU-bound, download is network-bound =
free overlap). Re-run periodically / after the pull completes to fill gaps.

Storage: shards of (photo_ids int64, embeddings float16[N,768]) as .npz, plus a
done-set file so re-runs skip finished work. ~2.5M x 768 x 2B ~= 3.8 GB embeddings.

Usage:
  python precompute_embeddings.py --manifest manifest.parquet \
      --corpus ~/spikes/bioclip-birdid/distill/corpus \
      --out ~/spikes/bioclip-birdid/distill/embeddings \
      --batch 256 --shard-size 50000
  python precompute_embeddings.py ... --limit 2000   # smoke test
"""
import argparse
import glob
import os
import time

import numpy as np
import torch
import open_clip
from PIL import Image
import duckdb


def load_done_ids(out_dir):
    done = set()
    for f in glob.glob(os.path.join(out_dir, "shard_*.npz")):
        try:
            d = np.load(f)
            done.update(int(x) for x in d["photo_ids"])
        except Exception:  # noqa: BLE001
            pass
    return done


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--corpus", required=True, help="corpus/ root (taxon_id/photo_id.ext)")
    ap.add_argument("--out", required=True, help="embeddings output dir")
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--shard-size", type=int, default=50000)
    ap.add_argument("--limit", type=int, default=0, help="0=all; smoke test on first N")
    ap.add_argument("--model", default="hf-hub:imageomics/bioclip-2")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"device={dev}", flush=True)

    con = duckdb.connect()
    rows = con.execute(
        f"SELECT photo_id, extension, inat_taxon_id FROM read_parquet('{args.manifest}')"
    ).fetchall()
    if args.limit:
        rows = rows[: args.limit]

    done = load_done_ids(args.out)
    print(f"{len(rows):,} in manifest, {len(done):,} already embedded", flush=True)

    # only images that (a) aren't done and (b) exist on disk (pull may be partial)
    todo = []
    for pid, ext, tid in rows:
        if int(pid) in done:
            continue
        path = os.path.join(args.corpus, str(tid), f"{pid}.{ext}")
        if os.path.exists(path) and os.path.getsize(path) > 0:
            todo.append((int(pid), path))
    print(f"{len(todo):,} images to embed this run", flush=True)
    if not todo:
        print("nothing to do (pull may still be in progress; re-run later)", flush=True)
        return

    model, _, preprocess = open_clip.create_model_and_transforms(args.model)
    model = model.to(dev).eval()

    # next shard index
    existing = glob.glob(os.path.join(args.out, "shard_*.npz"))
    shard_idx = (max((int(os.path.basename(f).split("_")[1].split(".")[0]) for f in existing),
                     default=-1) + 1)

    buf_ids, buf_emb = [], []
    batch_imgs, batch_ids = [], []
    t0 = time.time()
    n_done = 0

    def flush_shard():
        nonlocal shard_idx, buf_ids, buf_emb
        if not buf_ids:
            return
        path = os.path.join(args.out, f"shard_{shard_idx:05d}.npz")
        tmp = path + ".tmp.npz"
        np.savez(tmp, photo_ids=np.array(buf_ids, dtype=np.int64),
                 embeddings=np.concatenate(buf_emb, axis=0).astype(np.float16))
        os.replace(tmp, path)
        print(f"  wrote {path} ({len(buf_ids):,} embeddings)", flush=True)
        shard_idx += 1
        buf_ids, buf_emb = [], []

    def run_batch():
        nonlocal n_done
        if not batch_imgs:
            return
        x = torch.stack(batch_imgs).to(dev)
        with torch.no_grad():
            feats = model.encode_image(x)
            feats = feats / feats.norm(dim=-1, keepdim=True)
        buf_ids.extend(batch_ids)
        buf_emb.append(feats.cpu().numpy())
        n_done += len(batch_ids)
        batch_imgs.clear()
        batch_ids.clear()

    for i, (pid, path) in enumerate(todo):
        try:
            img = preprocess(Image.open(path).convert("RGB"))
        except Exception as e:  # noqa: BLE001
            print(f"  skip {pid}: {e}", flush=True)
            continue
        batch_imgs.append(img)
        batch_ids.append(pid)
        if len(batch_imgs) >= args.batch:
            run_batch()
        if len(buf_ids) >= args.shard_size:
            flush_shard()
        if (i + 1) % 5000 == 0:
            rate = n_done / (time.time() - t0 + 1e-9)
            print(f"  {i+1:,}/{len(todo):,}  embedded={n_done:,}  {rate:.0f} img/s", flush=True)

    run_batch()
    flush_shard()
    rate = n_done / (time.time() - t0 + 1e-9)
    print(f"done: embedded {n_done:,} images @ {rate:.0f} img/s", flush=True)


if __name__ == "__main__":
    main()
