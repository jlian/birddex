#!/usr/bin/env python3
"""Score EVERY quantisation variant on NABirds in one pass.

eval_nabirds.py re-decodes and re-preprocesses all 24,633 JPEGs for each model,
which is identical work repeated per variant and dominates runtime on CPU. This
preprocesses ONCE into a memmapped cache, then runs each ONNX graph over it.

Reports, per variant: size, cosine vs the fp32 embeddings, top-1 agreement with
fp32, and absolute NABirds top-1/top-5 against ground truth -- so the accuracy
cost of each format is directly comparable, and comparable to the 89.93 torch
reference.
"""
import argparse
import json
import os
import sys
import time

import numpy as np
import torch


def log(m):
    print("[" + time.strftime("%H:%M:%S") + "] " + str(m), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--nabirds", default="nabirds")
    ap.add_argument("--nb-map", default="nabirds_to_taxo.json")
    ap.add_argument("--taxonomy", required=True)
    ap.add_argument("--export-dir", default="export")
    ap.add_argument("--cache", default="nabirds_pixels.npy")
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from eval_nabirds import load_samples, build_text_classifier, score
    from train_student import Student

    ck = torch.load(args.checkpoint, map_location="cpu")
    ca = ck.get("args", {})
    st = Student(ca.get("arch", "ViT-B-16"),
                 ca.get("pretrained", "laion2b_s34b_b88k"))
    st.load_state_dict(ck["model"])
    st = st.eval()
    pp = st.preprocess

    taxo = json.load(open(args.taxonomy))
    nb_map = json.load(open(args.nb_map))
    # pilot_idx=None scores ALL species (matches --pilot-species 0)
    samples = load_samples(args.nabirds, nb_map, None)
    if args.limit:
        samples = samples[:args.limit]
    paths = [x[0] for x in samples]
    labels = [x[1] for x in samples]
    log("nabirds: " + str(len(paths)) + " images")

    from PIL import Image
    if os.path.exists(args.cache):
        px = np.load(args.cache, mmap_mode="r")
        log("pixel cache hit " + str(px.shape))
        keep = np.load(args.cache.replace(".npy", "_keep.npy"))
    else:
        log("preprocessing once (this is the slow part, then reused) ...")
        buf, keep = [], []
        for i, p in enumerate(paths):
            try:
                buf.append(pp(Image.open(p).convert("RGB")).numpy())
                keep.append(True)
            except Exception:
                keep.append(False)
            if (i + 1) % 4000 == 0:
                log("  " + str(i + 1) + "/" + str(len(paths)))
        px = np.stack(buf).astype(np.float32)
        keep = np.array(keep)
        np.save(args.cache, px)
        np.save(args.cache.replace(".npy", "_keep.npy"), keep)
        log("cached " + str(px.shape))
    lab = np.asarray(labels)[keep]

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    # build_text_classifier returns (tensor, model)
    tf, _txt_model = build_text_classifier(taxo, dev)
    del _txt_model
    torch.cuda.empty_cache()
    if isinstance(tf, torch.Tensor):
        tf = tf.detach().cpu().float().numpy()
    tf = np.ascontiguousarray(tf, dtype=np.float32)
    log("text classifier " + str(tf.shape))

    import onnxruntime as ort
    variants = [("fp32", "wingclip_visual_fp32.onnx"),
                ("fp16", "wingclip_visual_fp16.onnx"),
                ("int8", "wingclip_visual_int8.onnx"),
                ("uint8", "wingclip_visual_uint8.onnx"),
                ("int4", "wingclip_visual_int4.onnx")]
    ref = None
    rows = []
    for tag, fn in variants:
        path = os.path.join(args.export_dir, fn)
        if not os.path.exists(path):
            log("skip " + tag + " (not built)")
            continue
        so = ort.SessionOptions()
        so.intra_op_num_threads = os.cpu_count()
        try:
            sess = ort.InferenceSession(path, so,
                                        providers=["CPUExecutionProvider"])
        except Exception as ex:
            log(tag + " FAILED TO LOAD: " + str(ex)[:110])
            continue
        iname = sess.get_inputs()[0].name
        # the fully-converted fp16 graph takes fp16 in and out
        itype = sess.get_inputs()[0].type
        idt = np.float16 if "float16" in itype else np.float32
        t0 = time.time()
        out = []
        for i in range(0, len(px), args.batch):
            b = np.asarray(px[i:i + args.batch], dtype=idt)
            out.append(sess.run(None, {iname: b})[0].astype(np.float32))
        e = np.concatenate(out).astype(np.float32)
        e = e / np.linalg.norm(e, axis=1, keepdims=True)
        dt = time.time() - t0
        sims = e @ tf.T
        top5 = np.argpartition(-sims, 5, axis=1)[:, :5]
        p1 = sims.argmax(axis=1)
        a1 = float((p1 == lab).mean())
        a5 = float(np.mean([lab[i] in top5[i] for i in range(len(lab))]))
        if ref is None:
            ref, refp = e, p1
            cos, agree = 1.0, 1.0
        else:
            cos = float((ref * e).sum(axis=1).mean())
            agree = float((p1 == refp).mean())
        size = os.path.getsize(path) / 1e6
        rows.append((tag, size, cos, agree, a1, a5, dt))
        log(tag + " done in {:.0f}s".format(dt))

    print()
    print("variant   size MB   cos(fp32)  agree%   top-1    top-5    sec")
    print("-" * 66)
    for tag, size, cos, agree, a1, a5, dt in rows:
        print(tag.ljust(9) + "{:7.1f}   {:9.6f}  {:6.2f}  {:7.2f}  {:7.2f}  {:5.0f}".format(
            size, cos, 100 * agree, 100 * a1, 100 * a5, dt))
    print()
    print("torch fp32 reference: 89.93 top-1")
    print("=== QUANT SWEEP DONE ===")


if __name__ == "__main__":
    main()
