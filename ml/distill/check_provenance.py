#!/usr/bin/env python3
"""Read model provenance back out of an ONNX file, and optionally stamp it in.

WHY THIS EXISTS
---------------
Nothing in the repo recorded which checkpoint produced
public/models/wingclip_visual_int8.onnx. That absence is exactly why a whole
day of measurements got attributed to the wrong file: the artifact could not
answer the question "which weights are you?" and neither could the repo.

ONNX carries string metadata_props on the graph, so the answer can live in
the artifact itself. shipped_model.provenance() builds the mapping and
export paths write it. This script reads it back so provenance is inspectable
without rerunning training or an export.

The declared preprocess_resize / preprocess_crop are the contract the client
must satisfy. src/lib/clip-preprocess.ts sets CLIP_RESIZE 248 and CLIP_CROP
224. If those ever disagree with what the model declares, --expect-resize /
--expect-crop makes it a failure rather than a silent accuracy loss.

Usage:
  python3 check_provenance.py                       read the shipped ONNX
  python3 check_provenance.py --onnx PATH           read another file
  python3 check_provenance.py --stamp               write props onto it
"""
import argparse
import os
import sys

import shipped_model as S


def read_props(path):
    import onnx
    m = onnx.load(path, load_external_data=False)
    return m, dict((p.key, p.value) for p in m.metadata_props)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--onnx", default=S.SHIPPED_ONNX,
                    help="ONNX file to inspect; defaults to the shipped one")
    ap.add_argument("--checkpoint", default=S.SHIPPED_CHECKPOINT,
                    help="checkpoint to attribute when stamping")
    ap.add_argument("--wise-alpha", type=float, default=None,
                    help="override the pinned alpha when stamping")
    ap.add_argument("--stamp", action="store_true",
                    help="write provenance props onto the file in place")
    ap.add_argument("--expect-resize", type=int, default=S.SHIPPED_RESIZE)
    ap.add_argument("--expect-crop", type=int, default=S.SHIPPED_CROP)
    args = ap.parse_args()

    if not os.path.exists(args.onnx):
        print("MISSING: " + args.onnx)
        return 2

    if args.stamp:
        import onnx
        props = S.provenance(args.checkpoint, args.wise_alpha)
        # load_external_data must be True here, or the weights are not in
        # memory and the re-save writes an empty .data file.
        m = onnx.load(args.onnx)
        S.write_provenance(m, props)
        base = os.path.basename(args.onnx)
        data = base.rsplit(".", 1)[0] + ".data"
        dpath = os.path.join(os.path.dirname(os.path.abspath(args.onnx)), data)
        # onnx.save_model APPENDS to an existing external-data file rather
        # than truncating it. Leaving the old blob in place silently doubles
        # it from 24 MiB to 48 MiB and blows the 25 MiB per-file cap that
        # G12 in ml/README.md exists to respect. Remove it first, and put
        # the original mode back afterwards.
        mode = None
        if os.path.exists(dpath):
            mode = os.stat(dpath).st_mode
            os.remove(dpath)
        onnx.save_model(m, args.onnx, save_as_external_data=True,
                        all_tensors_to_one_file=True, location=data,
                        size_threshold=1024 * 1024, convert_attribute=False)
        if mode is not None and os.path.exists(dpath):
            os.chmod(dpath, mode)
        print("stamped " + str(len(props)) + " props onto " + args.onnx)

    m, props = read_props(args.onnx)
    print("")
    print("=== PROVENANCE: " + os.path.basename(args.onnx) + " ===")
    print("")
    print("  producer            " + str(m.producer_name) + " " +
          str(m.producer_version))
    if not props:
        print("  (no metadata_props at all)")
    for k in sorted(props):
        print("  " + k.ljust(38) + props[k])

    want = [k for k in S.provenance() if k not in props]
    print("")
    if want:
        print("INCOMPLETE: missing " + str(len(want)) + " provenance key(s):")
        for k in want:
            print("  " + k)
        print("")
        print("This artifact does NOT record which checkpoint produced it.")
        print("Re-export, or run this script with --stamp.")
        return 1

    rs = props.get(S.META_PREFIX + "preprocess_resize")
    cr = props.get(S.META_PREFIX + "preprocess_crop")
    bad = []
    if rs != str(args.expect_resize):
        bad.append("resize declared " + str(rs) + ", expected " +
                   str(args.expect_resize))
    if cr != str(args.expect_crop):
        bad.append("crop declared " + str(cr) + ", expected " +
                   str(args.expect_crop))
    if bad:
        print("PREPROCESS MISMATCH, the client and the model disagree:")
        for b in bad:
            print("  " + b)
        return 1

    print("OK: provenance complete, preprocess " + str(rs) + "/" + str(cr) +
          " matches the client contract in src/lib/clip-preprocess.ts")
    return 0


if __name__ == "__main__":
    sys.exit(main())
