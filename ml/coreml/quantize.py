#!/usr/bin/env python3
"""Quantize the Core ML model to int8 weights and measure the accuracy cost.

The web build ships an int8 ONNX tower at 37.72 MiB. This checks whether Core ML
can land in the same place, and what it costs, rather than assuming parity with
the ONNX quantizer, which is a different implementation.
"""
import glob
import json
import os

import coremltools as ct
import coremltools.optimize.coreml as cto
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


def pkg_size(p):
    return sum(os.path.getsize(os.path.join(r, f))
               for r, _, fs in os.walk(p) for f in fs)


def evaluate(mlmodel, fx, refs, classifier):
    worst = 1.0
    agree = 0
    for x, ref in zip(fx, refs):
        got = mlmodel.predict({"image": x})["embedding"].reshape(-1)
        worst = min(worst, float(ref @ got / (np.linalg.norm(ref) * np.linalg.norm(got))))
        agree += int(int((ref @ classifier.T).argmax()) == int((got @ classifier.T).argmax()))
    return worst, agree


def main():
    model = WingCLIP().eval()
    ckpt = torch.load(hf_hub_download(REPO, "wingclip-0.3.pt"), map_location="cpu",
                      weights_only=False)
    model.load_state_dict(ckpt["model"])
    classifier = np.load(hf_hub_download(REPO, "text_classifier_fp32.npy"))

    fixture_dir = os.path.join(os.path.dirname(__file__), "..", "parity")
    fx = [np.fromfile(p, dtype=np.float32).reshape(1, 3, 224, 224)
          for p in sorted(glob.glob(os.path.join(fixture_dir, "js_*.f32.bin")))]
    refs = []
    for x in fx:
        with torch.no_grad():
            refs.append(model(torch.from_numpy(x)).numpy()[0])

    base = ct.models.MLModel("WingCLIP.mlpackage")
    results = [("fp16", "WingCLIP.mlpackage")]

    for nbits, name in [(8, "int8"), (4, "int4")]:
        cfg = cto.OptimizationConfig(
            global_config=cto.OpLinearQuantizerConfig(
                mode="linear_symmetric", dtype="int%d" % nbits,
                granularity="per_channel"))
        q = cto.linear_quantize_weights(base, config=cfg)
        path = "WingCLIP-%s.mlpackage" % name
        q.save(path)
        results.append((name, path))
        del q

    # One model per process: holding several compiled MLModels live at once
    # segfaults, so load and release each package one at a time.
    del base

    print("\n%-6s %10s %12s %10s" % ("prec", "size MiB", "worst cos", "top-1"))
    for name, path in results:
        m = ct.models.MLModel(path)
        worst, agree = evaluate(m, fx, refs, classifier)
        print("%-6s %10.2f %12.6f %8d/%d"
              % (name, pkg_size(path) / MIB, worst, agree, len(fx)))
        del m

    print("\nweb ships an int8 ONNX tower at 37.72 MiB for comparison")


if __name__ == "__main__":
    main()
