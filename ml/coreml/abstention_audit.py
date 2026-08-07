#!/usr/bin/env python3
"""Pick an abstention threshold from data.

The PR review found a dog photo returning a confident bird. This measures three
candidate signals on 400 held-out bird photos and ~390 Imagenette non-birds
(which include dogs and fish):

  shipped_conf   softmax over the top-25 reranked scores, sims/T with the FITTED
                 T=0.00755. This is what the app shows and gates on today.
  vision_softmax (sims * 100).softmax().max() over all 11,167 species. What
                 ml/README's abstention table measured, pre-rerank.
  raw_max_cos    max cosine similarity, no softmax at all.

A good gate separates the two populations. Reports pass rates at each threshold
so the choice is a lookup rather than a guess.
"""
import glob
import json
import os

import numpy as np
import timm
import torch
import torch.nn.functional as F
from huggingface_hub import hf_hub_download
from PIL import Image

REPO = "johnlian/WingCLIP-0.3"
T_FITTED = 0.007545354776084423
DECODE_CAP = 500
CLIP_MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
CLIP_STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)


class WingCLIP(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.visual = timm.create_model(
            "vit_medium_patch16_clip_224.tinyclip_yfcc15m",
            pretrained=False, num_classes=0)
        self.proj = torch.nn.Linear(512, 768)

    def forward(self, x):
        return F.normalize(self.proj(self.visual(x)), dim=-1)


def preprocess(path):
    """Approximates the shipped path: decode capped at 500 on the long side,
    resize the SHORTER side to 224 bicubic, center crop, normalise."""
    im = Image.open(path).convert("RGB")
    long = max(im.size)
    if long > DECODE_CAP:
        s = DECODE_CAP / long
        im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))),
                       Image.BICUBIC)
    w, h = im.size
    if w <= h:
        nw, nh = 224, int(224 * h / w)
    else:
        nh, nw = 224, int(224 * w / h)
    im = im.resize((nw, nh), Image.BICUBIC)
    left = round((nw - 224) / 2)
    top = round((nh - 224) / 2)
    im = im.crop((left, top, left + 224, top + 224))
    a = np.asarray(im, dtype=np.float32) / 255.0
    a = (a - CLIP_MEAN) / CLIP_STD
    return a.transpose(2, 0, 1)[None]


def signals(model, classifier, paths, label):
    out = {"shipped": [], "vision": [], "rawcos": []}
    for i, p in enumerate(paths):
        try:
            x = preprocess(p)
        except Exception:
            continue
        with torch.no_grad():
            emb = model(torch.from_numpy(x)).numpy()[0]
        sims = emb @ classifier.T

        top = np.sort(sims)[::-1][:25]
        e = np.exp((top - top[0]) / T_FITTED)
        out["shipped"].append(float(e[0] / e.sum()))

        v = sims * 100
        v = np.exp(v - v.max())
        out["vision"].append(float(v.max() / v.sum()))

        out["rawcos"].append(float(sims.max()))
        if (i + 1) % 100 == 0:
            print("  %s %d/%d" % (label, i + 1, len(paths)), flush=True)
    return {k: np.array(v) for k, v in out.items()}


def sweep(name, birds, nonbirds, thresholds):
    print("\n=== %s ===" % name)
    print("birds    : min %.4f  p10 %.4f  median %.4f" %
          (birds.min(), np.percentile(birds, 10), np.median(birds)))
    print("non-birds: median %.4f  p90 %.4f  max %.4f" %
          (np.median(nonbirds), np.percentile(nonbirds, 90), nonbirds.max()))
    print("%12s %14s %14s %10s" % ("threshold", "birds kept", "non-birds pass", "spread"))
    for t in thresholds:
        keep = float((birds >= t).mean())
        leak = float((nonbirds >= t).mean())
        print("%12.3f %13.1f%% %13.1f%% %9.1f" % (t, 100 * keep, 100 * leak, 100 * (keep - leak)))


def main():
    model = WingCLIP().eval()
    ckpt = torch.load(hf_hub_download(REPO, "wingclip-0.3.pt"), map_location="cpu",
                      weights_only=False)
    model.load_state_dict(ckpt["model"])
    classifier = np.load(hf_hub_download(REPO, "text_classifier_fp32.npy"))

    # Same layout as tomahawk, so the root .gitignore already covers both.
    birds = sorted(glob.glob("../heldout-orig/*"))
    nonbirds = sorted(glob.glob("../imagenette/val/*/*.JPEG"))
    print("birds %d  non-birds %d" % (len(birds), len(nonbirds)))

    b = signals(model, classifier, birds, "bird")
    n = signals(model, classifier, nonbirds, "nonbird")

    sweep("shipped_conf: softmax(top25 / T), what the app gates on today",
          b["shipped"], n["shipped"], [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99])
    sweep("vision_softmax: (sims*100).softmax().max(), pre-rerank",
          b["vision"], n["vision"], [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7])
    sweep("raw_max_cos: max cosine, no softmax",
          b["rawcos"], n["rawcos"], [0.35, 0.40, 0.45, 0.48, 0.50, 0.52, 0.55])

    json.dump({k: {"birds": b[k].tolist(), "nonbirds": n[k].tolist()} for k in b},
              open("abstention_signals.json", "w"))
    print("\nwrote abstention_signals.json")


if __name__ == "__main__":
    main()
