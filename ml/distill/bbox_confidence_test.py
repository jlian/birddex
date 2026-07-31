#!/usr/bin/env python3
"""NEXT-5a: is the softmax gate actually a small-bird detector?

CLAIM UNDER TEST (written as DESIGN INTENT in the detection section, never
validated): "softmax_top1 < ~0.6 flags ambiguous/multi/small".

If low confidence really means "the bird is small or badly framed", then the
existing gate can drive the crop prompt and no detector is needed. If low
confidence is mostly SPECIES AMBIGUITY, then asking the user to crop will not
help and crop-prompting needs a real signal (iOS Vision, ViT patch saliency,
or multi-crop consistency).

NABirds ships bounding_boxes.txt (x y w h) and sizes.txt (width height) for
all 48,562 images, so relative bird area is ground truth.

Reports Pearson + Spearman between relative bird area and top-1 confidence,
and accuracy/confidence bucketed by area. Spearman matters more here since
the relationship need not be linear.
"""
import argparse
import os
import sys
import time

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

TEACHER = "hf-hub:imageomics/bioclip-2"


def log(m):
    print("[" + time.strftime("%H:%M:%S") + "] " + str(m), flush=True)


def load_student(ckpt, distill_dir, device):
    sys.path.insert(0, distill_dir)
    from train_student import Student
    ck = torch.load(ckpt, map_location="cpu")
    ar = ck.get("args", {})
    st = Student(ar.get("arch", "ViT-B-16"),
                 ar.get("pretrained", "laion2b_s34b_b88k"))
    st.load_state_dict(ck["model"])
    return st.to(device).eval(), st.preprocess


def build_text(taxonomy, device):
    import json
    import open_clip
    taxo = json.load(open(taxonomy))
    commons = [r[0] for r in taxo]
    scis = [r[1] for r in taxo]
    m, _, _ = open_clip.create_model_and_transforms(TEACHER)
    tok = open_clip.get_tokenizer(TEACHER)
    m = m.to(device).eval()
    out = []
    with torch.no_grad():
        for i in range(0, len(commons), 512):
            j = min(i + 512, len(commons))
            b = ["a photo of " + commons[k] + ", " + scis[k] +
                 ", a species of bird." for k in range(i, j)]
            e = m.encode_text(tok(b).to(device))
            e = e / e.norm(dim=-1, keepdim=True)
            out.append(e.float().cpu())
    t = torch.cat(out).to(device)
    del m
    torch.cuda.empty_cache()
    return t


def spearman(x, y):
    rx = np.argsort(np.argsort(x)).astype(np.float64)
    ry = np.argsort(np.argsort(y)).astype(np.float64)
    rx = (rx - rx.mean()) / (rx.std() + 1e-12)
    ry = (ry - ry.mean()) / (ry.std() + 1e-12)
    return float((rx * ry).mean())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--taxonomy", required=True)
    ap.add_argument("--nabirds", required=True)
    ap.add_argument("--temperature", type=float, default=0.007809)
    ap.add_argument("--limit", type=int, default=4000)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--distill-dir", default="/home/jlian/wingdex/ml/distill")
    args = ap.parse_args()

    root = args.nabirds
    bbox = {}
    for line in open(os.path.join(root, "bounding_boxes.txt")):
        p = line.split()
        bbox[p[0]] = (float(p[3]), float(p[4]))
    size = {}
    for line in open(os.path.join(root, "sizes.txt")):
        p = line.split()
        size[p[0]] = (float(p[1]), float(p[2]))
    paths = {}
    for line in open(os.path.join(root, "images.txt")):
        u, rel = line.strip().split(" ", 1)
        paths[u] = rel
    test = []
    for line in open(os.path.join(root, "train_test_split.txt")):
        u, is_tr = line.strip().split(" ")
        if is_tr == "0":
            test.append(u)
    test = test[:args.limit]
    log(str(len(test)) + " NABirds test images")

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    tf = build_text(args.taxonomy, dev)
    st, pre = load_student(args.checkpoint, args.distill_dir, dev)

    areas = []
    confs = []
    buf = []
    meta = []
    def flush():
        if not buf:
            return
        with torch.no_grad():
            e = F.normalize(st(torch.stack(buf).to(dev)), dim=-1)
            s = e @ tf.T
            p = F.softmax(s / args.temperature, dim=-1)
            c = p.max(dim=-1).values.cpu().numpy()
        confs.extend(c.tolist())
        areas.extend(meta)
        buf.clear()
        meta.clear()

    for u in test:
        if u not in bbox or u not in size:
            continue
        bw, bh = bbox[u]
        iw, ih = size[u]
        if iw <= 0 or ih <= 0:
            continue
        rel = (bw * bh) / (iw * ih)
        p = os.path.join(root, "images", paths[u])
        try:
            im = Image.open(p).convert("RGB")
        except Exception:
            continue
        buf.append(pre(im))
        meta.append(rel)
        if len(buf) >= args.batch:
            flush()
    flush()

    A = np.array(areas)
    C = np.array(confs)
    log(str(len(A)) + " images scored")
    pear = float(np.corrcoef(A, C)[0, 1])
    spear = spearman(A, C)
    print()
    print("=== RELATIVE BIRD AREA vs TOP-1 CONFIDENCE ===")
    print("  Pearson  r = " + str(round(pear, 4)))
    print("  Spearman r = " + str(round(spear, 4)))
    print()
    print("  bird area bucket        n      median conf")
    edges = [0.0, 0.02, 0.05, 0.10, 0.20, 0.40, 1.01]
    for i in range(len(edges) - 1):
        m = (A >= edges[i]) & (A < edges[i + 1])
        if m.sum() == 0:
            continue
        print("  " + (str(round(100 * edges[i], 1)) + "-" +
               str(round(100 * edges[i + 1], 1)) + "%").ljust(22) +
              str(int(m.sum())).rjust(5) + "      " +
              str(round(float(np.median(C[m])), 3)))
    print()
    print("  median bird area overall: " + str(round(float(np.median(A)), 4)))
    print()
    print("=== VERDICT ===")
    if abs(spear) > 0.3:
        print("  STRONG: confidence tracks bird size. The existing softmax gate")
        print("  already encodes small/badly-framed, so it can drive the crop")
        print("  prompt and NO detector is needed.")
    elif abs(spear) > 0.15:
        print("  WEAK-MODERATE: some signal, but not enough to rely on alone.")
        print("  A real framing signal would help crop-prompting.")
    else:
        print("  NONE: low confidence is NOT about bird size -- it is species")
        print("  ambiguity. Asking the user to crop will NOT help. Crop-")
        print("  prompting needs a real signal (iOS Vision / patch saliency /")
        print("  multi-crop consistency).")
    print("=== BBOX TEST DONE ===")


if __name__ == "__main__":
    main()
