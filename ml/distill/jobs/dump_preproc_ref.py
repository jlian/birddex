"""Dump reference preprocessing tensors so JS can be checked against PIL.

Splits the parity problem in two, because they fail for different reasons:

  Stage 1 (this file feeds it): given the SAME decoded RGB pixels, does the JS
          resize + crop + normalize match PIL? This is pure resampling math and
          runs in Node with no browser.

  Stage 2: does browser JPEG decode match PIL decode? That covers ICC profiles
          and EXIF orientation, and needs a real browser.

For stage 1 we dump the decoded RGB source pixels alongside the final tensor,
so JS starts from identical input and any difference is attributable to the
resampling, not the decoder.

The transform is Resize(248, BICUBIC) then CenterCrop(224). Resize takes the
SHORTER side to 248 and keeps aspect ratio. Squashing straight into 224x224 is
a different image and silently costs accuracy.

248, not 224. This file used to build the reference from GENERIC open_clip
ViT-B-16, which is 224 -> 224 and makes the crop a no-op. The shipped
checkpoint is timm:vit_medium_patch16_clip_224.tinyclip_yfcc15m, whose timm
pretrained_cfg is 248 -> 224. Referencing the wrong transform is how the client
came to feed a ~11% wider field of view than the model was trained on while
every parity test stayed green. The transform is now READ OFF THE CHECKPOINT
rather than reconstructed, so it cannot drift again.
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image


def log(m):
    print(m, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--nabirds", default="nabirds")
    ap.add_argument("--n", type=int, default=24)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--checkpoint",
                    default="runs/ft_tiny39_fresh/wise_a0.60.pt",
                    help="shipped checkpoint; its timm transform is the reference")
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)

    relpath = []
    for line in open(os.path.join(args.nabirds, "images.txt")):
        p = line.split()
        if len(p) >= 2:
            relpath.append(p[1])
    relpath.sort()
    step = max(1, len(relpath) // args.n)
    picks = relpath[::step][:args.n]
    log("photos: %d" % len(picks))

    # Read the transform off the SHIPPED checkpoint. Do not reconstruct it.
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    import torch
    from train_student import Student
    ck = torch.load(args.checkpoint, map_location="cpu")
    ca = ck.get("args", {})
    pre = Student(ca.get("arch", "ViT-B-16"),
                  ca.get("pretrained", "laion2b_s34b_b88k")).preprocess
    log("transform from %s:" % args.checkpoint)
    log(str(pre))

    MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float64)
    STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float64)

    meta = []
    srcs = {}
    refs = {}
    for i, rp in enumerate(picks):
        path = os.path.join(args.nabirds, "images", rp)
        im = Image.open(path).convert("RGB")
        w, h = im.size

        # Source pixels, exactly what PIL decoded, so JS starts from here.
        src = np.asarray(im, dtype=np.uint8)
        srcs["src_%03d" % i] = src

        # The reference tensor from the real transform.
        ref = pre(im).numpy().astype(np.float32)
        refs["ref_%03d" % i] = ref

        meta.append({"i": i, "path": rp, "w": w, "h": h,
                     "shape": list(ref.shape)})
        if i % 8 == 0:
            log("  %d/%d  %dx%d" % (i, len(picks), w, h))

    # Raw .bin instead of .npz: numpy writes zip64 entries whose local header
    # carries 0xFFFFFFFF for the size, so a simple JS zip reader cannot find
    # the payload length without parsing the central directory.
    for k, v in srcs.items():
        v.tofile(os.path.join(args.out_dir, k + ".u8.bin"))
    for k, v in refs.items():
        v.astype(np.float32).tofile(os.path.join(args.out_dir, k + ".f32.bin"))
    json.dump({"mean": MEAN.tolist(), "std": STD.tolist(),
               "resize": 248, "crop": 224,
               "size": 224, "interpolation": "bicubic",
               "photos": meta},
              open(os.path.join(args.out_dir, "meta.json"), "w"), indent=2)

    log("")
    log("wrote %d src/ref .bin pairs + meta.json to %s" % (len(srcs), args.out_dir))
    r0 = refs["ref_000"]
    log("ref[0] shape %s  min %.4f  max %.4f  mean %.4f"
        % (r0.shape, r0.min(), r0.max(), r0.mean()))


if __name__ == "__main__":
    main()
