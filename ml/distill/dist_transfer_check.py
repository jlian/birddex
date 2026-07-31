#!/usr/bin/env python3
"""Does the SIMILARITY DISTRIBUTION transfer from iNat photos to NABirds?

THE RISK: T=0.0078 and beta were fitted on iNat photos. If non-iNat photos
produce FLATTER cosine similarities, the vision term contributes less spread,
the fixed beta lets the geographic prior dominate, and WingDex starts
confidently reporting whatever is locally common.

NABirds cannot test the prior (no GPS) but it CAN test this: it is 24,633
non-iNat images from many photographers. If its similarity gaps look like
iNat gaps, the fitted T transfers and the risk is small. If NABirds is much
flatter, that is the warning sign.

Compares, using the SAME checkpoint and the SAME text classifier:
  - median top-1 raw cosine
  - median (top1 - top2) gap        <- what drives softmax sharpness
  - median top-1 softmax confidence at the FITTED T
  - fraction above 0.9 at the fitted T
"""
import argparse
import json
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


def load_student(ckpt_path, distill_dir, device):
    sys.path.insert(0, distill_dir)
    from train_student import Student
    ck = torch.load(ckpt_path, map_location="cpu")
    ar = ck.get("args", {})
    st = Student(ar.get("arch", "ViT-B-16"),
                 ar.get("pretrained", "laion2b_s34b_b88k"))
    st.load_state_dict(ck["model"])
    return st.to(device).eval(), st.preprocess


def build_text(taxonomy, device):
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


def stats(sims, T, tag):
    top = sims.topk(5, dim=-1).values
    gap = (top[:, 0] - top[:, 1])
    p = F.softmax(sims / T, dim=-1)
    conf = p.max(dim=-1).values
    print("  " + tag.ljust(22) +
          "cos1 " + str(round(float(top[:, 0].median()), 4)) +
          "  gap12 " + str(round(float(gap.median()), 4)) +
          "  conf " + str(round(float(conf.median()), 3)) +
          "  >0.9 " + str(round(float((conf > 0.9).float().mean()), 3)))
    return float(gap.median())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--taxonomy", required=True)
    ap.add_argument("--nabirds", required=True)
    ap.add_argument("--inat-candidates", required=True)
    ap.add_argument("--nb-map", required=True)
    ap.add_argument("--temperature", type=float, default=0.007809)
    ap.add_argument("--limit", type=int, default=3000)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--distill-dir", default="/home/jlian/wingdex/ml/distill")
    args = ap.parse_args()

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    tf = build_text(args.taxonomy, dev)
    log("text classifier " + str(tuple(tf.shape)))
    st, pre = load_student(args.checkpoint, args.distill_dir, dev)

    root = args.nabirds
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
    log(str(len(test)) + " NABirds test images (sampled)")

    sims_all = []
    buf = []
    for u in test:
        p = os.path.join(root, "images", paths[u])
        try:
            im = Image.open(p).convert("RGB")
        except Exception:
            continue
        buf.append(pre(im))
        if len(buf) >= args.batch:
            with torch.no_grad():
                e = F.normalize(st(torch.stack(buf).to(dev)), dim=-1)
                sims_all.append((e @ tf.T).float().cpu())
            buf = []
    if buf:
        with torch.no_grad():
            e = F.normalize(st(torch.stack(buf).to(dev)), dim=-1)
            sims_all.append((e @ tf.T).float().cpu())
    nb = torch.cat(sims_all)
    log("NABirds sims " + str(tuple(nb.shape)))

    import pandas as pd
    df = pd.read_parquet(args.inat_candidates)
    inat = torch.tensor(np.stack(df["cand_sim"].values), dtype=torch.float32)

    print()
    print("=== SIMILARITY DISTRIBUTION: iNat vs NABirds (same checkpoint) ===")
    print("  (cos1 = median top-1 cosine; gap12 = median top1-top2;")
    print("   conf/>0.9 at the FITTED T=" + str(args.temperature) + ")")
    gi = stats(inat, args.temperature, "iNat (fitted on)")
    gn = stats(nb, args.temperature, "NABirds (non-iNat)")
    print()
    print("=== VERDICT ===")
    r = gn / gi if gi else float("nan")
    print("  NABirds gap / iNat gap = " + str(round(r, 3)))
    if r > 0.85:
        print("  => similarity SHAPE transfers; the fitted T is not obviously")
        print("     mis-scaled on non-iNat photos. Calibration risk is LOW.")
    else:
        print("  => WARNING: NABirds similarities are FLATTER. The fitted T")
        print("     would leave non-iNat photos under-confident, letting the")
        print("     geographic prior dominate. Re-fit per-domain before shipping.")
    print("=== DIST CHECK DONE ===")


if __name__ == "__main__":
    main()
