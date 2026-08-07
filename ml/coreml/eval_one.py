#!/usr/bin/env python3
"""Evaluate one Core ML package against PyTorch on the 24 parity fixtures.

One model per process: holding several compiled MLModels at once segfaults.
"""
import glob
import os
import sys

import coremltools as ct
import numpy as np
import timm
import torch
import torch.nn.functional as F
from huggingface_hub import hf_hub_download

REPO = "johnlian/WingCLIP-0.3"
MIB = 1024 * 1024


class WingCLIP(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.visual = timm.create_model(
            "vit_medium_patch16_clip_224.tinyclip_yfcc15m",
            pretrained=False, num_classes=0)
        self.proj = torch.nn.Linear(512, 768)

    def forward(self, x):
        return F.normalize(self.proj(self.visual(x)), dim=-1)


def main():
    path = sys.argv[1]
    model = WingCLIP().eval()
    ckpt = torch.load(hf_hub_download(REPO, "wingclip-0.3.pt"), map_location="cpu",
                      weights_only=False)
    model.load_state_dict(ckpt["model"])
    classifier = np.load(hf_hub_download(REPO, "text_classifier_fp32.npy"))

    fx = [np.fromfile(p, dtype=np.float32).reshape(1, 3, 224, 224)
          for p in sorted(glob.glob("../parity/js_*.f32.bin"))]

    m = ct.models.MLModel(path)
    worst = 1.0
    agree = 0
    for x in fx:
        with torch.no_grad():
            ref = model(torch.from_numpy(x)).numpy()[0]
        got = m.predict({"image": x})["embedding"].reshape(-1)
        worst = min(worst, float(ref @ got / (np.linalg.norm(ref) * np.linalg.norm(got))))
        agree += int(int((ref @ classifier.T).argmax()) == int((got @ classifier.T).argmax()))

    size = sum(os.path.getsize(os.path.join(r, f))
               for r, _, fs in os.walk(path) for f in fs)
    print("RESULT %-26s %8.2f MiB  worst cos %.6f  top-1 %d/%d"
          % (os.path.basename(path), size / MIB, worst, agree, len(fx)))


if __name__ == "__main__":
    main()
