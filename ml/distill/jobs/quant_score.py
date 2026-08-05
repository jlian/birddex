"""Score every quantised ONNX variant on NABirds, streaming.

Replaces the quant_measure.py approach of materialising a preprocessed npz.
24,633 images at 3x224x224 float32 is 14.8 GB, which is why the first attempt
ran for minutes with no output and had to be killed.

Instead this decodes each batch once and feeds it to every variant before
moving on, so peak memory is one batch and the pixels are still identical
across variants. Identical input is the point: it keeps decode and resize
jitter out of the comparison, so any gap between fp32 and int8 is attributable
to quantisation.
"""
import argparse
import json
import os

import numpy as np
from PIL import Image


def log(m):
    print(m, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--nabirds", default="nabirds")
    ap.add_argument("--nb-map", default="nabirds_to_taxo.json")
    ap.add_argument("--onnx-dir", required=True)
    ap.add_argument("--text", required=True)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--batch", type=int, default=64)
    args = ap.parse_args()

    root = args.nabirds
    relpath = {}
    for line in open(os.path.join(root, "images.txt")):
        p = line.split()
        if len(p) >= 2:
            relpath[p[0]] = p[1]
    cls = {}
    for line in open(os.path.join(root, "image_class_labels.txt")):
        p = line.split()
        if len(p) >= 2:
            cls[p[0]] = p[1]
    istest = {}
    for line in open(os.path.join(root, "train_test_split.txt")):
        p = line.split()
        if len(p) >= 2:
            istest[p[0]] = (p[1] == "0")

    nbmap = json.load(open(args.nb_map))
    samples = []
    for iid, rp in relpath.items():
        if not istest.get(iid):
            continue
        c = cls.get(iid)
        if c is None:
            continue
        m = nbmap.get(str(c))
        if m is None:
            continue
        samples.append((os.path.join(root, "images", rp), int(m)))
    if args.limit:
        samples = samples[:args.limit]
    log("test images: %d" % len(samples))

    tf = np.load(args.text).astype(np.float32)
    log("text classifier %s" % (tf.shape,))

    import onnxruntime as ort
    import open_clip
    _, _, pre = open_clip.create_model_and_transforms("ViT-B-16", pretrained=None)

    # fp16 is excluded: convert_float_to_float16 emits a graph whose Cast
    # nodes declare float16 output where the consumer expects float, so
    # onnxruntime rejects it at load. build_quant_variants.py already notes
    # this failure mode. fp16 is a Core ML / WebGPU format and is not the
    # web-delivery candidate, so it does not block the int8 decision.
    names = ["fp32", "uint8", "int4"]
    paths = {}
    for n in names:
        p = os.path.join(args.onnx_dir, "wingclip_visual_" + n + ".onnx")
        if os.path.exists(p):
            paths[n] = p
    log("variants: " + ", ".join(paths.keys()))

    sess = {n: ort.InferenceSession(p, providers=["CPUExecutionProvider"])
            for n, p in paths.items()}
    inname = {n: s.get_inputs()[0].name for n, s in sess.items()}
    indtype = {n: s.get_inputs()[0].type for n, s in sess.items()}

    embs = {n: [] for n in paths}
    labels = []
    B = args.batch
    for i in range(0, len(samples), B):
        chunk = samples[i:i + B]
        px = np.stack([pre(Image.open(p).convert("RGB")).numpy()
                       for p, _ in chunk]).astype(np.float32)
        labels.extend([y for _, y in chunk])
        for n, s in sess.items():
            x = px.astype(np.float16) if "float16" in indtype[n] else px
            e = s.run(None, {inname[n]: x})[0].astype(np.float32)
            embs[n].append(e)
        if i % (B * 40) == 0:
            log("  %d/%d" % (i, len(samples)))

    labels = np.array(labels, dtype=np.int64)
    ref_e = None
    ref_p = None
    print("")
    print("variant     size MB   cos(fp32)   top1-agree   ABS top-1")
    print("-" * 62)
    for n in names:
        if n not in embs:
            continue
        e = np.concatenate(embs[n])
        e = e / np.linalg.norm(e, axis=1, keepdims=True)
        pred = (e @ tf.T).argmax(axis=1)
        acc = float((pred == labels).mean())
        mb = os.path.getsize(paths[n]) / 1e6
        if ref_e is None:
            ref_e, ref_p = e, pred
            cos, agree = 1.0, 1.0
        else:
            cos = float((ref_e * e).sum(axis=1).mean())
            agree = float((pred == ref_p).mean())
        print(n.ljust(10) + " {:7.1f}   {:9.6f}   {:9.2f}%   {:8.2f}%".format(
            mb, cos, 100 * agree, 100 * acc))
    print("")
    print("=== QUANT SCORE DONE ===")


if __name__ == "__main__":
    main()
