"""Isolate WHICH stage breaks parity: resize, or crop.

The stage-1 failure is content-dependent, and nearly identical inputs land on
opposite sides (1024x684 passes, 1024x683 fails). That signature points at a
spatial misalignment rather than wrong arithmetic, because a shift shows up
strongly on detailed images and weakly on smooth ones.

So dump the intermediate: PIL's resize output BEFORE the crop. If JS matches
that, the fault is in the crop offset. If it does not, the fault is in the
resampling itself.

Also dumps the horizontal-only pass. PIL's ImagingResample rounds to uint8
BETWEEN the horizontal and vertical passes, and carrying float64 through both
is a real difference worth measuring separately.
"""
import argparse
import json
import os

import numpy as np
from PIL import Image


def log(m):
    print(m, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--nabirds", default="nabirds")
    ap.add_argument("--dir", required=True)
    args = ap.parse_args()

    meta = json.load(open(os.path.join(args.dir, "meta.json")))
    out = {}
    for ph in meta["photos"]:
        im = Image.open(os.path.join(args.nabirds, "images", ph["path"]))
        im = im.convert("RGB")
        w, h = im.size
        if w <= h:
            nw, nh = 224, int(224 * h / w)
        else:
            nh, nw = 224, int(224 * w / h)

        rs = im.resize((nw, nh), Image.BICUBIC)
        a = np.asarray(rs, dtype=np.uint8)
        a.tofile(os.path.join(args.dir, "rs_%03d.u8.bin" % ph["i"]))
        out[ph["i"]] = {"nw": nw, "nh": nh}

        # Horizontal-only, to test the between-pass rounding question.
        hz = im.resize((nw, h), Image.BICUBIC)
        np.asarray(hz, dtype=np.uint8).tofile(
            os.path.join(args.dir, "hz_%03d.u8.bin" % ph["i"]))

    json.dump(out, open(os.path.join(args.dir, "resize_meta.json"), "w"),
              indent=2)
    log("wrote rs_*.u8.bin and hz_*.u8.bin for %d photos" % len(out))
    log("first: nw=%d nh=%d" % (out[0]["nw"], out[0]["nh"]))


if __name__ == "__main__":
    main()
