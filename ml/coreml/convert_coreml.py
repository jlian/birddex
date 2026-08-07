#!/usr/bin/env python3
"""Convert WingCLIP-0.3 to Core ML and check it against PyTorch.

Input is an MLMultiArray of shape (1, 3, 224, 224), NOT an ImageType. Core ML
cannot do the shorter-side bicubic resize that open_clip needs, so the caller
has to own preprocessing regardless; an image input would only absorb the
normalize step while forcing an 8-bit pixel buffer that discards the
resampler's float precision.

Validation runs on the 24 real photo tensors from ml/parity, which are the
outputs of the shipped JS preprocessor, so this measures the model swap alone.
"""
import argparse
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
NPARAMS = 38719232


class WingCLIP(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.visual = timm.create_model(
            "vit_medium_patch16_clip_224.tinyclip_yfcc15m",
            pretrained=False, num_classes=0)
        self.proj = torch.nn.Linear(512, 768)

    def forward(self, x):
        return F.normalize(self.proj(self.visual(x)), dim=-1)


def log(m):
    print("[coreml] " + str(m), flush=True)


def load_fixtures(d):
    out = []
    for p in sorted(glob.glob(os.path.join(d, "js_*.f32.bin"))):
        a = np.fromfile(p, dtype=np.float32)
        assert a.size == 3 * 224 * 224, (p, a.size)
        out.append(a.reshape(1, 3, 224, 224))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--parity", default="../parity")
    ap.add_argument("--out", default="WingCLIP.mlpackage")
    ap.add_argument("--precision", default="fp16", choices=["fp16", "fp32"])
    args = ap.parse_args()

    model = WingCLIP().eval()
    ckpt = torch.load(hf_hub_download(REPO, "wingclip-0.3.pt"), map_location="cpu",
                      weights_only=False)
    model.load_state_dict(ckpt["model"])
    n = sum(p.numel() for p in model.parameters())
    assert n == NPARAMS, "wrong checkpoint: %d" % n
    log("loaded WingCLIP-0.3, %d params, wise alpha %s" % (n, ckpt["wise_ft_alpha"]))

    fx = load_fixtures(args.parity)
    log("loaded %d real preprocessed fixtures" % len(fx))

    example = torch.from_numpy(fx[0])
    with torch.no_grad():
        traced = torch.jit.trace(model, example)

    precision = (ct.precision.FLOAT16 if args.precision == "fp16"
                 else ct.precision.FLOAT32)
    mlmodel = ct.convert(
        traced,
        inputs=[ct.TensorType(name="image", shape=(1, 3, 224, 224),
                              dtype=np.float32)],
        outputs=[ct.TensorType(name="embedding", dtype=np.float32)],
        convert_to="mlprogram",
        compute_precision=precision,
        minimum_deployment_target=ct.target.iOS18,
    )
    mlmodel.short_description = (
        "WingCLIP-0.3 bird image encoder. Input is CLIP-preprocessed "
        "(224 bicubic shorter side, center crop, CLIP mean/std). Output is an "
        "L2-normalized 768-d embedding in BioCLIP-2 space.")
    mlmodel.save(args.out)
    size = sum(os.path.getsize(os.path.join(r, f))
               for r, _, fs in os.walk(args.out) for f in fs)
    log("saved %s  %.1f MB  (%s)" % (args.out, size / 1e6, args.precision))

    classifier = np.load(hf_hub_download(REPO, "text_classifier_fp32.npy"))
    labels = json.load(open(hf_hub_download(REPO, "labels.json")))

    worst_cos = 1.0
    agree = 0
    rows = []
    for i, x in enumerate(fx):
        with torch.no_grad():
            ref = model(torch.from_numpy(x)).numpy()[0]
        got = mlmodel.predict({"image": x})["embedding"].reshape(-1)
        cos = float(ref @ got / (np.linalg.norm(ref) * np.linalg.norm(got)))
        worst_cos = min(worst_cos, cos)
        ri = int((ref @ classifier.T).argmax())
        gi = int((got @ classifier.T).argmax())
        agree += int(ri == gi)
        rows.append((i, cos, labels[ri][0], labels[gi][0], ri == gi))

    log("---- per-fixture ----")
    for i, cos, rl, gl, ok in rows:
        flag = "" if ok else "   <-- TOP-1 DIFFERS"
        log("  %02d  cos %.6f  torch=%-28s coreml=%-28s%s" % (i, cos, rl[:28], gl[:28], flag))
    log("worst cosine vs PyTorch : %.6f" % worst_cos)
    log("top-1 agreement         : %d/%d" % (agree, len(fx)))


if __name__ == "__main__":
    main()
