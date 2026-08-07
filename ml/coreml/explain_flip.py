#!/usr/bin/env python3
"""Explain the fixture-03 top-1 flip: precision defect, or a near-tie photo?

Compares the torch top-1/top-2 margin against the fp16 perturbation, and runs an
fp32 Core ML conversion as a control.
"""
import glob
import json
import os

import coremltools as ct
import numpy as np
import timm
import torch
import torch.nn.functional as F
from huggingface_hub import hf_hub_download

REPO = "johnlian/WingCLIP-0.3"


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
    model = WingCLIP().eval()
    ckpt = torch.load(hf_hub_download(REPO, "wingclip-0.3.pt"), map_location="cpu",
                      weights_only=False)
    model.load_state_dict(ckpt["model"])
    classifier = np.load(hf_hub_download(REPO, "text_classifier_fp32.npy"))
    labels = json.load(open(hf_hub_download(REPO, "labels.json")))

    fx = [np.fromfile(p, dtype=np.float32).reshape(1, 3, 224, 224)
          for p in sorted(glob.glob("parity/js_*.f32.bin"))]

    print("=== torch top-2 margins, all fixtures ===")
    margins = []
    for i, x in enumerate(fx):
        with torch.no_grad():
            e = model(torch.from_numpy(x)).numpy()[0]
        s = e @ classifier.T
        o = s.argsort()[::-1]
        m = float(s[o[0]] - s[o[1]])
        margins.append(m)
        mark = "  <-- flipped under fp16" if i == 3 else ""
        print("  %02d  margin %.5f   %s / %s%s"
              % (i, m, labels[o[0]][0][:24], labels[o[1]][0][:24], mark))
    order = np.argsort(margins)
    print("tightest three fixtures by margin:", [int(j) for j in order[:3]])

    print("\n=== fp32 Core ML control ===")
    traced = torch.jit.trace(model, torch.from_numpy(fx[0]))
    m32 = ct.convert(
        traced,
        inputs=[ct.TensorType(name="image", shape=(1, 3, 224, 224), dtype=np.float32)],
        outputs=[ct.TensorType(name="embedding", dtype=np.float32)],
        convert_to="mlprogram",
        compute_precision=ct.precision.FLOAT32,
        minimum_deployment_target=ct.target.iOS18,
    )
    m32.save("WingCLIP-fp32.mlpackage")
    size = sum(os.path.getsize(os.path.join(r, f))
               for r, _, fs in os.walk("WingCLIP-fp32.mlpackage") for f in fs)

    agree = 0
    worst = 1.0
    for i, x in enumerate(fx):
        with torch.no_grad():
            ref = model(torch.from_numpy(x)).numpy()[0]
        got = m32.predict({"image": x})["embedding"].reshape(-1)
        worst = min(worst, float(ref @ got / (np.linalg.norm(ref) * np.linalg.norm(got))))
        agree += int(int((ref @ classifier.T).argmax()) == int((got @ classifier.T).argmax()))
    print("fp32 mlpackage %.1f MB, worst cosine %.6f, top-1 agreement %d/%d"
          % (size / 1e6, worst, agree, len(fx)))


if __name__ == "__main__":
    main()
