#!/usr/bin/env python3
"""Export fp16 DIRECTLY from PyTorch rather than converting the fp32 ONNX.

onnxconverter_common.float16 fails on this graph: the ViT has a Cast node
(/visual/Cast) whose output type the converter does not rewrite consistently,
so ORT rejects the model with
  Type (tensor(float16)) of output arg (/visual/Cast_output_0) ... does not
  match expected type (tensor(float))
and this happens with BOTH keep_io_types True and False.

Exporting model.half() straight from torch sidesteps the rewrite entirely:
torch emits a graph that is fp16 by construction.
"""
import argparse
import os
import sys

import torch


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--opset", type=int, default=17)
    args = ap.parse_args()

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from train_student import Student
    ck = torch.load(args.checkpoint, map_location="cpu")
    ca = ck.get("args", {})
    st = Student(ca.get("arch", "ViT-B-16"),
                 ca.get("pretrained", "laion2b_s34b_b88k"))
    st.load_state_dict(ck["model"])
    st = st.eval()

    # fp16 export needs CUDA: many ops have no CPU half kernel
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    st = st.to(dev).half().eval()
    dummy = torch.randn(1, 3, 224, 224, device=dev, dtype=torch.float16)
    # In half precision the ViT dispatches to aten::_native_multi_head_
    # attention, which the LEGACY torchscript exporter cannot lower.
    # The dynamo exporter traces through it, so prefer it and fall back.
    with torch.no_grad():
        try:
            torch.onnx.export(
                st, dummy, args.out,
                input_names=["image"],
                output_names=["embedding"],
                dynamo=True, opset_version=args.opset)
            print("exported via dynamo")
        except Exception as e:
            print("dynamo failed (" + str(e)[:80] +
                  "), retrying with sdpa disabled")
            with torch.backends.cuda.sdp_kernel(enable_flash=False,
                                                enable_mem_efficient=False,
                                                enable_math=True):
                torch.onnx.export(
                    st, dummy, args.out,
                    input_names=["image"],
                    output_names=["embedding"],
                    dynamic_axes={"image": {0: "batch"},
                                  "embedding": {0: "batch"}},
                    opset_version=args.opset,
                    do_constant_folding=True)
    print("wrote " + args.out + "  {:.1f} MB".format(
        os.path.getsize(args.out) / 1e6))

    import numpy as np
    import onnxruntime as ort
    s = ort.InferenceSession(args.out, providers=["CPUExecutionProvider"])
    i = s.get_inputs()[0]
    x = np.random.randn(1, 3, 224, 224).astype(np.float16)
    o = s.run(None, {i.name: x})[0]
    print("loads + runs OK: in " + str(i.type) + " out " + str(o.shape) +
          " " + str(o.dtype))
    print("=== FP16 EXPORT DONE ===")


if __name__ == "__main__":
    main()
