#!/usr/bin/env python3
"""Option-3 eval: student vs teacher on a held-out slice of our OWN corpus.

Zero external data / no taxonomy mapping needed: we already have the images,
the cached teacher embeddings, and exact per-image species labels (inat_taxon_id
-> our taxonomy index via scientific name). This answers the core retention
question on IN-DISTRIBUTION birds:

  Given the SAME BioCLIP-2 text classifier, how close is the student's top-1/5
  species accuracy to the teacher's, on images the student did NOT train on?

Honest caveat: in-distribution, so it flatters the student vs a true external
benchmark (NABirds/CUB). Use it as the fast first signal, not the final word.

We reconstruct the pilot's exact train/val split (same seed=42, same
pilot-species) and evaluate ONLY on the held-out val rows, so nothing here was
seen during training.

Usage:
  python eval_heldout.py --checkpoint runs/pilot500_vitb/last.pt \
      --pilot-species 500 --limit 4000
"""
import argparse
import hashlib
import json
import os
import time

import glob
import io
import tarfile

import numpy as np
import torch
import torch.nn.functional as F
import open_clip
from PIL import Image
import duckdb

TEACHER = "hf-hub:imageomics/bioclip-2"


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


def build_text_classifier(taxo, device, batch=512):
    commons = [r[0] for r in taxo]
    scis = [r[1] for r in taxo]
    model, _, _ = open_clip.create_model_and_transforms(TEACHER)
    tok = open_clip.get_tokenizer(TEACHER)
    model = model.to(device).eval()
    feats = []
    with torch.no_grad():
        for i in range(0, len(commons), batch):
            b = [f"a photo of {commons[j]}, {scis[j]}, a species of bird."
                 for j in range(i, min(i + batch, len(commons)))]
            tf = model.encode_text(tok(b).to(device))
            tf = tf / tf.norm(dim=-1, keepdim=True)
            feats.append(tf.float().cpu())
    log(f"text classifier {tuple(torch.cat(feats).shape)} over {len(commons)} species")
    return torch.cat(feats).to(device), model


def load_student(checkpoint, device):
    import sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from train_student import Student
    ckpt = torch.load(checkpoint, map_location="cpu")
    a = ckpt.get("args", {})
    st = Student(a.get("arch", "ViT-B-16"), a.get("pretrained", "laion2b_s34b_b88k"))
    st.load_state_dict(ckpt["model"])
    st = st.to(device).eval()
    log(f"student {a.get('arch')} epoch {ckpt.get('epoch','?')} "
        f"val_cos_sim={ckpt.get('val_cos_sim','?')}")
    return st, st.preprocess


