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

meta.json IS DERIVED FROM THAT SAME TRANSFORM OBJECT. resize, crop,
interpolation, mean and std used to be written as literals while the tensors
came from --checkpoint. Overriding the checkpoint with one whose timm transform
differs therefore produced tensors and a meta.json that silently contradicted
each other, which makes a parity diagnostic worse than useless: it reports a
mismatch against geometry the reference was never built at. Every field is now
read out of `pre`, so meta.json describes the tensors that were actually
written, whatever checkpoint was passed.

The shipped pin is cross-checked as well. When --checkpoint is
SHIPPED_CHECKPOINT, the derived resize/crop must equal SHIPPED_RESIZE and
SHIPPED_CROP, which are the same numbers the shipped ONNX carries in
metadata_props as wingdex.preprocess_resize / wingdex.preprocess_crop. A
mismatch there means the pin and the client constants have diverged, and it is
an error rather than a warning.
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image

# ml/distill is the parent of jobs/. Adding it derives from __file__, so this
# works from any cwd, unlike the sibling path this used to hardcode.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import shipped_model as SM  # noqa: E402  the pinned shipped checkpoint


def log(m):
    print(m, flush=True)


def _one(pre, name):
    """Return the single transform of class `name` in a Compose.

    Zero matches, or more than one, means the transform is not the shape this
    reference assumes, so guessing would be exactly the silent contradiction
    this function exists to remove.
    """
    hits = [t for t in pre.transforms if type(t).__name__ == name]
    if len(hits) != 1:
        raise SystemExit(
            "expected exactly one %s in the checkpoint transform, found %d. "
            "The transform is: %s" % (name, len(hits), str(pre)))
    return hits[0]


def _side(size):
    """Normalise a torchvision size to one int.

    Resize takes an int (shorter side) or a sequence. CenterCrop reports
    (h, w). A non-square crop has no single number, so it is rejected instead
    of being silently halved.
    """
    if isinstance(size, int):
        return size
    vals = [int(v) for v in size]
    if len(set(vals)) != 1:
        raise SystemExit("non-square size %s is not supported here"
                         % (str(size),))
    return vals[0]


def describe_transform(pre):
    """Read resize/crop/interpolation/mean/std OFF the transform object.

    Nothing here is a literal. meta.json must describe the tensors that were
    actually written, so that overriding --checkpoint with a model whose timm
    transform differs cannot leave the two contradicting each other.
    """
    rs = _one(pre, "Resize")
    cc = _one(pre, "CenterCrop")
    nm = _one(pre, "Normalize")
    interp = getattr(rs.interpolation, "value", None) or str(rs.interpolation)
    crop = _side(cc.size)
    return {
        "resize": _side(rs.size),
        "crop": crop,
        "size": crop,
        "interpolation": str(interp),
        "mean": [float(v) for v in nm.mean],
        "std": [float(v) for v in nm.std],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--nabirds", default="nabirds")
    ap.add_argument("--n", type=int, default=24)
    ap.add_argument("--out-dir", required=True)
    # The pin, NOT a sibling path. shipped_model.py is the single source of
    # truth for which checkpoint ships, and its path derives from __file__, so
    # it no longer resolves against whatever cwd the caller happened to use.
    ap.add_argument("--checkpoint",
                    default=SM.SHIPPED_CHECKPOINT,
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

    spec = describe_transform(pre)
    log("derived: resize %d, crop %d, %s"
        % (spec["resize"], spec["crop"], spec["interpolation"]))

    # Cross-check ONLY against the pin. A deliberate override is allowed to
    # differ; it just has to be described honestly in meta.json, which is the
    # whole point of deriving these.
    if os.path.abspath(args.checkpoint) == os.path.abspath(
            SM.SHIPPED_CHECKPOINT):
        if (spec["resize"], spec["crop"]) != (SM.SHIPPED_RESIZE,
                                              SM.SHIPPED_CROP):
            raise SystemExit(
                "the pinned checkpoint's transform is resize %d / crop %d but "
                "shipped_model.py declares %d / %d. Those constants are what "
                "the client ports and what the shipped ONNX records in "
                "metadata_props, so this divergence would ship a client fed a "
                "different picture from the model."
                % (spec["resize"], spec["crop"],
                   SM.SHIPPED_RESIZE, SM.SHIPPED_CROP))

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
    out = dict(spec)
    out["checkpoint"] = os.path.relpath(os.path.abspath(args.checkpoint),
                                        SM.REPO_ROOT)
    out["photos"] = meta
    json.dump(out, open(os.path.join(args.out_dir, "meta.json"), "w"),
              indent=2)

    log("")
    log("wrote %d src/ref .bin pairs + meta.json to %s" % (len(srcs), args.out_dir))
    r0 = refs["ref_000"]
    log("ref[0] shape %s  min %.4f  max %.4f  mean %.4f"
        % (r0.shape, r0.min(), r0.max(), r0.mean()))


if __name__ == "__main__":
    main()
