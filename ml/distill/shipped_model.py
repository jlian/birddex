#!/usr/bin/env python3
"""Single source of truth for the SHIPPED WingCLIP-0.3 checkpoint.

WHY THIS IS PINNED AND NOT AUTO-SELECTED
----------------------------------------
runs/ft_tiny39_fresh/ holds SIX WiSE-FT alphas under one naming scheme and
none of them is marked. Two are plausible, and picking by filename already
cost a full day of contaminated measurements:

  wise_a0.90.pt   the PREVIOUS model's answer. Alpha 0.90 peaks for
                  WingCLIP-0.1 (ViT-B, D4 in ml/README.md). It is NOT the
                  optimum for the model that ships.
  wise_a0.60.pt   the answer for WingCLIP-0.3 (TinyCLIP, F8). The optimum
                  moved DOWN when the student got 2.26x smaller.

Auto-selecting by "highest student top1" cannot resolve this, because the
measured NABirds OOD sweep (n=24,633) TIES at the maximum:

  alpha   0.25    0.40    0.50    0.60    0.75    0.90
  top1   86.27   86.64   86.82   86.90   86.90   86.56

0.60 and 0.75 are both 86.90, so a max-scan picks whichever file the
iteration order happens to reach first. That is arbitrary, not evidence.
0.90 is 0.34 points WORSE than the maximum and is a different model's answer.

So the shipped alpha is asserted here, once, and everything else imports it.
A script that wants a different checkpoint must say so explicitly with an
override flag. Never glob, never max-scan, never hardcode a sibling path.

The path is derived from __file__, so this module works from any cwd and
carries no /home dependency.
"""
import os

# Directory this module lives in: ml/distill.
DISTILL_ROOT = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(DISTILL_ROOT, "..", ".."))

# The WiSE-FT blend weight of the shipped checkpoint. F8.
SHIPPED_WISE_ALPHA = 0.60

# The run directory the shipped checkpoint was produced in.
SHIPPED_RUN = "ft_tiny39_fresh"

# THE shipped checkpoint. Pinned, not selected.
SHIPPED_CHECKPOINT = os.path.join(
    DISTILL_ROOT, "runs", SHIPPED_RUN,
    "wise_a%.2f.pt" % SHIPPED_WISE_ALPHA)

# Preprocessing declared by the checkpoint's timm pretrained_cfg. The client
# must agree with these: see CLIP_RESIZE / CLIP_CROP in
# src/lib/clip-preprocess.ts. Verified identical across every alpha in the
# run, because they all share one backbone.
SHIPPED_RESIZE = 248
SHIPPED_CROP = 224

# The taxonomy the text classifier was built from.
SHIPPED_TAXONOMY = os.path.join(REPO_ROOT, "src", "lib", "taxonomy.json")

# The artifact the app actually runs.
SHIPPED_ONNX = os.path.join(REPO_ROOT, "public", "models",
                            "wingclip_visual_int8.onnx")

# Prefix on every provenance key written into ONNX metadata_props.
META_PREFIX = "wingdex."


def _sha256(path):
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def taxonomy_sha256(path=None):
    """Return the sha256 of the taxonomy the classifier was built from."""
    return _sha256(path or SHIPPED_TAXONOMY)


def checkpoint_sha256(path=None):
    """Return the sha256 of a checkpoint file."""
    return _sha256(path or SHIPPED_CHECKPOINT)


def provenance(checkpoint=None, wise_alpha=None, taxonomy=None):
    """Build the metadata_props mapping written onto an exported ONNX.

    Every value is a string, because ONNX metadata_props are string pairs.

    Raises ValueError when `checkpoint` is not the pinned one and `wise_alpha`
    is omitted, rather than silently recording the pinned alpha against a
    different checkpoint's hash.
    """
    ck = checkpoint or SHIPPED_CHECKPOINT
    # SHIPPED_WISE_ALPHA describes the PINNED checkpoint and nothing else.
    # Defaulting to it for some other checkpoint would stamp 0.60 onto that
    # file's sha256, so the provenance record would name a real artifact and
    # the wrong alpha, which is worse than no record at all. An explicit
    # wise_alpha is therefore REQUIRED whenever the checkpoint is not the pin.
    if wise_alpha is None:
        if os.path.abspath(ck) != os.path.abspath(SHIPPED_CHECKPOINT):
            raise ValueError(
                "wise_alpha is required for a checkpoint that is not the "
                "pinned SHIPPED_CHECKPOINT. Got " + str(ck) + ". Pass the "
                "alpha this checkpoint was blended at; SHIPPED_WISE_ALPHA "
                "describes only the pin.")
        alpha = SHIPPED_WISE_ALPHA
    else:
        alpha = wise_alpha
    tx = taxonomy or SHIPPED_TAXONOMY
    return {
        META_PREFIX + "source_checkpoint": os.path.relpath(ck, REPO_ROOT),
        META_PREFIX + "source_checkpoint_sha256": checkpoint_sha256(ck),
        META_PREFIX + "wise_alpha": "%.2f" % alpha,
        META_PREFIX + "preprocess_resize": str(SHIPPED_RESIZE),
        META_PREFIX + "preprocess_crop": str(SHIPPED_CROP),
        META_PREFIX + "taxonomy_sha256": taxonomy_sha256(tx),
    }


def write_provenance(model, props):
    """Set metadata_props on an onnx ModelProto, replacing existing keys.

    Keys the quantiser wrote (for example onnx.infer) are preserved.
    """
    keep = [p for p in model.metadata_props if p.key not in props]
    del model.metadata_props[:]
    for p in keep:
        e = model.metadata_props.add()
        e.key = p.key
        e.value = p.value
    for k in sorted(props):
        e = model.metadata_props.add()
        e.key = k
        e.value = props[k]
    return model


if __name__ == "__main__":
    print("SHIPPED_CHECKPOINT   " + SHIPPED_CHECKPOINT)
    print("exists               " + str(os.path.exists(SHIPPED_CHECKPOINT)))
    print("SHIPPED_WISE_ALPHA   " + ("%.2f" % SHIPPED_WISE_ALPHA))
    print("preprocess           resize %d, crop %d"
          % (SHIPPED_RESIZE, SHIPPED_CROP))
    print("SHIPPED_ONNX         " + SHIPPED_ONNX)
