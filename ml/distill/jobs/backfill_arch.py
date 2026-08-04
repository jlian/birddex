"""Backfill args[arch] into the phase-2 checkpoints.

The fine-tune saved vars(a), which has no arch, so eval_nabirds could not
build the right backbone. The WEIGHTS are correct; only the metadata is
missing. Copy arch/pretrained from the distilled checkpoint that produced
them, so we do not repeat the 1h fine-tune.
"""
import glob
import os
import torch

SRC = "runs/full7555_tiny39/best.pt"
FT = "runs/ft_tiny39"

src = torch.load(SRC, map_location="cpu")
sa = src.get("args", {}) or {}
arch = sa.get("arch")
pre = sa.get("pretrained")
print("source arch:", arch)
print("source pretrained:", pre)
if not arch:
    raise SystemExit("source checkpoint has no arch; refusing to guess")

targets = sorted(glob.glob(os.path.join(FT, "*.pt")))
for p in targets:
    c = torch.load(p, map_location="cpu")
    if "model" not in c:
        print("  skip (no model):", p)
        continue
    a = dict(c.get("args", {}) or {})
    if a.get("arch") == arch:
        print("  ok already:", p)
        continue
    # Verify the weights really are this backbone before stamping metadata.
    ks = list(c["model"].keys())
    timm_like = any(k.startswith("visual.blocks.") for k in ks)
    if not timm_like:
        print("  SKIP, not a timm-style state_dict:", p)
        continue
    a["arch"] = arch
    if pre:
        a["pretrained"] = pre
    c["args"] = a
    torch.save(c, p)
    print("  stamped:", p)

print("done")