def pick_heldout_rows(train_manifest, corpus, taxo, pilot_species,
                      val_frac=0.02, seed=42, split="legacy"):
    """Rows the model did NOT train on.

    Two split modes, and picking the WRONG one silently evaluates on training
    data:

    * split="legacy" -- reproduces the ORIGINAL local-corpus split: a seeded
      torch.randperm over usable rows, first n_val = val. Correct for
      checkpoints trained from `corpus/` (the pre-WebDataset runs).
    * split="hash"   -- the deterministic blake2b split used by the WebDataset
      loader (see wds_loader._in_val). Correct for every checkpoint trained via
      --wds, i.e. everything from 2026-07-24 onward.
    """
    sci_to_idx = {r[1].lower(): i for i, r in enumerate(taxo)}
    con = duckdb.connect()
    M = f"read_parquet('{train_manifest}')"
    if pilot_species and pilot_species > 0:
        top = con.execute(f"SELECT inat_taxon_id FROM {M} GROUP BY 1 "
                          f"ORDER BY count(*) DESC LIMIT {pilot_species}").fetchall()
        ids = [r[0] for r in top]
        where = "inat_taxon_id IN (" + ",".join(str(i) for i in ids) + ")"
    else:
        where = "TRUE"
    rows = con.execute(f"SELECT photo_id, inat_taxon_id, extension, scientific "
                       f"FROM {M} WHERE {where}").fetchall()
    usable = []
    for pid, tid, ext, sci in rows:
        if sci and sci.lower() in sci_to_idx:
            usable.append((pid, tid, (ext or "jpg"), sci_to_idx[sci.lower()]))

    if split == "obs":
        # observation-grouped split: hash the OBSERVATION uuid so all photos of
        # one bird-sighting land on the SAME side. This is the SSOT's hard
        # leakage requirement for the ground-truth eval. Measured 2026-07-25 on
        # the pilot: photo-id hashing split 2,762 observations across train/val;
        # observation hashing splits 0. NOTE this only RELABELS which photos are
        # val -- it is a partition, so the training set size is unchanged
        # (242,419 -> 242,375 of 247,434, a 0.02% shuffle).
        import hashlib
        con2 = duckdb.connect()
        obs_of = dict(con2.execute(
            f"SELECT photo_id, observation_uuid FROM {M} WHERE {where}").fetchall())

        def _obs_in_val(pid):
            obs = obs_of.get(pid)
            key = obs if obs else f"photo:{pid}"
            h = hashlib.blake2b(f"{seed}:{key}".encode(), digest_size=8).digest()
            return (int.from_bytes(h, "big") % 1_000_000) < int(val_frac * 1_000_000)

        val = [r for r in usable if _obs_in_val(r[0])]
        n_obs = len({obs_of.get(r[0]) for r in val if obs_of.get(r[0])})
        log(f"observation-grouped split: {len(val):,} held-out photos across "
            f"{n_obs:,} observations (of {len(usable):,} total)")
        return val

    if split == "hash":
        from wds_loader import _in_val
        val = [r for r in usable if _in_val(str(r[0]), val_frac, seed)]
        log(f"hash split: {len(val):,} held-out of {len(usable):,}")
        log("  NOTE: photo-id hashing leaks across observations -- 56.5% of these "
            "val photos share an observation with a training photo. Use "
            "--split obs for the leak-free number.")
        return val

    g = torch.Generator().manual_seed(seed)
    perm = torch.randperm(len(usable), generator=g).tolist()
    n_val = max(1, int(len(usable) * val_frac))
    val = [usable[i] for i in perm[:n_val]]
    log(f"legacy split: {len(val):,} held-out of {len(usable):,}")
    return val


