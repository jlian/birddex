#!/usr/bin/env python3
"""T3.3 -- does the fine-tune cost us GENERAL visual knowledge?

NABirds cannot answer this: it is birds, our fine-tune data is birds, and our
base is a bird specialist distilled from BioCLIP-2. WiSE-FT exists to preserve
broad pretrained capability, so a bird-only eval has almost nothing to detect.

This evaluates the SAME alpha sweep on a small general (non-bird) image set,
zero-shot through a general text classifier. Two possible outcomes, both useful:
  - blend helps here -> WiSE-FT works, NABirds just could not see it
  - flat here too    -> the base never had much breadth; deviation is structural

NOTE: the student is a ViT-B-16 in a 512-dim space; the bird text classifier is
built from the BioCLIP-2 TEACHER (768-dim) with a learned projection. For a
general eval we build the text classifier from the STUDENT OWN pretrained
tower (laion2b_s34b_b88k), which is the space the student actually lives in and
the breadth that fine-tuning could have destroyed.
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
    return st, st.preprocess, args


def build_general_text_classifier(classnames, arch, pretrained, device):
    """Zero-shot head in the STUDENT pretrained space, prompt-ensembled."""
    import open_clip
    model, _, _ = open_clip.create_model_and_transforms(arch,
                                                        pretrained=pretrained)
    tok = open_clip.get_tokenizer(arch)
    model = model.to(device).eval()
    templates = [
        "a photo of a {}.",
        "a blurry photo of a {}.",
        "a close-up photo of a {}.",
        "a bright photo of a {}.",
        "a photo of one {}.",
    ]
    feats = []
    with torch.no_grad():
        for name in classnames:
            prompts = [t.format(name) for t in templates]
            tf = model.encode_text(tok(prompts).to(device))
            tf = tf / tf.norm(dim=-1, keepdim=True)
            tf = tf.mean(0)
            tf = tf / tf.norm()
            feats.append(tf.float().cpu())
    out = torch.stack(feats).to(device)
    log("general text classifier " + str(tuple(out.shape)))
    del model
    torch.cuda.empty_cache()
    return out


def load_imagefolder(root, limit_per_class):
    """Expect root/<classname>/*.jpg -- standard ImageFolder layout."""
    classes = sorted(d for d in os.listdir(root)
                     if os.path.isdir(os.path.join(root, d)))
    samples = []
    for ci, c in enumerate(classes):
        d = os.path.join(root, c)
        files = sorted(f for f in os.listdir(d)
                       if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp")))
        if limit_per_class > 0:
            files = files[:limit_per_class]
        for f in files:
            samples.append((os.path.join(d, f), ci))
    return classes, samples


def embed(model, preprocess, samples, device, batch):
    embs = []
    labs = []
    buf = []
    bl = []
    def flush():
        if not buf:
            return
        x = torch.stack(buf).to(device)
        with torch.no_grad():
            e = model.encode_image(x) if hasattr(model, "encode_image") else model(x)
        embs.append(e.float().cpu())
        labs.extend(bl)
        buf.clear()
        bl.clear()
    for path, lab in samples:
        try:
            im = Image.open(path).convert("RGB")
        except Exception:
            continue
        buf.append(preprocess(im))
        bl.append(lab)
        if len(buf) >= batch:
            flush()
    flush()
    return torch.cat(embs), labs


def score(E, labs, text_feats, tag):
    E = F.normalize(E.to(text_feats.device), dim=-1)
    sims = E @ text_feats.T
    k = min(5, text_feats.shape[0])
    top = sims.topk(k, -1).indices.cpu().numpy()
    lab = np.array(labs)
    ok1 = top[:, 0] == lab
    ok5 = (top == lab[:, None]).any(1)
    return {"model": tag, "n": int(len(lab)),
            "top1": round(100 * float(ok1.mean()), 2),
            "top5": round(100 * float(ok5.mean()), 2)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoints", nargs="+", required=True,
                    help="label=path pairs, e.g. a0.50=runs/x/wise_a0.50.pt")
    ap.add_argument("--data", required=True, help="ImageFolder root")
    ap.add_argument("--limit-per-class", type=int, default=50)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--out", default="t33_general_ood.json")
    args = ap.parse_args()

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    classes, samples = load_imagefolder(args.data, args.limit_per_class)
    log(str(len(classes)) + " classes, " + str(len(samples)) + " images")
    if not samples:
        log("NO IMAGES FOUND -- check --data layout (root/<class>/*.jpg)")
        sys.exit(1)

    results = {}
    text_feats = None
    for spec in args.checkpoints:
        if "=" in spec:
            label, path = spec.split("=", 1)
        else:
            label, path = os.path.basename(spec), spec
        st, preprocess, ckargs = load_student(path, dev)
        if text_feats is None:
            text_feats = build_general_text_classifier(
                classes, ckargs.get("arch", "ViT-B-16"),
                ckargs.get("pretrained", "laion2b_s34b_b88k"), dev)
        E, labs = embed(st, preprocess, samples, dev, args.batch)
        r = score(E, labs, text_feats, label)
        results[label] = r
        log(label + ": top1 " + str(r["top1"]) + "  top5 " + str(r["top5"]))
        del st
        torch.cuda.empty_cache()

    print(NL + "=" * 60)
    print("T3.3 GENERAL (NON-BIRD) OOD -- " + str(len(classes)) + " classes")
    for k in sorted(results):
        print("  " + k.ljust(12) + " top1 " + str(results[k]["top1"]).rjust(6) +
              "   top5 " + str(results[k]["top5"]).rjust(6))
    vals = [(results[k]["top1"], k) for k in results]
    best = max(vals)
    worst = min(vals)
    print(NL + "best  : " + best[1] + " at " + str(best[0]))
    print("worst : " + worst[1] + " at " + str(worst[0]))
    print("spread: " + format(best[0] - worst[0], ".2f") + " pts")
    print(NL + "READ: if a LOW alpha wins here, WiSE-FT IS preserving general")
    print("knowledge that NABirds cannot see. If flat, the base never had much")
    print("breadth and our deviation from the paper is structural.")
    with open(args.out, "w") as f:
        json.dump({"classes": len(classes), "n": len(samples),
                   "results": results}, f, indent=2)
    print("wrote " + args.out)
    print("=== T3.3 DONE ===")


if __name__ == "__main__":
    main()
