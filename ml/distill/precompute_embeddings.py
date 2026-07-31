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

Two image sources:
  --wds     stream WebDataset .tar shards (sequential, NAS-friendly). This is
            the live path: the loose corpus/ was deleted 2026-07-25.
  --corpus  the old loose corpus/<taxon>/<photo_id>.<ext> layout, kept for the
            case where someone re-downloads with pull_images.py.

MULTI-VIEW (--views N): cache N augmented views per image instead of one
center-crop. This is the prerequisite for TRUE strong augmentation. Our student
currently trains against ONE center-crop embedding per image, so an aggressive
RandomResizedCrop would ask it to reproduce an embedding describing content it
cannot see -- a wrong target, not merely harder data. With per-view targets the
crop the student sees matches the embedding it is trained against, which is how
MobileCLIP gets away with scale [0.08, 1.0] + RandAugment.
View 0 is ALWAYS the deterministic center crop, so a --views N cache is a strict
superset of the single-view cache and stays backward compatible.

Usage:
  # single view, from shards (equivalent to the original cache)
  python precompute_embeddings.py --manifest train_manifest.parquet \
      --wds "/mnt/nas/WingDex-Distill/wds/shard-*.tar" \
      --out embeddings --batch 256 --shard-size 50000

  # 5 augmented views per image (~56 GPU-hours over 2.6M images)
  python precompute_embeddings.py ... --views 5 --out embeddings_mv

  python precompute_embeddings.py ... --limit 2000   # smoke test
