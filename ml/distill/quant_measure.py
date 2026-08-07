#!/usr/bin/env python3
"""Quantise the exported fp32 ONNX and MEASURE the accuracy cost.

Sizing only tells you whether it fits; it says nothing about whether it still
works. This runs real held-out photos through each quantised graph and reports
embedding fidelity AND top-1 against the frozen text classifier, so the cost is
attributable to quantisation (the fp32 export was proven bit-exact first).

Reports:
  - file size per variant
  - cosine(fp32 embedding, quantised embedding)
  - top-1 AGREEMENT with fp32 (does it pick the same species?)
  - absolute top-1 vs ground truth
"""
import argparse
import json
import os
import time

import numpy as np


def log(m):
    print("[" + time.strftime("%H:%M:%S") + "] " + str(m), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fp32", required=True)
    ap.add_argument("--text", required=True)
    ap.add_argument("--embeds", required=True,
                    help="cached fp32 image embeddings + labels npz for eval")
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    from onnxruntime.quantization import quantize_dynamic, QuantType

    os.makedirs(args.out_dir, exist_ok=True)
    tf = np.load(args.text)
    log("text classifier " + str(tf.shape))

    fp32_mb = os.path.getsize(args.fp32) / 1e6
    log("fp32 ONNX {:.1f} MB".format(fp32_mb))

    variants = [("int8", QuantType.QInt8), ("uint8", QuantType.QUInt8)]
    made = [("fp32", args.fp32, fp32_mb)]
    for name, qt in variants:
        outp = os.path.join(args.out_dir, "wingclip_visual_" + name + ".onnx")
        if not os.path.exists(outp):
            log("quantising -> " + name + " ...")
            quantize_dynamic(args.fp32, outp, weight_type=qt)
        mb = os.path.getsize(outp) / 1e6
        made.append((name, outp, mb))
        log("  " + name + " {:.1f} MB  ({:.2f}x smaller)".format(mb, fp32_mb / mb))

    z = np.load(args.embeds)
    imgs = z["images"]
    labels = z["labels"]
    log("eval set: " + str(imgs.shape[0]) + " preprocessed images")

    import onnxruntime as ort
    ref_emb = None
    print()
    print("variant     size MB   cos(fp32)   top1-agree   ABS top-1")
    print("-" * 62)
    for name, path, mb in made:
        sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
        embs = []
        B = 32
        for i in range(0, len(imgs), B):
            b = imgs[i:i + B].astype(np.float32)
            embs.append(sess.run(None, {"image": b})[0])
        e = np.concatenate(embs)
        e = e / np.linalg.norm(e, axis=1, keepdims=True)
        pred = (e @ tf.T).argmax(axis=1)
        acc = float((pred == labels).mean())
        if ref_emb is None:
            ref_emb = e
            ref_pred = pred
            cos = 1.0
            agree = 1.0
        else:
            cos = float((ref_emb * e).sum(axis=1).mean())
            agree = float((pred == ref_pred).mean())
        print(name.ljust(10) + " {:7.1f}   {:9.6f}   {:9.2f}%   {:8.2f}%".format(
            mb, cos, 100 * agree, 100 * acc))
    print()
    print("=== QUANT MEASURE DONE ===")


if __name__ == "__main__":
    main()
