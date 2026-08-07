#!/usr/bin/env python3
"""Stage and upload WingCLIP-0.1 to huggingface.co/johnlian/WingCLIP-0.1.

WingCLIP-0.1 is runs/ft_clean_01/wise_a0.90.pt. Its siblings are other WiSE-FT
alphas and runs/ft_clean_02 is the retired 0.2 basis, so the identity of the
checkpoint is asserted rather than assumed from the path.

Also ships the two stages the release interpolates between, which regenerates
the whole alpha sweep without uploading it.

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

REPO_ID = "johnlian/WingCLIP-0.1"
RELEASE = "runs/ft_clean_01/wise_a0.90.pt"
ALPHA = "runs/full7555_vitb/best.pt"
BETA = "runs/ft_clean_01/best.pt"
NPARAMS = 86586624
WISE_ALPHA = 0.9
TEXT_CLS = "onnx_tiny39/text_classifier.npy"
TAXONOMY = "../../src/lib/taxonomy.json"
STAGE = "hf_stage_01"


def log(m):
    print("[stage01] " + str(m), flush=True)


def strip(path):
    """Model weights and provenance only, no optimizer state."""
    c = torch.load(path, map_location="cpu", weights_only=False)
    out = {"model": c["model"]}
    for k in ("args", "wise_ft_alpha", "wise_ft_from", "epoch"):
        if k in c:
            out[k] = c[k]
    return out, c


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--card", required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    for p in (RELEASE, ALPHA, BETA, TEXT_CLS, TAXONOMY, args.card):
        if not os.path.exists(p):
            sys.exit("missing: " + p)

    rel, raw = strip(RELEASE)
    sd = rel["model"]
    n = sum(v.numel() for v in sd.values())
    assert n == NPARAMS, "wrong checkpoint: %d params" % n
    assert raw["wise_ft_alpha"] == WISE_ALPHA, "wrong WiSE-FT alpha"
    assert raw["args"]["arch"] == "ViT-B-16", raw["args"]["arch"]
    assert tuple(sd["proj.weight"].shape) == (768, 512)
    log("release verified: %d params, alpha %s" % (n, WISE_ALPHA))

    a, _ = strip(ALPHA)
    b, _ = strip(BETA)
    worst = max(
        (((1 - WISE_ALPHA) * a["model"][k].float()
          + WISE_ALPHA * b["model"][k].float()) - sd[k].float()).abs().max().item()
        for k in sd)
    assert worst == 0.0, "alpha/beta do not reconstruct the release: %r" % worst
    log("alpha/beta reconstruct the release exactly")

    if os.path.exists(STAGE):
        shutil.rmtree(STAGE)
    os.makedirs(STAGE)

    shutil.copy2(args.card, os.path.join(STAGE, "README.md"))
    torch.save(rel, os.path.join(STAGE, "wingclip-0.1.pt"))
    torch.save(a, os.path.join(STAGE, "wingclip-0.1-alpha.pt"))
    torch.save(b, os.path.join(STAGE, "wingclip-0.1-beta.pt"))
    save_file({k: v.contiguous() for k, v in sd.items()},
              os.path.join(STAGE, "wingclip-0.1.safetensors"))
    log("wrote checkpoints and safetensors")

    tf = np.load(TEXT_CLS)
    assert tf.shape == (11167, 768) and tf.dtype == np.float32, tf.shape
    np.save(os.path.join(STAGE, "text_classifier_fp32.npy"), tf)

    taxo = json.load(open(TAXONOMY))
    assert len(taxo) == tf.shape[0], "taxonomy/classifier row mismatch"
    with open(os.path.join(STAGE, "labels.json"), "w") as fh:
        json.dump([[r[0], r[1], r[2]] for r in taxo], fh,
                  ensure_ascii=False, indent=0)
    log("wrote classifier and %d labels" % len(taxo))

    total = sum(os.path.getsize(os.path.join(STAGE, f))
                for f in os.listdir(STAGE))
    log("staged %.1f MB in %s" % (total / 1e6, STAGE))

    if args.dry_run:
        log("dry run, not uploading")
        return

    from huggingface_hub import HfApi
    api = HfApi()
    api.create_repo(REPO_ID, repo_type="model", exist_ok=True, private=False)
    api.upload_folder(repo_id=REPO_ID, folder_path=STAGE, repo_type="model",
                      commit_message="Add WingCLIP-0.1, the teacher of WingCLIP-0.3")
    log("uploaded to https://huggingface.co/" + REPO_ID)


if __name__ == "__main__":
    main()
