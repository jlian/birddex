#!/usr/bin/env python3
"""Per-class non-bird pass rates, with the dog class called out.

The PR review's failure case was a dog. Imagenette contains English springer
spaniel, so this checks the candidate gates against that class specifically
rather than against an average dominated by easy negatives like golf balls.
"""
import glob
import os
from collections import defaultdict

import numpy as np
import timm
import torch
import torch.nn.functional as F
from huggingface_hub import hf_hub_download

from abstention_audit import WingCLIP, preprocess, T_FITTED

REPO = "johnlian/WingCLIP-0.3"


def main():
    model = WingCLIP().eval()
    ckpt = torch.load(hf_hub_download(REPO, "wingclip-0.3.pt"), map_location="cpu",
                      weights_only=False)
    model.load_state_dict(ckpt["model"])
    classifier = np.load(hf_hub_download(REPO, "text_classifier_fp32.npy"))
    labels = __import__("json").load(open(hf_hub_download(REPO, "labels.json")))

    by_class = defaultdict(lambda: {"vision": [], "rawcos": [], "shipped": [], "top1": []})
    paths = sorted(glob.glob("../imagenette/val/*/*.JPEG"))
    for p in paths:
        cls = os.path.basename(os.path.dirname(p))
        try:
            x = preprocess(p)
        except Exception:
            continue
        with torch.no_grad():
            emb = model(torch.from_numpy(x)).numpy()[0]
        sims = emb @ classifier.T

        v = sims * 100
        v = np.exp(v - v.max())
        by_class[cls]["vision"].append(float(v.max() / v.sum()))
        by_class[cls]["rawcos"].append(float(sims.max()))
        top = np.sort(sims)[::-1][:25]
        e = np.exp((top - top[0]) / T_FITTED)
        by_class[cls]["shipped"].append(float(e[0] / e.sum()))
        by_class[cls]["top1"].append(labels[int(sims.argmax())][0])

    print("%-26s %5s %14s %14s %14s" %
          ("imagenette class", "n", "vision>=0.2", "rawcos>=0.55", "shipped>=0.7"))
    for cls in sorted(by_class):
        d = by_class[cls]
        v = np.array(d["vision"])
        r = np.array(d["rawcos"])
        s = np.array(d["shipped"])
        mark = "  <-- the dog case" if "spaniel" in cls else ""
        print("%-26s %5d %13.1f%% %13.1f%% %13.1f%%%s" %
              (cls, len(v), 100 * (v >= 0.2).mean(), 100 * (r >= 0.55).mean(),
               100 * (s >= 0.7).mean(), mark))

    dog = next((c for c in by_class if "spaniel" in c), None)
    if dog:
        d = by_class[dog]
        print("\nWhat the model calls a springer spaniel, most common guesses:")
        from collections import Counter
        for name, n in Counter(d["top1"]).most_common(5):
            print("   %-34s %d" % (name, n))
        print("dog vision softmax : median %.4f  max %.4f"
              % (np.median(d["vision"]), np.max(d["vision"])))
        print("dog raw max cosine : median %.4f  max %.4f"
              % (np.median(d["rawcos"]), np.max(d["rawcos"])))
        print("dog shipped conf   : median %.4f  max %.4f"
              % (np.median(d["shipped"]), np.max(d["shipped"])))


if __name__ == "__main__":
    main()
