"""G17: what does quantising the TEXT CLASSIFIER actually cost?

F1 and F10 measured the visual tower. The classifier was never measured. fp16
was chosen because fp32 is 32.7 MiB and breaks the 25 MiB per-file cap, and it
was checked only for agreement with fp32 on 24 photos.

This runs the F10 protocol on the classifier: real top-1 over all 24,633
NABirds images, so the number is accuracy rather than agreement.

Variants:
  fp32       reference
  fp16       what ships today
  int8-glob  one scale for the whole matrix
  int8-row   one scale per species row

The global/per-row split is the interesting comparison. Rows are L2-normalised
so each row has similar magnitude, but a single global scale still has to cover
11,167 unrelated species embeddings at once. Per-row costs 11,167 extra fp32
scales, which is 44 KB, nothing against 8 MiB saved.

Embeddings come from the fp32 ONNX tower once and are reused for every variant,
so the comparison isolates the classifier.
"""
import argparse
import json
import os

import numpy as np


def log(m):
    print(m, flush=True)


def quant_global(tf):
    scale = np.abs(tf).max() / 127.0
    q = np.clip(np.round(tf / scale), -127, 127).astype(np.int8)
    return q.astype(np.float32) * scale


def quant_row(tf):
    scale = np.abs(tf).max(axis=1, keepdims=True) / 127.0
    scale[scale == 0] = 1e-12
    q = np.clip(np.round(tf / scale), -127, 127).astype(np.int8)
    return q.astype(np.float32) * scale


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--text", required=True)
    ap.add_argument("--nabirds", default="nabirds")
    ap.add_argument("--nb-map", default="nabirds_to_taxo.json")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--batch", type=int, default=256)
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
    tf = tf / np.linalg.norm(tf, axis=1, keepdims=True)
    log("classifier: %s" % (tf.shape,))

    # Embed on the GPU via torch, not onnxruntime. The installed onnxruntime is
    # CPU-only (providers are Azure and CPU), which made this a 40-minute job on
    # a box with an idle RTX 3080. The ONNX export is already verified
    # bit-exact against torch in G13, so using the checkpoint here changes
    # nothing about what is measured.
    import sys
    import torch
    from PIL import Image
    sys.path.insert(0, ".")
    from train_student import Student

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    ck = torch.load(args.checkpoint, map_location="cpu")
    ca = ck.get("args", {})
    st = Student(ca.get("arch", "ViT-B-16"), ca.get("pretrained", "laion2b_s34b_b88k"))
    st.load_state_dict(ck["model"])
    st = st.to(dev).eval()
    pre = st.preprocess
    log("embedding %d images on %s..." % (len(samples), dev))

    embs = []
    labels = []
    B = args.batch
    with torch.no_grad():
        for i in range(0, len(samples), B):
            chunk = samples[i:i + B]
            px = torch.stack([pre(Image.open(p).convert("RGB")) for p, _ in chunk]).to(dev)
            e = st(px).float().cpu().numpy()
            embs.append(e)
            labels.extend([y for _, y in chunk])
            if i % (B * 40) == 0:
                log("  %d/%d" % (i, len(samples)))
    E = np.concatenate(embs)
    E = E / np.linalg.norm(E, axis=1, keepdims=True)
    labels = np.array(labels, dtype=np.int64)

    variants = [
        ("fp32", tf, tf.nbytes),
        ("fp16", tf.astype(np.float16).astype(np.float32), tf.astype(np.float16).nbytes),
        ("int8-global", quant_global(tf), tf.shape[0] * tf.shape[1] + 4),
        ("int8-perrow", quant_row(tf), tf.shape[0] * tf.shape[1] + tf.shape[0] * 4),
    ]

    ref_pred = None
    print("")
    print("%-13s %9s %9s %9s %11s" % ("variant", "MiB", "top-1", "top-5", "agree-fp32"))
    print("-" * 56)
    for name, mat, nbytes in variants:
        m = mat / np.linalg.norm(mat, axis=1, keepdims=True)
        S = E @ m.T
        pred = S.argmax(axis=1)
        top5 = np.argpartition(-S, 5, axis=1)[:, :5]
        t1 = float((pred == labels).mean())
        t5 = float(np.mean([labels[i] in top5[i] for i in range(len(labels))]))
        if ref_pred is None:
            ref_pred = pred
            agree = 1.0
        else:
            agree = float((pred == ref_pred).mean())
        print("%-13s %9.2f %8.2f%% %8.2f%% %10.2f%%"
              % (name, nbytes / 1048576, 100 * t1, 100 * t5, 100 * agree))

    print("")
    print("Gate: keep 86.90 top-1. fp16 is what ships today at 16.36 MiB.")


if __name__ == "__main__":
    main()
