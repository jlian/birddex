"""Split the int8 ONNX tower into a graph plus an external weights file.

The tower is 39.6 MB, and Cloudflare Pages caps a single asset at 25 MiB, so
shipping it on web needs the weights out of the protobuf. This is the G12
question in the SSOT and was the last untested step in the ship path.

The documented failure mode is "Failed to load external data file, File not
found in preloaded files", caused by the `location` string in the protobuf not
matching the key the browser passes in the externalData session option. So this
script prints the exact location string it wrote, and reloads the split model to
prove onnxruntime resolves it.

Reload is a real gate, not a formality: onnx.save can write a manifest that
points at a file that was never produced, and nothing complains until load.
"""
import argparse
import os

import numpy as np


def log(m):
    print(m, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--base", default="wingclip_visual_int8")
    ap.add_argument("--cap-mib", type=float, default=25.0)
    ap.add_argument("--size-threshold", type=int, default=1024 * 1024)
    ap.add_argument("--one-file", action="store_true",
                    help="one .data blob; usually breaks the 25 MiB cap")
    args = ap.parse_args()

    import onnx

    os.makedirs(args.out_dir, exist_ok=True)
    src_mb = os.path.getsize(args.src) / 1048576
    log("source %s  %.1f MiB" % (os.path.basename(args.src), src_mb))

    m = onnx.load(args.src)
    graph_path = os.path.join(args.out_dir, args.base + ".onnx")
    data_name = args.base + ".data"

    # size_threshold must stay ABOVE zero. At zero every tensor is
    # externalised, including the small constants that shape inference reads
    # at load time, and onnxruntime fails with "Cannot parse data from
    # external tensors" on the Slice in patch_embed. 1 MiB keeps shape
    # constants inline and moves only bulk weights.
    onnx.save_model(
        m,
        graph_path,
        save_as_external_data=True,
        all_tensors_to_one_file=args.one_file,
        location=data_name if args.one_file else None,
        size_threshold=args.size_threshold,
        convert_attribute=False,
    )

    files = sorted(os.listdir(args.out_dir))
    weights = [f for f in files if not f.endswith(".onnx")]
    if not weights:
        raise SystemExit("FAIL: no external weight files were written")

    g_mb = os.path.getsize(graph_path) / 1048576
    sizes = [(f, os.path.getsize(os.path.join(args.out_dir, f)) / 1048576)
             for f in weights]
    d_mb = sum(mb for _, mb in sizes)
    cap_mb = args.cap_mib

    log("")
    log("graph  %-40s %7.2f MiB" % (os.path.basename(graph_path), g_mb))
    log("weight files: %d, %.2f MiB total" % (len(sizes), d_mb))
    for f, mb in sorted(sizes, key=lambda x: -x[1])[:5]:
        log("   %-40s %7.2f MiB" % (f[:40], mb))
    log("total                                          %7.2f MiB"
        % (g_mb + d_mb))
    log("per-file cap                               %7.2f MiB" % cap_mb)

    allf = [(os.path.basename(graph_path), g_mb)] + sizes
    over = [n for n, mb in allf if mb > cap_mb]
    log("")
    if over:
        log("OVER CAP (%d files): %s" % (len(over), ", ".join(over[:4])))
    else:
        log("both files are under the per-file cap")

    # The location string the browser must match exactly.
    locs = set()
    for t in m.graph.initializer:
        for kv in t.external_data:
            if kv.key == "location":
                locs.add(kv.value)
    log("")
    log("location string(s) in the protobuf: %s" % (sorted(locs) or "none yet"))

    # Reload gate: prove onnxruntime resolves the external file.
    import onnxruntime as ort
    sess = ort.InferenceSession(graph_path, providers=["CPUExecutionProvider"])
    iname = sess.get_inputs()[0].name
    x = np.zeros((1, 3, 224, 224), dtype=np.float32)
    out = sess.run(None, {iname: x})[0]
    log("reload OK, output shape %s" % (out.shape,))
    log("")
    log("=== SPLIT DONE ===")


if __name__ == "__main__":
    main()
