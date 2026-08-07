#!/usr/bin/env python3
"""Stage WingCLIP-0.3 and upload it to huggingface.co/johnlian/WingCLIP.

The shipping checkpoint is runs/ft_tiny39_fresh/wise_a0.60.pt. Sibling files in
that directory are other WiSE-FT alphas, and runs/ft_tiny39/ is an earlier and
different fine-tune, so the path is asserted rather than globbed.

Run from ml/distill with .venv/bin/python. Pass --dry-run to stage only.
"""
import argparse
import json
import os
import shutil
import sys

import numpy as np
import torch
from safetensors.torch import save_file

REPO_ID = "johnlian/WingCLIP"
CKPT = "runs/ft_tiny39_fresh/wise_a0.60.pt"
CKPT_SHA_PARAMS = 38719232
TEXT_CLS = "onnx_tiny39/text_classifier.npy"
TAXONOMY = "../../src/lib/taxonomy.json"
ONNX_DIR = "onnx_tiny39"
STAGE = "hf_stage"


def log(m):
    print("[stage] " + str(m), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--card", required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    for p in (CKPT, TEXT_CLS, TAXONOMY, args.card):
        if not os.path.exists(p):
            sys.exit("missing: " + p)

    ckpt = torch.load(CKPT, map_location="cpu", weights_only=False)
    sd = ckpt["model"]
    nparam = sum(v.numel() for v in sd.values())
    assert nparam == CKPT_SHA_PARAMS, "wrong checkpoint: %d params" % nparam
    assert ckpt["wise_ft_alpha"] == 0.6, "wrong WiSE-FT alpha"
    assert ckpt["args"]["arch"] == "timm:vit_medium_patch16_clip_224.tinyclip_yfcc15m"
    assert tuple(sd["proj.weight"].shape) == (768, 512)
    log("checkpoint verified: %d params, alpha %s" % (nparam, ckpt["wise_ft_alpha"]))

    if os.path.exists(STAGE):
        shutil.rmtree(STAGE)
    os.makedirs(os.path.join(STAGE, "onnx"))

    shutil.copy2(args.card, os.path.join(STAGE, "README.md"))
    shutil.copy2(CKPT, os.path.join(STAGE, "wingclip-0.3.pt"))
    log("copied original checkpoint")

    save_file({k: v.contiguous() for k, v in sd.items()},
              os.path.join(STAGE, "wingclip-0.3.safetensors"))
    log("wrote safetensors")

    tf = np.load(TEXT_CLS)
    assert tf.shape == (11167, 768) and tf.dtype == np.float32, tf.shape
    np.save(os.path.join(STAGE, "text_classifier_fp32.npy"), tf)
    log("copied text classifier " + str(tf.shape))

    taxo = json.load(open(TAXONOMY))
    assert len(taxo) == tf.shape[0], "taxonomy/classifier row mismatch"
    labels = [[r[0], r[1], r[2]] for r in taxo]
    with open(os.path.join(STAGE, "labels.json"), "w") as fh:
        json.dump(labels, fh, ensure_ascii=False, indent=0)
    log("wrote %d labels" % len(labels))

    for name in ("wingclip_visual_fp32.onnx",
                 "web/wingclip_visual_int8.onnx",
                 "web/wingclip_visual_int8.data"):
        src = os.path.join(ONNX_DIR, name)
        shutil.copy2(src, os.path.join(STAGE, "onnx", os.path.basename(name)))
    log("copied onnx exports")

    total = sum(os.path.getsize(os.path.join(r, f))
                for r, _, fs in os.walk(STAGE) for f in fs)
    log("staged %.1f MB in %s" % (total / 1e6, STAGE))

    if args.dry_run:
        log("dry run, not uploading")
        return

    from huggingface_hub import HfApi
    api = HfApi()
    api.create_repo(REPO_ID, repo_type="model", exist_ok=True, private=False)
    api.upload_folder(repo_id=REPO_ID, folder_path=STAGE, repo_type="model",
                      commit_message="Add WingCLIP-0.3 weights, classifier and ONNX exports")
    log("uploaded to https://huggingface.co/" + REPO_ID)


if __name__ == "__main__":
    main()
