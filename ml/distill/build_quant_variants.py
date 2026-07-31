#!/usr/bin/env python3
"""Build EVERY quantisation variant so the runtime decision is data-driven.

Measuring one format tells you nothing about the others, and the three
candidate runtimes want different things:

  iOS Core ML   -> fp16 or palettisation
  Web WebGPU    -> fp16
  Web WASM/CPU  -> dynamic int8

So we need accuracy for all of them before choosing a target. This emits the
variants; eval_nabirds.py --onnx scores each through identical logic.

Note int4: onnxruntime has no general int4 weight path for arbitrary graphs,
so it is emitted only if matmul_4bits_quantizer is importable; otherwise it is
reported as unavailable rather than silently skipped.
"""
import argparse
import os
import time


def log(m):
    print("[" + time.strftime("%H:%M:%S") + "] " + str(m), flush=True)


def mb(p):
    return os.path.getsize(p) / 1e6


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fp32", default="export/wingclip_visual_fp32.onnx")
    ap.add_argument("--out-dir", default="export")
    args = ap.parse_args()

    base = mb(args.fp32)
    log("fp32 baseline {:.1f} MB".format(base))
    made = []

    # ---- fp16: the Core ML / WebGPU format --------------------------
    p16 = os.path.join(args.out_dir, "wingclip_visual_fp16.onnx")
    if not os.path.exists(p16):
        try:
            import onnx
            from onnxconverter_common import float16
            m = onnx.load(args.fp32)
            # keep_io_types=True produced an invalid graph (Cast output
            # float16 vs expected float). Convert the whole graph, so the
            # model takes and returns fp16 and the caller casts.
            m16 = float16.convert_float_to_float16(m, keep_io_types=False)
            onnx.save(m16, p16)
            log("fp16 built")
        except Exception as e:
            log("fp16 FAILED: " + str(e)[:120])
    if os.path.exists(p16):
        made.append(("fp16", p16))

    # ---- uint8 dynamic ----------------------------------------------
    from onnxruntime.quantization import quantize_dynamic, QuantType
    pu8 = os.path.join(args.out_dir, "wingclip_visual_uint8.onnx")
    if not os.path.exists(pu8):
        quantize_dynamic(args.fp32, pu8, weight_type=QuantType.QUInt8)
        log("uint8 built")
    made.append(("uint8", pu8))

    # ---- int4 block-wise on MatMul weights ---------------------------
    p4 = os.path.join(args.out_dir, "wingclip_visual_int4.onnx")
    if not os.path.exists(p4):
        try:
            import onnx
            from onnxruntime.quantization import matmul_nbits_quantizer as m4
            m = onnx.load(args.fp32)
            cfg = m4.DefaultWeightOnlyQuantConfig(block_size=128,
                                                  is_symmetric=True,
                                                  bits=4)
            q = m4.MatMulNBitsQuantizer(m, algo_config=cfg)
            q.process()
            q.model.save_model_to_file(p4, use_external_data_format=False)
            log("int4 built")
        except Exception as e:
            log("int4 UNAVAILABLE: " + str(e)[:140])
    if os.path.exists(p4):
        made.append(("int4", p4))

    print()
    print("variant    size MB   vs fp32")
    print("-" * 34)
    print("fp32     {:8.1f}     1.00x".format(base))
    for tag, p in made:
        s = mb(p)
        print(tag.ljust(8) + " {:8.1f}   {:6.2f}x".format(s, base / s))
    print()
    print("=== VARIANTS BUILT ===")


if __name__ == "__main__":
    main()
