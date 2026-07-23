#!/usr/bin/env python3
"""Out-of-distribution eval: student vs BioCLIP-2 teacher on NABirds.

NABirds is external, expert-labeled North American birds - the real
generalization test (vs the in-distribution held-out corpus eval). Images are
NOT in our training corpus, so teacher embeddings are computed once and CACHED
(nabirds_teacher_cache.npz) so future student re-evals are instant.

Label path: image UUID -> relpath (images.txt) + class id
(image_class_labels.txt) -> taxonomy index (nabirds_to_taxo.json, built by
nabirds_map.py). Scored with the shared BioCLIP-2 text classifier.

By default restricts to the pilot's trained species (--pilot-species 500) for a
fair read (the student only learned those); pass --pilot-species 0 to score all
mapped NABirds species. Uses the test split by default.

Usage:
  python eval_nabirds.py --checkpoint runs/pilot500_vitb/best.pt \
      --nabirds nabirds --pilot-species 500
"""
import argparse
import glob
import json
import os
import time

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
    log(f"text classifier {tuple(torch.cat(feats).shape)}")
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


def load_samples(nabirds, nb_to_taxo, pilot_idx, test_only=True):
    root = nabirds
    # id -> relpath
    relpath = {}
    for line in open(os.path.join(root, "images.txt")):
        i, p = line.split()
        relpath[i] = p
    # id -> class id
    cls = {}
    for line in open(os.path.join(root, "image_class_labels.txt")):
        i, c = line.split()
        cls[i] = int(c)
    # id -> is_train (1) / test (0)
    split = {}
    for line in open(os.path.join(root, "train_test_split.txt")):
        i, s = line.split()
        split[i] = int(s)
    samples = []
    for i, cid in cls.items():
        if test_only and split.get(i, 0) != 0:
            continue
        taxo_idx = nb_to_taxo.get(str(cid))
        if taxo_idx is None:
            continue
        if pilot_idx is not None and taxo_idx not in pilot_idx:
            continue
        samples.append((os.path.join(root, "images", relpath[i]), taxo_idx))
    return samples


def pilot_species_indices(train_manifest, taxo, pilot_species):
    if not pilot_species or pilot_species <= 0:
        return None
    sci_to_idx = {r[1].lower(): i for i, r in enumerate(taxo)}
    con = duckdb.connect()
    M = f"read_parquet('{train_manifest}')"
    top = con.execute(f"SELECT inat_taxon_id FROM {M} GROUP BY 1 "
                      f"ORDER BY count(*) DESC LIMIT {pilot_species}").fetchall()
    ids = [r[0] for r in top]
    rows = con.execute(f"SELECT DISTINCT scientific FROM {M} "
                       f"WHERE inat_taxon_id IN ({','.join(str(i) for i in ids)})").fetchall()
    return {sci_to_idx[s[0].lower()] for s in rows if s[0] and s[0].lower() in sci_to_idx}


def score(E, labs, text_feats, tag):
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--nabirds", default="nabirds")
    ap.add_argument("--nb-map", default="nabirds_to_taxo.json")
    ap.add_argument("--train-manifest", default="train_manifest.parquet")
    ap.add_argument("--taxonomy", default="taxonomy.json")
    ap.add_argument("--pilot-species", type=int, default=500)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--teacher-cache", default="nabirds_teacher_cache.npz")
    ap.add_argument("--out", default="eval_nabirds_results.json")
    args = ap.parse_args()

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    if dev == "cuda":
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
    taxo = json.load(open(args.taxonomy))
    nb_to_taxo = json.load(open(args.nb_map))
    pilot_idx = pilot_species_indices(args.train_manifest, taxo, args.pilot_species)
    log(f"pilot species restriction: {len(pilot_idx) if pilot_idx else 'ALL'}")

    samples = load_samples(args.nabirds, nb_to_taxo, pilot_idx)
    if args.limit:
        samples = samples[:args.limit]
    log(f"NABirds eval samples (test split, mapped, in-species): {len(samples)}")
    if not samples:
        raise SystemExit("no samples; check mapping / pilot-species filter")

    text_feats, teacher = build_text_classifier(taxo, dev)
    student, student_pp = load_student(args.checkpoint, dev)
    _, _, teacher_pp = open_clip.create_model_and_transforms(TEACHER)

    # ---- teacher embeddings: load cache or compute+cache ----
    cache_path = os.path.join(os.path.dirname(args.out) or ".", args.teacher_cache)
    paths = [p for p, _ in samples]
    labs = [l for _, l in samples]
    t_emb = None
    if os.path.exists(cache_path):
        d = np.load(cache_path, allow_pickle=True)
        cached = {p: e for p, e in zip(d["paths"].tolist(), d["embeddings"])}
        if all(p in cached for p in paths):
            t_emb = torch.from_numpy(np.stack([cached[p] for p in paths])).float().to(dev)
            log(f"teacher embeddings from cache: {len(paths)}")

    @torch.no_grad()
    def embed(pp, fn, paths_lst):
        embs, buf, kept = [], [], []
        for p in paths_lst:
            try:
                x = pp(Image.open(p).convert("RGB"))
            except Exception:
                kept.append(False); continue
            buf.append(x); kept.append(True)
            if len(buf) == args.batch:
                embs.append(fn(torch.stack(buf).to(dev)).cpu()); buf = []
        if buf:
            embs.append(fn(torch.stack(buf).to(dev)).cpu())
        return torch.cat(embs), kept

    if t_emb is None:
        log("computing teacher embeddings (will cache)...")
        te, kept = embed(teacher_pp,
                         lambda x: F.normalize(teacher.encode_image(x).float(), dim=-1),
                         paths)
        paths = [p for p, k in zip(paths, kept) if k]
        labs = [l for l, k in zip(labs, kept) if k]
        np.savez(cache_path, paths=np.array(paths, dtype=object),
                 embeddings=te.numpy().astype(np.float16))
        t_emb = te.to(dev)
        log(f"cached teacher embeddings -> {cache_path}")

    rt = score(t_emb, labs, text_feats, "bioclip-2-teacher")
    log("scoring student...")
    se, kept = embed(student_pp, lambda x: student(x), paths)
    s_lab = [l for l, k in zip(labs, kept) if k]
    rs = score(se.to(dev), s_lab, text_feats, "student")

    ret1 = round(100 * rs["top1"] / max(1e-9, rt["top1"]), 1)
    ret5 = round(100 * rs["top5"] / max(1e-9, rt["top5"]), 1)
    rep = {"checkpoint": args.checkpoint, "eval": "nabirds-test-ood",
           "pilot_species": args.pilot_species, "teacher": rt, "student": rs,
           "retention_top1_pct": ret1, "retention_top5_pct": ret5}
    json.dump(rep, open(args.out, "w"), indent=2)
    print("\n" + "=" * 60, flush=True)
    print(f"NABIRDS OOD EVAL ({rt['n']} imgs, {args.pilot_species or 'ALL'} species)", flush=True)
    print(f"  teacher top1/top5: {rt['top1']}/{rt['top5']}", flush=True)
    print(f"  student top1/top5: {rs['top1']}/{rs['top5']}", flush=True)
    print(f"  retention:         top1 {ret1}%  top5 {ret5}%", flush=True)
    print("  student abstention (thr -> cov%, acc%):", flush=True)
    for gg in rs["abstention"]:
        print(f"    {gg['thr']}: cov {gg['coverage']}%  acc {gg['acc_on_kept']}%", flush=True)
    print(f"\nwrote {args.out}", flush=True)


if __name__ == "__main__":
    main()
