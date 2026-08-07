#!/usr/bin/env python3
"""Check the WingCLIP-0.1 model card's usage snippet against the staged files."""
import json
import os

import numpy as np
import open_clip
import torch
import torch.nn.functional as F
from safetensors.torch import load_file

STAGE = "hf_stage_01"


class WingCLIP01(torch.nn.Module):
    def __init__(self):
        super().__init__()
        model, _, self.preprocess = open_clip.create_model_and_transforms(
            "ViT-B-16", pretrained=None)
        self.visual = model.visual
        self.proj = torch.nn.Linear(512, 768)

    def forward(self, x):
        return F.normalize(self.proj(self.visual(x)), dim=-1)


def main():
    model = WingCLIP01().eval()
    ckpt = torch.load(os.path.join(STAGE, "wingclip-0.1.pt"), map_location="cpu",
                      weights_only=False)
    model.load_state_dict(ckpt["model"])
    print("pt loads strictly into the card's class")

    st = load_file(os.path.join(STAGE, "wingclip-0.1.safetensors"))
    ref = ckpt["model"]
    assert set(st) == set(ref) and all(torch.equal(st[k], ref[k]) for k in st)
    print("safetensors is bit-identical to the pt state dict")

    a = torch.load(os.path.join(STAGE, "wingclip-0.1-alpha.pt"), map_location="cpu",
                   weights_only=False)["model"]
    b = torch.load(os.path.join(STAGE, "wingclip-0.1-beta.pt"), map_location="cpu",
                   weights_only=False)["model"]
    worst = max((((1 - 0.9) * a[k].float() + 0.9 * b[k].float())
                 - ref[k].float()).abs().max().item() for k in ref)
    print("staged alpha/beta reconstruct the release, max abs diff %.3e" % worst)
    assert worst == 0.0

    x = torch.from_numpy(np.random.RandomState(0).randn(2, 3, 224, 224).astype(np.float32))
    with torch.no_grad():
        emb = model(x).numpy()
    assert np.allclose(np.linalg.norm(emb, axis=1), 1.0, atol=1e-5)
    print("forward output is L2-normalized, dim", emb.shape[-1])

    tf = np.load(os.path.join(STAGE, "text_classifier_fp32.npy"))
    labels = json.load(open(os.path.join(STAGE, "labels.json")))
    assert len(labels) == tf.shape[0]
    print("classifier wiring ok, argmax:", labels[int((emb @ tf.T)[0].argmax())][0])
    print("ALL CHECKS PASSED")


if __name__ == "__main__":
    main()