class ShardImageSource:
    """Read images by photo_id out of WebDataset .tar shards.

    Builds a photo_id -> (shard, offset) index once, then random-accesses
    members on demand. Lets the held-out eval keep working after the loose
    `corpus/` directory is deleted.

    The index is CACHED to disk: building it means walking every tar header,
    which on the 251-shard main set over CIFS is minutes of I/O. The cache key
    includes the shard list + mtimes + sizes, so it self-invalidates if the
    shards are ever repacked.
    """

    def __init__(self, pattern, wanted=None, cache_dir=None):
        shards = sorted(glob.glob(pattern))
        if not shards:
            raise SystemExit(f"no shards matched: {pattern}")

        sig = hashlib.blake2b(
            "|".join(f"{p}:{os.path.getmtime(p)}:{os.path.getsize(p)}"
                     for p in shards).encode(), digest_size=8).hexdigest()
        cdir = cache_dir or os.path.dirname(shards[0])
        if not os.access(cdir, os.W_OK):
            cdir = "/tmp"
        cache = os.path.join(cdir, f".shardindex-{sig}.json")

        if os.path.exists(cache):
            with open(cache) as f:
                raw = json.load(f)
            self.index = {int(k): (v[0], v[1]) for k, v in raw.items()}
            log(f"loaded shard index from cache ({len(self.index):,} images)")
        else:
            self.index = {}
            log(f"indexing {len(shards)} shards (one-time, then cached)...")
            for n, sp in enumerate(shards, 1):
                with tarfile.open(sp, "r") as t:
                    for m in t:
                        if not m.isfile() or not m.name.endswith(".jpg"):
                            continue
                        try:
                            pid = int(m.name[:-4])
                        except ValueError:
                            continue
                        self.index[pid] = (sp, m.offset)
                if n % 25 == 0:
                    log(f"  ...{n}/{len(shards)} shards, {len(self.index):,} images")
            try:
                with open(cache, "w") as f:
                    json.dump({str(k): list(v) for k, v in self.index.items()}, f)
                log(f"cached shard index -> {cache}")
            except Exception as e:
                log(f"(could not cache shard index: {e})")
        self._open = {}

    def get(self, pid):
        hit = self.index.get(int(pid))
        if hit is None:
            return None
        sp, off = hit
        t = self._open.get(sp)
        if t is None:
            t = tarfile.open(sp, "r")
            self._open[sp] = t
        t.fileobj.seek(off)
        m = tarfile.TarInfo.fromtarfile(t)
        return t.extractfile(m).read()

    def close(self):
        for t in self._open.values():
            try:
                t.close()
            except Exception:
                pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--train-manifest", default="train_manifest.parquet")
    ap.add_argument("--corpus", default="corpus",
                    help="loose image dir; ignored when --wds is given")
    ap.add_argument("--wds", default="",
                    help="read images from WebDataset shards instead of a loose "
                         "corpus/ dir, e.g. "
                         "'/mnt/nas/WingDex-Distill/wds-pilot500/shard-*.tar'. "
                         "Lets this eval keep working after corpus/ is deleted")
    ap.add_argument("--split", default="auto", choices=["auto", "legacy", "hash", "obs"],
                    help="which held-out split to reconstruct. 'legacy' = the "
                         "seeded randperm used by local-corpus runs; 'hash' = the "
                         "blake2b photo-id split used by --wds runs; 'obs' = the "
                         "same hash applied to observation_uuid so all photos of "
                         "one sighting stay on one side (leak-free, and what the "
                         "SSOT requires for a ground-truth eval). 'auto' picks "
                         "obs when --wds is given, else legacy. Getting this "
                         "WRONG silently evaluates on training data")
    ap.add_argument("--embeddings-dir", default="embeddings",
                    help="cached teacher embedding shards (shard_*.npz); avoids "
                         "re-running the teacher image encoder")
    ap.add_argument("--taxonomy", default="taxonomy.json")
    ap.add_argument("--pilot-species", type=int, default=500)
    ap.add_argument("--limit", type=int, default=4000)
    ap.add_argument("--batch", type=int, default=96)
    ap.add_argument("--out", default="eval_heldout_results.json")
    args = ap.parse_args()

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    if dev == "cuda":
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
    taxo = json.load(open(args.taxonomy))
    text_feats, teacher = build_text_classifier(taxo, dev)
    student, student_pp = load_student(args.checkpoint, dev)

    split_mode = args.split
    if split_mode == "auto":
        split_mode = "obs" if args.wds else "legacy"
        log(f"--split auto -> {split_mode}")
    val = pick_heldout_rows(args.train_manifest, args.corpus, taxo,
                            args.pilot_species, split=split_mode)
    if args.limit:
        val = val[:args.limit]
    log(f"held-out val samples: {len(val)}")

    # image source: WebDataset shards (survives corpus/ deletion) or loose dir
    src = None
    if args.wds:
        src = ShardImageSource(args.wds, wanted={pid for pid, _, _, _ in val})

    # ---- teacher: use CACHED embeddings (lookup by photo_id), no teacher fwd ----
    import glob
    want_ids = {pid for pid, _, _, _ in val}
    cache = {}
    shards = sorted(glob.glob(os.path.join(args.embeddings_dir, "shard_*.npz")))
    for s in shards:
        d = np.load(s)
        ids, embs = d["photo_ids"], d["embeddings"]
        mask = np.isin(ids, list(want_ids))
        for pid, e in zip(ids[mask].tolist(), embs[mask]):
            cache[pid] = e
    log(f"cached teacher embeddings found: {len(cache)}/{len(want_ids)}")

    def score_arr(E, labs, tag):
        E = torch.from_numpy(np.stack(E)).float().to(dev)
        E = F.normalize(E, dim=-1)
        sims = E @ text_feats.T
        conf = (sims * 100).softmax(-1).max(-1).values.cpu().numpy()
        top5 = sims.topk(5, -1).indices.cpu().numpy()
        lab = np.array(labs)
        ok1 = top5[:, 0] == lab
        ok5 = (top5 == lab[:, None]).any(1)
        gated = []
        for thr in [0.0, 0.3, 0.5, 0.7, 0.9]:
            keep = conf >= thr
            gated.append({"thr": thr, "coverage": round(100 * keep.mean(), 1),
                          "acc_on_kept": round(100 * ok1[keep].mean(), 2) if keep.any() else 0.0})
        return {"model": tag, "n": int(len(lab)),
                "top1": round(100 * ok1.mean(), 2), "top5": round(100 * ok5.mean(), 2),
                "abstention": gated}

    @torch.no_grad()
    def run_student():
        embs, labs, buf, blab = [], [], [], []
        for pid, tid, ext, lab in val:
            try:
                if src is not None:
                    raw = src.get(pid)
                    if raw is None:
                        continue
                    img = Image.open(io.BytesIO(raw))
                else:
                    img = Image.open(os.path.join(args.corpus, str(tid), f"{pid}.{ext}"))
                x = student_pp(img.convert("RGB"))
            except Exception:
                continue
            buf.append(x); blab.append(lab)
            if len(buf) == args.batch:
                embs.append(student(torch.stack(buf).to(dev)).cpu()); labs += blab
                buf, blab = [], []
        if buf:
            embs.append(student(torch.stack(buf).to(dev)).cpu()); labs += blab
        E = torch.cat(embs).to(dev)
        sims = E @ text_feats.T
        conf = (sims * 100).softmax(-1).max(-1).values.cpu().numpy()
        top5 = sims.topk(5, -1).indices.cpu().numpy()
        lab = np.array(labs)
        ok1 = top5[:, 0] == lab
        ok5 = (top5 == lab[:, None]).any(1)
        gated = []
        for thr in [0.0, 0.3, 0.5, 0.7, 0.9]:
            keep = conf >= thr
            gated.append({"thr": thr, "coverage": round(100 * keep.mean(), 1),
                          "acc_on_kept": round(100 * ok1[keep].mean(), 2) if keep.any() else 0.0})
        return {"model": "student", "n": int(len(lab)),
                "top1": round(100 * ok1.mean(), 2), "top5": round(100 * ok5.mean(), 2),
                "abstention": gated}

    log("scoring teacher (from cache)...")
    t_emb = [cache[pid] for pid, _, _, _ in val if pid in cache]
    t_lab = [lab for pid, _, _, lab in val if pid in cache]
    rt = score_arr(t_emb, t_lab, "bioclip-2-teacher")
    log("scoring student...")
    rs = run_student()
    ret1 = round(100 * rs["top1"] / max(1e-9, rt["top1"]), 1)
    ret5 = round(100 * rs["top5"] / max(1e-9, rt["top5"]), 1)
    rep = {"checkpoint": args.checkpoint, "eval": "heldout-corpus-val",
           "teacher": rt, "student": rs,
           "retention_top1_pct": ret1, "retention_top5_pct": ret5}
    json.dump(rep, open(args.out, "w"), indent=2)
    print("\n" + "=" * 60, flush=True)
    print(f"HELD-OUT CORPUS EVAL ({rt['n']} imgs, {args.pilot_species} species)", flush=True)
    print(f"  teacher top1/top5: {rt['top1']}/{rt['top5']}", flush=True)
    print(f"  student top1/top5: {rs['top1']}/{rs['top5']}", flush=True)
    print(f"  retention:         top1 {ret1}%  top5 {ret5}%", flush=True)
    print("  student abstention (thr -> cov%, acc-on-kept%):", flush=True)
    for gg in rs["abstention"]:
        print(f"    {gg['thr']}: cov {gg['coverage']}%  acc {gg['acc_on_kept']}%", flush=True)
    print(f"\nwrote {args.out}", flush=True)


if __name__ == "__main__":
    main()
