#!/usr/bin/env python3
"""Check the model card's usage snippet against the staged artifacts.

Rebuilds the student from the card's class definition alone, loads the staged
weights strictly, and compares against the staged fp32 ONNX export. Also checks
that the int8 external-data reference still resolves after the move into onnx/.
"""
import json
import os

import numpy as np
import onnx
import onnxruntime as ort
import timm
import torch
import torch.nn.functional as F
from safetensors.torch import load_file

STAGE = "hf_stage"


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
    ckpt = torch.load(os.path.join(STAGE, "wingclip-0.3.pt"), map_location="cpu",
                      weights_only=False)
    model.load_state_dict(ckpt["model"])
    print("pt loads strictly into the card's class")

    st = load_file(os.path.join(STAGE, "wingclip-0.3.safetensors"))
    ref = ckpt["model"]
    assert set(st) == set(ref)
    assert all(torch.equal(st[k], ref[k]) for k in st)
    print("safetensors is bit-identical to the pt state dict")

    rng = np.random.RandomState(0)
    x = rng.randn(2, 3, 224, 224).astype(np.float32)
    with torch.no_grad():
        got = model(torch.from_numpy(x)).numpy()
    assert np.allclose(np.linalg.norm(got, axis=1), 1.0, atol=1e-5)

    sess = ort.InferenceSession(os.path.join(STAGE, "onnx", "wingclip_visual_fp32.onnx"),
                                providers=["CPUExecutionProvider"])
    ref_onnx = sess.run(None, {"image": x})[0]
    cos = float((got[0] * ref_onnx[0]).sum())
    print("fp32 onnx parity cosine %.8f" % cos)
    assert cos > 0.9999

    for path in (os.path.join(STAGE, "onnx", "wingclip_visual_int8.onnx"),):
        m = onnx.load(path, load_external_data=False)
        refs = {e.value for t in m.graph.initializer for e in t.external_data
                if e.key == "location"}
        print("int8 external data refs:", sorted(refs))
        for r in refs:
            assert os.path.exists(os.path.join(os.path.dirname(path), r)), r

    s8 = ort.InferenceSession(os.path.join(STAGE, "onnx", "wingclip_visual_int8.onnx"),
                              providers=["CPUExecutionProvider"])
    got8 = s8.run(None, {"image": x})[0]
    print("int8 vs fp32 cosine %.6f" % float((got8[0] * ref_onnx[0]).sum()))

    tf = np.load(os.path.join(STAGE, "text_classifier_fp32.npy"))
    labels = json.load(open(os.path.join(STAGE, "labels.json")))
    assert len(labels) == tf.shape[0]
    sims = got @ tf.T
    print("classifier wiring ok, argmax:", labels[int(sims[0].argmax())][0])
    print("ALL CHECKS PASSED")


if __name__ == "__main__":
    main()
