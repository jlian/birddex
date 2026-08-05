"""Build the preprocessed eval npz that quant_measure.py expects.

quant_measure.py wants {"images": (N,3,224,224) float32, "labels": (N,)}, but
the only cache on disk is the TEACHER embedding cache, which holds paths and
768-d embeddings instead. This script resolves NABirds paths to taxonomy
indices the same way eval_nabirds.py does, then preprocesses the pixels once so
every quantised variant is scored on identical input.

Storing preprocessed pixels rather than re-decoding per variant matters: it
removes decode and resize jitter from the comparison, so any difference between
fp32 and int8 is attributable to quantisation.
"""
import argparse
import json
import os

import numpy as np
import torch
from PIL import Image


def log(m):
    print(m, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--nabirds", default="/home/jlian/data/nabirds")
    ap.add_argument("--nb-map", default="nabirds_to_taxo.json")
    ap.add_argument("--taxonomy", default="taxonomy.json")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    root = args.nabirds
    relpath = {}
    for line in open(os.path.join(root, "images.txt")):
        p = line.split()
        if len(p) >= 2:
            relpath[p[0]] = p[1]
    cls = {}
    for line in open(os.path.join(root, "image_class_labels.txt")):
        p = line.split()
        if len(p) >= 2:
            cls[p[0]] = p[1]
    istest = {}
    for line in open(os.path.join(root, "train_test_split.txt")):
        p = line.split()
        if len(p) >= 2:
            istest[p[0]] = (p[1] == "0")

    nbmap = json.load(open(args.nb_map))
    taxo = json.load(open(args.taxonomy))
    name_to_idx = {}
    for i, t in enumerate(taxo):
        for k in ("scientific", "scientificName", "sci"):
            if isinstance(t, dict) and t.get(k):
                name_to_idx[t[k]] = i
                break

    samples = []
    for iid, rp in relpath.items():
        if not istest.get(iid):
            continue
        c = cls.get(iid)
        if c is None:
            continue
        m = nbmap.get(c) or nbmap.get(str(c))
        if m is None:
            continue
        idx = m if isinstance(m, int) else name_to_idx.get(
            m.get("scientific") if isinstance(m, dict) else m)
        if idx is None:
            continue
        samples.append((os.path.join(root, "images", rp), int(idx)))

    if args.limit:
        samples = samples[:args.limit]
    log("test images resolved: %d" % len(samples))
    if not samples:
        raise SystemExit("no samples resolved; check --nabirds and --nb-map")

    import open_clip
    _, _, pre = open_clip.create_model_and_transforms(
        "ViT-B-16", pretrained=None)

    N = len(samples)
    imgs = np.zeros((N, 3, 224, 224), dtype=np.float32)
    labels = np.zeros(N, dtype=np.int64)
    for i, (p, y) in enumerate(samples):
        imgs[i] = pre(Image.open(p).convert("RGB")).numpy()
        labels[i] = y
        if i % 2000 == 0:
            log("  %d/%d" % (i, N))

    np.savez(args.out, images=imgs, labels=labels)
    log("wrote %s  %.1f MB" % (args.out, os.path.getsize(args.out) / 1e6))


if __name__ == "__main__":
    main()
