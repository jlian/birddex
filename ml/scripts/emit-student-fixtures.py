#!/usr/bin/env python3
"""Emit WingDex pipeline fixtures from OUR DISTILLED STUDENT.

NOTE: ml/spike/emit_vitb.py is misleadingly named -- it loads
"hf-hub:imageomics/bioclip" (the v1 TEACHER), not our student, so
ml/fixtures-vitb/ is NOT our model. This script actually uses a student
checkpoint.

The student lives in BioCLIP-2 768-d space via its learned projection, so the
teacher text classifier applies unchanged -- same as eval_nabirds.py.
Confidence = softmax(cos/0.01), top-50 per image, matching the original
fixture format the pipeline harness expects.
"""
import argparse
import glob
import json
import os
import sys

import torch
import torch.nn.functional as F
from PIL import Image

TEACHER = "hf-hub:imageomics/bioclip-2"


def load_student(checkpoint, distill_dir, device):
    sys.path.insert(0, distill_dir)
    from train_student import Student
    ckpt = torch.load(checkpoint, map_location="cpu")
    args = ckpt.get("args", {})
    st = Student(args.get("arch", "ViT-B-16"),
                 args.get("pretrained", "laion2b_s34b_b88k"))
    st.load_state_dict(ckpt["model"])
    return st.to(device).eval(), st.preprocess


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--images", required=True)
    ap.add_argument("--taxonomy", required=True)
    ap.add_argument("--context", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--distill-dir",
                    default="/home/jlian/wingdex/ml/distill")
    ap.add_argument("--topk", type=int, default=50)
    ap.add_argument("--temp", type=float, default=0.01)
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    taxo = json.load(open(args.taxonomy))
    commons = [r[0] for r in taxo]
    scis = [r[1] for r in taxo]
    print("taxonomy:", len(commons), "species", flush=True)

    import open_clip
    tmodel, _, _ = open_clip.create_model_and_transforms(TEACHER)
    tok = open_clip.get_tokenizer(TEACHER)
    tmodel = tmodel.to(device).eval()
    feats = []
    with torch.no_grad():
        for i in range(0, len(commons), 512):
            j2 = min(i + 512, len(commons))
            b = ["a photo of " + commons[j] + ", " + scis[j] +
                 ", a species of bird." for j in range(i, j2)]
            e = tmodel.encode_text(tok(b).to(device))
            e = e / e.norm(dim=-1, keepdim=True)
            feats.append(e.float().cpu())
    tf = torch.cat(feats).to(device)
    print("text classifier:", tuple(tf.shape), flush=True)
    del tmodel
    torch.cuda.empty_cache()

    st, preprocess = load_student(args.checkpoint, args.distill_dir, device)
    ctx_all = json.load(open(args.context))
    os.makedirs(args.out, exist_ok=True)

    paths = sorted(glob.glob(os.path.join(args.images, "*")))
    n = 0
    missing_ctx = []
    for path in paths:
        fn = os.path.basename(path)
        if fn.lower().endswith(".json"):
            continue
        img = preprocess(Image.open(path).convert("RGB"))
        img = img.unsqueeze(0).to(device)
        with torch.no_grad():
            f = st(img)
            f = F.normalize(f, dim=-1)
            sims = (f @ tf.T).squeeze(0)
        probs = F.softmax(sims / args.temp, dim=0)
        top = torch.topk(probs, args.topk)
        cands = []
        for idx, p in zip(top.indices.tolist(), top.values.tolist()):
            cands.append({"commonName": commons[idx],
                          "scientificName": scis[idx],
                          "confidence": round(float(p), 4),
                          "plumage": None})
        ctx = ctx_all.get(fn, {})
        if not ctx:
            missing_ctx.append(fn)
        fx = {"imageFile": fn, "context": ctx,
              "parsed": {"candidates": cands, "birdCenter": None,
                         "birdSize": None, "multipleBirds": False},
              "model": os.path.basename(args.checkpoint)}
        dst = os.path.join(args.out, fn.rsplit(".", 1)[0] + ".json")
        json.dump(fx, open(dst, "w"), indent=1)
        n += 1

    print("wrote", n, "fixtures ->", args.out)
    if missing_ctx:
        print("WARNING: no lat/lon/month context for", len(missing_ctx),
              "images (range prior cannot apply):")
        for m in missing_ctx:
            print("   ", m)
    print("=== EMIT DONE ===")


if __name__ == "__main__":
    main()
