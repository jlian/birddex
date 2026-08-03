#!/usr/bin/env python3
"""Break the 245 img/s transform stage into its individual operations.

profile_loader.py showed transforms are the most expensive layer (706 -> 245
img/s, a 65% cut, worse than JPEG decode). But "transforms" is 4-5 separate
ops. This times each one so we optimise the right one instead of guessing.

Also tests the cheap alternatives:
  - Image.draft() to let libjpeg downscale DURING decode
  - resize with BILINEAR instead of BICUBIC
  - doing ToTensor/Normalize on GPU in a batch instead of per-image on CPU
"""
import argparse
import glob
import io
import tarfile
import time

import numpy as np
import torch
from PIL import Image
from torchvision import transforms as T

SHARDS = "/mnt/nas/WingDex-Distill/wds-nabirds401/shard-*.tar"


def log(m):
    print("[%s] %s" % (time.strftime("%H:%M:%S"), m), flush=True)


def load_blobs(paths, n):
    blobs = []
    for p in paths:
        with tarfile.open(p) as tf:
            for m in tf:
                if not m.name.endswith(".jpg"):
                    continue
                blobs.append(tf.extractfile(m).read())
                if len(blobs) >= n:
                    return blobs
    return blobs


def timeit(label, fn, blobs, warm=20):
    for b in blobs[:warm]:
        fn(b)
    t0 = time.time()
    for b in blobs:
        fn(b)
    el = time.time() - t0
    rate = len(blobs) / el
    print("  %-46s %8.1f img/s  (%6.3f ms)" % (label, rate, 1000 * el / len(blobs)))
    return rate


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shards", default=SHARDS)
    ap.add_argument("--n", type=int, default=600)
    args = ap.parse_args()

    paths = sorted(glob.glob(args.shards))
    log("loading %d jpegs into RAM (I/O excluded from all timings below)" % args.n)
    blobs = load_blobs(paths, args.n)
    log("got %d" % len(blobs))

    RES = 224
    norm = T.Normalize((0.48145466, 0.4578275, 0.40821073),
                       (0.26862954, 0.26130258, 0.27577711))
    to_t = T.ToTensor()
    rrc = T.RandomResizedCrop(RES, scale=(0.9, 1.0),
                              interpolation=T.InterpolationMode.BICUBIC)
    rrc_bil = T.RandomResizedCrop(RES, scale=(0.9, 1.0),
                                  interpolation=T.InterpolationMode.BILINEAR)

    print("")
    print("=== CUMULATIVE (each line adds one op) ===")
    r_dec = timeit("1. decode only", lambda b: Image.open(io.BytesIO(b)).convert("RGB"), blobs)

    def f_rrc(b):
        return rrc(Image.open(io.BytesIO(b)).convert("RGB"))
    r_rrc = timeit("2. + RandomResizedCrop 224 BICUBIC", f_rrc, blobs)

    def f_tot(b):
        return to_t(rrc(Image.open(io.BytesIO(b)).convert("RGB")))
    r_tot = timeit("3. + ToTensor", f_tot, blobs)

    def f_all(b):
        return norm(to_t(rrc(Image.open(io.BytesIO(b)).convert("RGB"))))
    r_all = timeit("4. + Normalize  (= the real pipeline)", f_all, blobs)

    print("")
    print("=== PER-OP COST (derived) ===")
    def ms(r):
        return 1000.0 / r
    print("  decode                %6.3f ms" % ms(r_dec))
    print("  RandomResizedCrop     %6.3f ms" % (ms(r_rrc) - ms(r_dec)))
    print("  ToTensor              %6.3f ms" % (ms(r_tot) - ms(r_rrc)))
    print("  Normalize             %6.3f ms" % (ms(r_all) - ms(r_tot)))

    print("")
    print("=== CHEAP ALTERNATIVES ===")

    def f_draft(b):
        im = Image.open(io.BytesIO(b))
        im.draft("RGB", (RES * 2, RES * 2))
        return norm(to_t(rrc(im.convert("RGB"))))
    r_draft = timeit("draft(448) + full pipeline", f_draft, blobs)

    def f_bil(b):
        return norm(to_t(rrc_bil(Image.open(io.BytesIO(b)).convert("RGB"))))
    r_bil = timeit("BILINEAR instead of BICUBIC", f_bil, blobs)

    def f_np(b):
        im = rrc(Image.open(io.BytesIO(b)).convert("RGB"))
        a = np.asarray(im, dtype=np.uint8)
        return torch.from_numpy(a)
    r_np = timeit("crop -> uint8 numpy (norm deferred to GPU)", f_np, blobs)

    print("")
    print("=" * 70)
    print("baseline real pipeline: %.1f img/s   x12 workers = %.0f" % (r_all, r_all * 12))
    for lab, r in [("draft", r_draft), ("bilinear", r_bil), ("uint8+GPU norm", r_np)]:
        print("  %-16s %8.1f img/s  (%.2fx)   x12 = %.0f" % (lab, r, r / r_all, r * 12))
    print("measured loader ceiling ~1,012 img/s; training ~655 img/s")
    print("=" * 70)


if __name__ == "__main__":
    main()