"""
import argparse
import glob
import io
import os
import tarfile
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


def build_view_transform(preprocess, scale):
    """RandomResizedCrop+flip variant of the teacher's eval preprocess.

    Reuses the teacher's OWN size and normalization so views differ from the
    center crop only in framing, not in colour statistics.
    """
    from torchvision import transforms as T

    size, normalize = None, None
    for t in getattr(preprocess, "transforms", []):
        if isinstance(t, T.CenterCrop):
            size = t.size if isinstance(t.size, (tuple, list)) else (t.size, t.size)
        if isinstance(t, T.Normalize):
            normalize = t
    if size is None:
        size = (224, 224)
    if normalize is None:
        raise SystemExit("could not find Normalize in the teacher preprocess")
    return T.Compose([
        T.RandomResizedCrop(size, scale=tuple(scale),
                            interpolation=T.InterpolationMode.BICUBIC),
        T.RandomHorizontalFlip(),
        T.Lambda(lambda im: im.convert("RGB")),
        T.ToTensor(),
        normalize,
    ])


def iter_shard_images(pattern, wanted=None):
    """Yield (photo_id, PIL.Image) streaming sequentially through .tar shards.

    Sequential is the whole point: the teacher pass reads every image once, so
    streaming shards beats random-accessing 2.6M individual files, especially
    over the NAS.
    """
    shards = sorted(glob.glob(pattern))
    if not shards:
        raise SystemExit(f"no shards matched: {pattern}")
    print(f"streaming {len(shards)} shards", flush=True)
    for sp in shards:
        with tarfile.open(sp, "r|") as t:
            for m in t:
                if not m.isfile() or not m.name.endswith(".jpg"):
                    continue
                try:
                    pid = int(m.name[:-4])
                except ValueError:
                    continue
                if wanted is not None and pid not in wanted:
                    continue
                data = t.extractfile(m).read()
                try:
                    yield pid, Image.open(io.BytesIO(data)).convert("RGB")
                except Exception:
                    continue



class _ShardDecode(torch.utils.data.IterableDataset):
    """Decode+preprocess shard JPEGs in PARALLEL worker processes.

    The original serial generator decoded on the main process, so CPU and
    GPU never overlapped. Measured 24k-image sweep (25 shards):
        0 workers fp32 231 img/s   |   8 workers fp32 362
        0 workers fp16 220        |   8 workers fp16 876  <- best
    Neither lever works alone: workers-only 362, fp16-only 220.

    Whole shards are assigned round-robin to workers, so no two workers
    open the same tar and no sample is emitted twice.
    """

    def __init__(self, shards, wanted, preprocess):
        self.shards = shards
        self.wanted = wanted
        self.pp = preprocess

    def __iter__(self):
        info = torch.utils.data.get_worker_info()
        wid = info.id if info else 0
        nw = info.num_workers if info else 1
        for si, sp in enumerate(self.shards):
            if si % nw != wid:
                continue
            with tarfile.open(sp, "r|") as t:
                for m in t:
                    if not m.isfile() or not m.name.endswith(".jpg"):
                        continue
                    try:
                        pid = int(m.name[:-4])
                    except ValueError:
                        continue
                    if self.wanted is not None and pid not in self.wanted:
                        continue
                    try:
                        img = Image.open(io.BytesIO(
                            t.extractfile(m).read())).convert("RGB")
                        yield pid, self.pp(img)
                    except Exception:
                        continue


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--corpus", default="",
                    help="loose corpus/ root (taxon_id/photo_id.ext). Deleted on "
                         "2026-07-25; use --wds instead unless you re-downloaded")
    ap.add_argument("--wds", default="",
                    help="WebDataset shard glob, e.g. "
                         "'/mnt/nas/WingDex-Distill/wds/shard-*.tar'. Streams "
                         "shards sequentially instead of doing millions of "
                         "random small-file opens")
    ap.add_argument("--views", type=int, default=1,
                    help="augmented views to cache per image. 1 = center crop "
                         "only (default, matches the original cache). N>1 caches "
                         "view 0 as the center crop plus N-1 RandomResizedCrop+"
                         "flip views, which is what TRUE strong aug needs")
    ap.add_argument("--view-scale", type=float, nargs=2, default=(0.08, 1.0),
                    help="RandomResizedCrop scale range for views 1..N-1. The "
                         "MobileCLIP value is 0.08 1.0; safe here precisely "
                         "BECAUSE each view gets its own teacher target")
    ap.add_argument("--out", required=True, help="embeddings output dir")
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--workers", type=int, default=8,
                    help="parallel decode workers; 8 measured best on a 16-core box (876 img/s with --fp16 vs 144 serial fp32). 0 = old serial path")
    ap.add_argument("--fp16", action="store_true", default=True,
                    help="run the teacher under autocast fp16. FREE on accuracy: the quantisation sweep measured 0.00 top-1 delta on NABirds")
    ap.add_argument("--no-fp16", dest="fp16", action="store_false")
    ap.add_argument("--shard-size", type=int, default=50000)
    ap.add_argument("--limit", type=int, default=0, help="0=all; smoke test on first N")
    ap.add_argument("--model", default="hf-hub:imageomics/bioclip-2")
    args = ap.parse_args()

    if bool(args.wds) == bool(args.corpus):
        raise SystemExit("give exactly one of --wds or --corpus")
    if args.views < 1:
        raise SystemExit("--views must be >= 1")

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

    todo = []
    want_ids = None
    if args.wds:
        # shards carry the images; just say which photo_ids still need embedding
        want_ids = {int(pid) for pid, _, _ in rows if int(pid) not in done}
        print(f"{len(want_ids):,} images to embed this run (from shards)", flush=True)
        if not want_ids:
            print("nothing to do", flush=True)
            return
    else:
        # only images that (a) aren't done and (b) exist on disk (pull may be partial)
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

    # Teacher can be either an open_clip hub model (BioCLIP-2, the original)
    # or a local WingCLIP Student checkpoint. The latter enables SEQUENTIAL
    # distillation: WingCLIP-0.1 scores 89.93 on NABirds vs BioCLIP-2
    # 86.41, so it is the stronger teacher for this domain.
    if args.model.endswith(".pt"):
        import sys
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from train_student import Student
        ck = torch.load(args.model, map_location="cpu")
        ca = ck.get("args", {})
        st = Student(ca.get("arch", "ViT-B-16"),
                     ca.get("pretrained", "laion2b_s34b_b88k"))
        st.load_state_dict(ck["model"])
        model = st.to(dev).eval()
        preprocess = st.preprocess
        # Student.forward is already visual -> proj -> normalize, so the
        # output is L2-normalised 768-d, same contract as encode_image
        # followed by the normalise below.
        model.encode_image = model.forward
        print("teacher = WingCLIP checkpoint " + args.model, flush=True)
    else:
        model, _, preprocess = open_clip.create_model_and_transforms(args.model)
        model = model.to(dev).eval()
        print("teacher = open_clip " + args.model, flush=True)

    # next shard index
    existing = glob.glob(os.path.join(args.out, "shard_*.npz"))
    shard_idx = (max((int(os.path.basename(f).split("_")[1].split(".")[0]) for f in existing),
                     default=-1) + 1)

    buf_ids, buf_emb, buf_views = [], [], []
    batch_imgs, batch_ids, batch_views = [], [], []
    t0 = time.time()
    n_done = 0

    def flush_shard():
        nonlocal shard_idx, buf_ids, buf_emb, buf_views
        if not buf_ids:
            return
        path = os.path.join(args.out, f"shard_{shard_idx:05d}.npz")
        tmp = path + ".tmp.npz"
        payload = dict(photo_ids=np.array(buf_ids, dtype=np.int64),
                       embeddings=np.concatenate(buf_emb, axis=0).astype(np.float16))
        if args.views > 1:
            # only written for multi-view caches, so single-view .npz files stay
            # byte-compatible with every existing reader
            payload["views"] = np.array(buf_views, dtype=np.int16)
        np.savez(tmp, **payload)
        os.replace(tmp, path)
        print(f"  wrote {path} ({len(buf_ids):,} embeddings)", flush=True)
        shard_idx += 1
        buf_ids, buf_emb, buf_views = [], [], []

    def run_batch():
        nonlocal n_done
        if not batch_imgs:
            return
        x = torch.stack(batch_imgs).to(dev, non_blocking=True)
        with torch.no_grad():
            if args.fp16 and dev == "cuda":
                with torch.autocast("cuda", dtype=torch.float16):
                    feats = model.encode_image(x)
                feats = feats.float()
            else:
                feats = model.encode_image(x)
            feats = feats / feats.norm(dim=-1, keepdim=True)
        buf_ids.extend(batch_ids)
        buf_views.extend(batch_views)
        buf_emb.append(feats.cpu().numpy())
        n_done += len(batch_ids)
        batch_imgs.clear()
        batch_ids.clear()
        batch_views.clear()

    view_tf = (build_view_transform(preprocess, args.view_scale)
               if args.views > 1 else None)
    if args.views > 1:
        print(f"multi-view: {args.views} views/image "
              f"(view 0 = center crop, 1..{args.views-1} = RRC scale "
              f"{tuple(args.view_scale)} + flip)", flush=True)

    # Parallel decode is only valid for SINGLE-view wds mode: multi-view needs
    # the raw PIL image to apply a different transform per view.
    parallel = bool(args.wds) and args.workers > 0 and args.views == 1
    if parallel:
        shards = sorted(glob.glob(args.wds))
        if not shards:
            raise SystemExit(f"no shards matched: {args.wds}")
        print("streaming " + str(len(shards)) + " shards, " +
              str(args.workers) + " decode workers, fp16=" +
              str(args.fp16), flush=True)
        ds = _ShardDecode(shards, want_ids, preprocess)
        # batch INSIDE the loader: with batch_size=None every image pays a
        # separate IPC round trip and throughput collapses to ~174 img/s
        # even with 8 workers. Batched transfers hit ~876.
        dl = torch.utils.data.DataLoader(
            ds, batch_size=args.batch, num_workers=args.workers,
            pin_memory=True, prefetch_factor=4,
            collate_fn=lambda b: ([p for p, _ in b],
                                  torch.stack([x for _, x in b])))
        source = dl
    elif args.wds:
        source = iter_shard_images(args.wds, wanted=want_ids)
    else:
        source = ((pid, Image.open(path).convert("RGB")) for pid, path in todo)

    if parallel:
        # loader yields (ids, stacked_tensor) already preprocessed
        i = 0
        for pids, xb in source:
            batch_imgs.extend(xb)
            batch_ids.extend(pids)
            batch_views.extend([0] * len(pids))
            i += len(pids)
            while len(batch_imgs) >= args.batch:
                run_batch()
            if len(buf_ids) >= args.shard_size:
                flush_shard()
            if i % 20000 < len(pids):
                rate = n_done / (time.time() - t0 + 1e-9)
                print("  " + format(i, ",") + " images  embedded=" +
                      format(n_done, ",") + "  " +
                      "{:.0f} emb/s".format(rate), flush=True)
        run_batch()
        flush_shard()
        rate = n_done / (time.time() - t0 + 1e-9)
        print("done: embedded " + format(n_done, ",") +
              " images @ " + "{:.0f} img/s".format(rate),
              flush=True)
        return

    for i, item in enumerate(source):
        try:
            pid, img = item
        except Exception as e:  # noqa: BLE001
            print(f"  skip (unpack): {e}", flush=True)
            continue
        try:
            for v in range(args.views):
                # in parallel mode the worker already ran preprocess
                tf = (None if parallel else
                      (preprocess if v == 0 else view_tf))
                batch_imgs.append(img if tf is None else tf(img))
                batch_ids.append(pid)
                batch_views.append(v)
                if len(batch_imgs) >= args.batch:
                    run_batch()
        except Exception as e:  # noqa: BLE001
            print(f"  skip {pid}: {e}", flush=True)
            continue
        if len(buf_ids) >= args.shard_size:
            flush_shard()
        if (i + 1) % 5000 == 0:
            rate = n_done / (time.time() - t0 + 1e-9)
            print(f"  {i+1:,} images  embedded={n_done:,}  {rate:.0f} emb/s", flush=True)

    run_batch()
    flush_shard()
    rate = n_done / (time.time() - t0 + 1e-9)
    print(f"done: embedded {n_done:,} images @ {rate:.0f} img/s", flush=True)


if __name__ == "__main__":
    main()
