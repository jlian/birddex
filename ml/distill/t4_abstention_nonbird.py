#!/usr/bin/env python3
"""T4 -- does the confidence gate REJECT non-bird photos?

Every abstention number we have was measured on NABirds, where every image IS
a bird, so the gate has never been asked to say "that is not a bird". A
3,850-way bird softmax has no "none of these" class, so a dog photo has no
correct answer -- the question is whether confidence collapses (good) or stays
high (bad: confident nonsense on a golden retriever).

Measures, at each threshold, the fraction of NON-BIRD images the gate lets
through. Low pass rate = the existing bird gate doubles as a bird detector.
High pass rate = we need a separate bird/not-bird check or calibration fix.

Uses the SAME scoring path as eval_nabirds.py: bird text classifier built from
the BioCLIP-2 teacher (768-d), student forward() which projects 512->768,
confidence = (sims * 100).softmax(-1).max(-1).
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

NL = chr(10)
THRESHOLDS = [0.0, 0.3, 0.5, 0.7, 0.9]


def log(m):
    print("[" + time.strftime("%H:%M:%S") + "] " + str(m), flush=True)


def load_student(checkpoint, device):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from train_student import Student
    ckpt = torch.load(checkpoint, map_location="cpu")
    args = ckpt.get("args", {})
    st = Student(args.get("arch", "ViT-B-16"),
                 args.get("pretrained", "laion2b_s34b_b88k"))
    st.load_state_dict(ckpt["model"])
    st = st.to(device).eval()
    return st, st.preprocess


def build_bird_text_classifier(taxonomy, device, batch=512):
    """Identical to eval_nabirds.build_text_classifier -- same prompts, same space."""
    import open_clip
    TEACHER = "hf-hub:imageomics/bioclip-2"
    taxo = json.load(open(taxonomy))
    commons = [r[0] for r in taxo]
    scis = [r[1] for r in taxo]
    model, _, _ = open_clip.create_model_and_transforms(TEACHER)
    tok = open_clip.get_tokenizer(TEACHER)
    model = model.to(device).eval()
    feats = []
    with torch.no_grad():
        for i in range(0, len(commons), batch):
            j2 = min(i + batch, len(commons))
            b = ["a photo of " + commons[j] + ", " + scis[j] +
                 ", a species of bird." for j in range(i, j2)]
            tf = model.encode_text(tok(b).to(device))
            tf = tf / tf.norm(dim=-1, keepdim=True)
            feats.append(tf.float().cpu())
    out = torch.cat(feats).to(device)
    log("bird text classifier " + str(tuple(out.shape)))
    del model
    torch.cuda.empty_cache()
    return out


def list_images(root, limit_per_class):
    paths = []
    for d in sorted(os.listdir(root)):
        sub = os.path.join(root, d)
        if not os.path.isdir(sub):
            continue
        files = sorted(f for f in os.listdir(sub)
                       if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp")))
        if limit_per_class > 0:
            files = files[:limit_per_class]
        for f in files:
            paths.append((os.path.join(sub, f), d))
    return paths


def confidences(st, preprocess, paths, text_feats, device, batch):
    """Return per-image max-softmax confidence through the BIRD classifier."""
    confs = []
    groups = []
    buf = []
    bg = []

    def flush():
        if not buf:
            return
        x = torch.stack(buf).to(device)
        with torch.no_grad():
            e = st(x)
            e = F.normalize(e, dim=-1)
            sims = e @ text_feats.T
            c = (sims * 100).softmax(-1).max(-1).values
        confs.extend(c.cpu().numpy().tolist())
        groups.extend(bg)
        buf.clear()
        bg.clear()

    for p, g in paths:
        try:
            im = Image.open(p).convert("RGB")
        except Exception:
            continue
        buf.append(preprocess(im))
        bg.append(g)
        if len(buf) >= batch:
            flush()
    flush()
    return np.array(confs), groups


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoints", nargs="+", required=True,
                    help="label=path pairs")
    ap.add_argument("--nonbird", required=True, help="ImageFolder root")
    ap.add_argument("--taxonomy", default="taxonomy.json")
    ap.add_argument("--limit-per-class", type=int, default=50)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--out", default="t4_abstention.json")
    args = ap.parse_args()

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    paths = list_images(args.nonbird, args.limit_per_class)
    log(str(len(paths)) + " non-bird images")
    if not paths:
        log("NO IMAGES -- check --nonbird layout")
        sys.exit(1)

    text_feats = build_bird_text_classifier(args.taxonomy, dev)
    results = {}
    for spec in args.checkpoints:
        label, path = spec.split("=", 1)
        st, preprocess = load_student(path, dev)
        conf, groups = confidences(st, preprocess, paths, text_feats,
                                   dev, args.batch)
        row = {}
        for thr in THRESHOLDS:
            passed = float((conf >= thr).mean())
            row["thr_" + str(thr)] = round(100 * passed, 1)
        row["mean_conf"] = round(float(conf.mean()), 4)
        row["median_conf"] = round(float(np.median(conf)), 4)
        row["p90_conf"] = round(float(np.percentile(conf, 90)), 4)
        results[label] = row
        log(label + ": mean conf " + str(row["mean_conf"]) +
            "  pass@0.5 " + str(row["thr_0.5"]) + "%")
        del st
        torch.cuda.empty_cache()

    print(NL + "=" * 66)
    print("T4 -- NON-BIRD PASS RATE through the bird confidence gate")
    print("(pass rate = % of non-bird photos the gate lets through = FALSE ACCEPTS)")
    print("lower is better; on BIRDS at thr 0.5 coverage was ~88%")
    print("")
    hdr = "  alpha".ljust(12)
    for thr in THRESHOLDS:
        hdr = hdr + ("pass@" + str(thr)).rjust(11)
    hdr = hdr + "meanconf".rjust(11)
    print(hdr)
    for k in sorted(results):
        r = results[k]
        line = ("  " + k).ljust(12)
        for thr in THRESHOLDS:
            line = line + (str(r["thr_" + str(thr)]) + "%").rjust(11)
        line = line + str(r["mean_conf"]).rjust(11)
        print(line)
    print("")
    print("READ: if pass@0.5 is LOW (say under 20%), the existing bird gate")
    print("already doubles as a bird detector and we are fine. If it is HIGH")
    print("(over ~50%), the model is confidently hallucinating species on")
    print("non-birds and WingDex needs a separate bird/not-bird check.")
    with open(args.out, "w") as f:
        json.dump({"n_nonbird": len(paths), "results": results}, f, indent=2)
    print("wrote " + args.out)
    print("=== T4 DONE ===")


if __name__ == "__main__":
    main()
