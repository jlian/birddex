#!/usr/bin/env python3
"""Are the 100% / 0% confidence splits real?

PR review asks whether the displayed confidence is meaningful and whether the
values should add to 100 at all. `confidence` is a softmax over the ranker's
scores, and those scores are sim/T with T fitted at 0.00755. Dividing a cosine
by a number that small blows small similarity gaps into enormous score gaps, so
this measures how peaked the resulting distribution actually is.

Also prints the log-odds before and after reranking, which the review asked for.
"""
import glob
import json

import numpy as np
import timm
import torch
import torch.nn.functional as F
from huggingface_hub import hf_hub_download

REPO = "johnlian/WingCLIP-0.3"
T = 0.007545354776084423
BETA = 0.5435083508491516


class WingCLIP(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.visual = timm.create_model(
            "vit_medium_patch16_clip_224.tinyclip_yfcc15m",
            pretrained=False, num_classes=0)
        self.proj = torch.nn.Linear(512, 768)

    def forward(self, x):
        return F.normalize(self.proj(self.visual(x)), dim=-1)


def softmax(x):
    e = np.exp(x - x.max())
    return e / e.sum()


def main():
    model = WingCLIP().eval()
    ckpt = torch.load(hf_hub_download(REPO, "wingclip-0.3.pt"), map_location="cpu",
                      weights_only=False)
    model.load_state_dict(ckpt["model"])
    classifier = np.load(hf_hub_download(REPO, "text_classifier_fp32.npy"))
    labels = json.load(open(hf_hub_download(REPO, "labels.json")))

    fx = sorted(glob.glob("../parity/js_*.f32.bin"))
    tops = []
    gaps = []

    print("%-4s %-26s %8s %8s %9s %9s" %
          ("id", "top-1", "sim1", "sim2", "p(top1)", "p(top2)"))
    for i, p in enumerate(fx):
        x = np.fromfile(p, dtype=np.float32).reshape(1, 3, 224, 224)
        with torch.no_grad():
            emb = model(torch.from_numpy(x)).numpy()[0]
        sims = emb @ classifier.T
        order = sims.argsort()[::-1][:25]

        # Vision-only, exactly what the ranker does without a prior.
        scores = sims[order] / T
        probs = softmax(scores)
        tops.append(probs[0])
        gaps.append(sims[order[0]] - sims[order[1]])
        print("%-4d %-26s %8.4f %8.4f %9.5f %9.5f" %
              (i, labels[order[0]][0][:26], sims[order[0]], sims[order[1]],
               probs[0], probs[1]))

    tops = np.array(tops)
    gaps = np.array(gaps)
    print()
    print("top-1 confidence: min %.4f  median %.4f  max %.4f" %
          (tops.min(), np.median(tops), tops.max()))
    print("fraction of photos above 0.99 confidence : %.1f%%" % (100 * (tops > 0.99).mean()))
    print("fraction above the 0.70 crop-prompt gate : %.1f%%" % (100 * (tops > 0.70).mean()))
    print("raw cosine gap top1-top2: min %.4f median %.4f max %.4f" %
          (gaps.min(), np.median(gaps), gaps.max()))
    print()
    print("A cosine gap of g becomes a score gap of g/T = g/%.5f." % T)
    for g in (0.001, 0.005, 0.01, 0.02, 0.05):
        print("  gap %.3f -> score gap %6.1f -> p(top1) about %.6f"
              % (g, g / T, 1 / (1 + np.exp(-g / T))))


if __name__ == "__main__":
    main()
