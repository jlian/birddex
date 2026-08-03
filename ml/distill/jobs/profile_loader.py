#!/usr/bin/env python3
"""Find what actually sets the ~1,012 img/s loader ceiling.

Measured 2026-08-02: decode alone does 441 img/s on ONE core, and we run 12
workers (~5,300 img/s theoretical), yet the loader tops out near 1,012 and
training runs ~655. So decode is NOT the wall. This isolates the layers:

  A. raw tar read      -- pull bytes off the NAS over SMB, discard immediately
  B. tar + decode      -- add JPEG decode, single process
  C. tar + decode + tf -- add the real training transforms
  D. full DataLoader   -- N workers, batching, collation (what training sees)

Whichever step drops throughput the most IS the bottleneck. Run with the GPU
idle so nothing competes.
"""
import argparse
import glob
import io
import tarfile
import time

from PIL import Image

SHARDS = "/mnt/nas/WingDex-Distill/wds-nabirds401/shard-*.tar"


def log(m):
    print("[%s] %s" % (time.strftime("%H:%M:%S"), m), flush=True)


def stage_a(paths, limit):
    """Raw tar member reads. Pure NAS/SMB + tar parsing cost."""
    n = 0
    byts = 0
    t0 = time.time()
    for p in paths:
        with tarfile.open(p) as tf:
            for m in tf:
                if not m.name.endswith(".jpg"):
                    continue
                byts += len(tf.extractfile(m).read())
                n += 1
                if n >= limit:
                    break
        if n >= limit:
            break
    el = time.time() - t0
    return n, el, byts


def stage_b(paths, limit):
    """tar read + JPEG decode."""
    n = 0
    t0 = time.time()
    for p in paths:
        with tarfile.open(p) as tf:
            for m in tf:
                if not m.name.endswith(".jpg"):
                    continue
                Image.open(io.BytesIO(tf.extractfile(m).read())).convert("RGB")
                n += 1
                if n >= limit:
                    break
        if n >= limit:
            break
    return n, time.time() - t0


def stage_c(paths, limit, preprocess):
    """tar + decode + the real training transform."""
    n = 0
    t0 = time.time()
    for p in paths:
        with tarfile.open(p) as tf:
            for m in tf:
                if not m.name.endswith(".jpg"):
                    continue
                img = Image.open(io.BytesIO(tf.extractfile(m).read())).convert("RGB")
                preprocess(img)
                n += 1
                if n >= limit:
                    break
        if n >= limit:
            break
    return n, time.time() - t0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shards", default=SHARDS)
    ap.add_argument("--limit", type=int, default=3000)
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--batch", type=int, default=96)
    args = ap.parse_args()

    paths = sorted(glob.glob(args.shards))
    log("shards: %d   sampling %d images per stage" % (len(paths), args.limit))

    log("STAGE A: raw tar read over SMB (no decode) ...")
    n, el, byts = stage_a(paths, args.limit)
    a_rate = n / el
    mb = byts / 1e6
    log("  A: %.1f img/s   (%d imgs in %.1fs, %.0f MB, %.1f MB/s)"
        % (a_rate, n, el, mb, mb / el))

    log("STAGE B: tar read + JPEG decode ...")
    n, el = stage_b(paths, args.limit)
    b_rate = n / el
    log("  B: %.1f img/s   (decode costs %.1f%% of stage A)"
        % (b_rate, 100 * (1 - b_rate / a_rate)))

    log("STAGE C: + training transforms ...")
    try:
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from train_student import Student
        st = Student("timm:vit_medium_patch16_clip_224.tinyclip_yfcc15m", "pretrained")
        pp = st.preprocess
        n, el = stage_c(paths, args.limit, pp)
        c_rate = n / el
        log("  C: %.1f img/s   (transforms cost %.1f%% of stage B)"
            % (c_rate, 100 * (1 - c_rate / b_rate)))
    except Exception as e:
        c_rate = None
        log("  C skipped: %s" % e)

    print("")
    print("=" * 62)
    print("SINGLE-PROCESS LAYER COSTS")
    print("  A raw tar/SMB read      %8.1f img/s" % a_rate)
    print("  B + JPEG decode         %8.1f img/s" % b_rate)
    if c_rate:
        print("  C + transforms          %8.1f img/s" % c_rate)
    print("")
    print("  x%d workers (ideal):" % args.workers)
    print("     A %9.0f    B %9.0f%s"
          % (a_rate * args.workers, b_rate * args.workers,
             ("    C %9.0f" % (c_rate * args.workers)) if c_rate else ""))
    print("")
    print("  measured loader ceiling ~1,012 img/s; training ~655 img/s")
    print("  => whichever ideal number is CLOSEST to 1,012 is the real wall")
    print("=" * 62)


if __name__ == "__main__":
    main()
