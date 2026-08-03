#!/usr/bin/env python3
"""Measure the REAL bf16 tensor-core ceiling on this card.

Everything in the hardware analysis rests on one unverified claim: that GeForce
Ampere (GA102) runs bf16/fp16 with fp32 ACCUMULATE at half rate, making our
true ceiling ~59.5 TFLOP/s rather than the 119 on the spec sheet. If that is
right we are at 65% of peak (well tuned, little left). If wrong, we are at 33%
and there is real headroom.

A pure GEMM settles it with no spec-sheet interpretation: run big square
matmuls, count 2*N^3 FLOPs, divide by time. Nothing else is in the loop.

RUN ONLY ON AN IDLE GPU.
"""
import time

import torch


def gemm(n, dtype, iters=50, out_dtype=None):
    dev = torch.device("cuda")
    a = torch.randn(n, n, device=dev, dtype=dtype)
    b = torch.randn(n, n, device=dev, dtype=dtype)
    for _ in range(10):
        c = a @ b
    torch.cuda.synchronize()
    t0 = time.time()
    for _ in range(iters):
        c = a @ b
    torch.cuda.synchronize()
    el = time.time() - t0
    flops = 2.0 * n * n * n * iters
    return flops / el / 1e12


def main():
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    name = torch.cuda.get_device_name(0)
    print("device:", name)
    print("")
    print("%-34s %12s" % ("what", "TFLOP/s"))
    print("-" * 48)

    best = {}
    for n in (4096, 8192):
        for label, dt in (("fp16", torch.float16), ("bf16", torch.bfloat16),
                          ("tf32", torch.float32)):
            try:
                r = gemm(n, dt)
                key = label
                best[key] = max(best.get(key, 0), r)
                print("%-34s %12.1f" % ("%s  N=%d" % (label, n), r))
            except Exception as e:
                print("%-34s %12s" % ("%s N=%d" % (label, n), str(e)[:20]))

    print("")
    print("=" * 48)
    b16 = best.get("bf16", 0)
    print("best bf16 GEMM: %.1f TFLOP/s" % b16)
    print("")
    print("spec fp16 with fp16 accumulate : 119.0")
    print("spec fp16 with fp32 accumulate :  59.5  (half-rate on GeForce Ampere)")
    print("")
    ach = 38.9  # our measured training throughput in TFLOP/s
    if b16 > 0:
        print("our training achieves %.1f TFLOP/s = %.0f%% of this measured GEMM peak"
              % (ach, 100 * ach / b16))
        if b16 < 80:
            print("VERDICT: the half-rate fp32-accumulate claim HOLDS.")
            print("         We are near practical peak; expect ~1.1-1.2x more, not 2x.")
        else:
            print("VERDICT: half-rate claim does NOT hold -- real headroom exists.")


if __name__ == "__main__":
    main()
