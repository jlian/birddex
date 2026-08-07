#!/usr/bin/env python3
"""Add the two distillation stages and the updated card to WingCLIP-0.3.

full7555_tiny39/best.pt carries optimizer state and is 3x the weight size, so it
is stripped to weights plus provenance before upload.

Run from ml/distill with .venv/bin/python. Pass --dry-run to stage only.
"""
import argparse
import os
import shutil
import sys

import torch

REPO_ID = "johnlian/WingCLIP-0.3"
RELEASE = "runs/ft_tiny39_fresh/wise_a0.60.pt"
ALPHA = "runs/full7555_tiny39/best.pt"
BETA = "runs/ft_tiny39_fresh/best.pt"
WISE_ALPHA = 0.6
STAGE = "hf_stage_03_stages"


def log(m):
    print("[stage03] " + str(m), flush=True)


def strip(path):
    c = torch.load(path, map_location="cpu", weights_only=False)
    out = {"model": c["model"]}
    for k in ("args", "wise_ft_alpha", "wise_ft_from", "epoch"):
        if k in c:
            out[k] = c[k]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--card", required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    for p in (RELEASE, ALPHA, BETA, args.card):
        if not os.path.exists(p):
            sys.exit("missing: " + p)

    rel = torch.load(RELEASE, map_location="cpu", weights_only=False)["model"]
    a = strip(ALPHA)
    b = strip(BETA)
    worst = max(
        (((1 - WISE_ALPHA) * a["model"][k].float()
          + WISE_ALPHA * b["model"][k].float()) - rel[k].float()).abs().max().item()
        for k in rel)
    assert worst == 0.0, "alpha/beta do not reconstruct the release: %r" % worst
    log("alpha/beta reconstruct the release exactly")

    if os.path.exists(STAGE):
        shutil.rmtree(STAGE)
    os.makedirs(STAGE)

    shutil.copy2(args.card, os.path.join(STAGE, "README.md"))
    torch.save(a, os.path.join(STAGE, "wingclip-0.3-alpha.pt"))
    torch.save(b, os.path.join(STAGE, "wingclip-0.3-beta.pt"))

    total = sum(os.path.getsize(os.path.join(STAGE, f)) for f in os.listdir(STAGE))
    log("staged %.1f MB in %s" % (total / 1e6, STAGE))

    if args.dry_run:
        log("dry run, not uploading")
        return

    from huggingface_hub import HfApi
    HfApi().upload_folder(
        repo_id=REPO_ID, folder_path=STAGE, repo_type="model",
        commit_message="Add the distill and fine-tune stages, which regenerate the alpha sweep")
    log("uploaded to https://huggingface.co/" + REPO_ID)


if __name__ == "__main__":
    main()
