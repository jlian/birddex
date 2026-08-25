#!/usr/bin/env python3
"""Export the WingCLIP student visual tower to ONNX + the frozen text classifier.

ARCHITECTURE NOTE. The student is a ViT-B-16 VISUAL tower (86.6M params).
Classification is done by cosine similarity against an 11,167-class matrix of
BioCLIP-2 TEXT embeddings. Those are computed ONCE here and shipped as a frozen
float matrix, so the text encoder never runs on device.

On-device budget, fp32:
  visual tower      86.6M params   ~346 MB
  text classifier   11167 x 512    ~23 MB
Both need quantising; the tower is the problem.

This script exports fp32 and PROVES PARITY against PyTorch before any
quantisation, because without a trustworthy fp32 ONNX baseline a later int8/int4
number cannot be attributed to quantisation rather than a bad export.
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
    ap.add_argument("--distill-dir", default=".")
    ap.add_argument("--taxonomy", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--opset", type=int, default=17)
    ap.add_argument("--wise-alpha", type=float, default=None,
                    help="WiSE-FT blend weight to record in the ONNX "
                         "provenance; defaults to the pinned shipped "
                         "value in shipped_model.py")
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    dev = "cuda" if torch.cuda.is_available() else "cpu"

    sys.path.insert(0, args.distill_dir)
    from train_student import Student
    ckpt = torch.load(args.checkpoint, map_location="cpu")
    ca = ckpt.get("args", {})
    st = Student(ca.get("arch", "ViT-B-16"),
                 ca.get("pretrained", "laion2b_s34b_b88k"))
    st.load_state_dict(ckpt["model"])
    st = st.eval()
    nparam = sum(p.numel() for p in st.parameters())
    log("student loaded: {:.1f}M params, {:.1f} MB fp32".format(
        nparam / 1e6, nparam * 4 / 1e6))

    # ---- 1. the frozen text classifier ----------------------------------
    tp = os.path.join(args.out_dir, "text_classifier.npy")
    if os.path.exists(tp):
        tf = np.load(tp)
        log("text classifier cached " + str(tf.shape))
    else:
        import open_clip
        taxo = json.load(open(args.taxonomy))
        m, _, _ = open_clip.create_model_and_transforms("hf-hub:imageomics/bioclip-2")
        tok = open_clip.get_tokenizer("hf-hub:imageomics/bioclip-2")
        m = m.to(dev).eval()
        feats = []
        with torch.no_grad():
            for i in range(0, len(taxo), 512):
                j2 = min(i + 512, len(taxo))
                b = ["a photo of " + taxo[j][0] + ", " + taxo[j][1] +
                     ", a species of bird." for j in range(i, j2)]
                e = m.encode_text(tok(b).to(dev))
                e = e / e.norm(dim=-1, keepdim=True)
                feats.append(e.float().cpu())
        tf = torch.cat(feats).numpy().astype(np.float32)
        np.save(tp, tf)
        del m
        torch.cuda.empty_cache()
        log("text classifier built " + str(tf.shape) +
            "  {:.1f} MB fp32".format(tf.nbytes / 1e6))

    # ---- 2. export the visual tower -------------------------------------
    # Student.forward() is already visual -> proj -> F.normalize,
    # which is exactly the exportable graph. No wrapper needed.
    vis = st
    # input size is authoritative from the preprocess, not assumed 224
    from PIL import Image as _I
    with torch.no_grad():
        probe = st.preprocess(_I.new("RGB", (64, 64))).unsqueeze(0)
    res = probe.shape[-1]
    log("input resolution from preprocess: " + str(res))
    dummy = torch.randn(1, 3, res, res)
    onnx_path = os.path.join(args.out_dir, "wingclip_visual_fp32.onnx")
    torch.onnx.export(
        vis, dummy, onnx_path,
        input_names=["image"], output_names=["embedding"],
        dynamic_axes={"image": {0: "batch"}, "embedding": {0: "batch"}},
        opset_version=args.opset, do_constant_folding=True)
    log("exported " + onnx_path + "  {:.1f} MB".format(
        os.path.getsize(onnx_path) / 1e6))

    # ---- 2b. PROVENANCE ---------------------------------------------
    # Record which checkpoint made this graph, inside the graph.
    # Without this the artifact cannot answer "which weights are you?",
    # which is exactly how a day of measurements got attributed to
    # wise_a0.90.pt. The declared resize/crop are also the contract the
    # client must satisfy: see CLIP_RESIZE / CLIP_CROP in
    # src/lib/clip-preprocess.ts. Read it back with check_provenance.py.
    import onnx
    import shipped_model as SM
    # Do NOT read alpha from ckpt["args"]. That dict holds the flags of
    # the command that made the checkpoint and nothing updates it later:
    # wise_a0.90.pt reports alpha 0.5. See "Read the weights, not args"
    # in ml/README.md. Take it from --wise-alpha, or from the pin.
    if os.path.abspath(args.checkpoint) != SM.SHIPPED_CHECKPOINT \
            and args.wise_alpha is None:
        log("WARNING: exporting " + args.checkpoint)
        log("         which is NOT the pinned shipped checkpoint")
        log("         " + SM.SHIPPED_CHECKPOINT)
        log("         Provenance will record the PINNED alpha "
            + ("%.2f" % SM.SHIPPED_WISE_ALPHA) + ", which may be wrong.")
        log("         Pass --wise-alpha to state the real blend weight.")
    props = SM.provenance(args.checkpoint, args.wise_alpha,
                          args.taxonomy)
    om = onnx.load(onnx_path)
    SM.write_provenance(om, props)
    onnx.save(om, onnx_path)
    for k in sorted(props):
        log("  provenance " + k + " = " + props[k])

    # ---- 3. PARITY: onnxruntime vs pytorch ------------------------------
    import onnxruntime as ort
    sess = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    rng = np.random.RandomState(0)
    worst_cos = 1.0
    worst_abs = 0.0
    worst_top1 = 0
    NT = 16
    for i in range(NT):
        x = rng.randn(1, 3, res, res).astype(np.float32)
        with torch.no_grad():
            ref = vis(torch.from_numpy(x)).numpy()
        got = sess.run(None, {"image": x})[0]
        c = float((ref * got).sum() / (np.linalg.norm(ref) * np.linalg.norm(got)))
        worst_cos = min(worst_cos, c)
        worst_abs = max(worst_abs, float(np.abs(ref - got).max()))
        if int((ref @ tf.T).argmax()) != int((got @ tf.T).argmax()):
            worst_top1 += 1
    log("PARITY over " + str(NT) + " random inputs:")
    log("  worst cosine(pytorch, onnx) = {:.8f}".format(worst_cos))
    log("  worst |abs diff|            = {:.3e}".format(worst_abs))
    log("  top-1 disagreements         = " + str(worst_top1) + "/" + str(NT))
    ok = worst_cos > 0.9999 and worst_top1 == 0
    print()
    print("VERDICT: " + ("fp32 ONNX matches PyTorch. Safe baseline for quantisation."
          if ok else "*** MISMATCH -- do NOT quantise from this export ***"))
    print("=== EXPORT DONE ===")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
