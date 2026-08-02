#!/usr/bin/env python3
"""Ramped GPU load for the Tomahawk hard-hang investigation.

Shaped like the workload that actually crashed: fp16 matmul-heavy work on the
RTX 3080, with periodic host<->device transfers so the PCIe link and the
memory controller are exercised too, not just the SMs.

RAMPED ON PURPOSE. A flat 100% burn tells you only pass/fail. Stepping the
intensity up means that if it dies we know WHICH step killed it, which
separates "any load at all" from "only near peak power draw".

Prints a flush-on-every-line progress record so the last surviving line is
evidence if the machine hard-hangs and takes its own logs with it.
"""
import argparse
import time

import torch


def log(m):
    print("[%s] %s" % (time.strftime("%H:%M:%S"), m), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=int, default=900)
    ap.add_argument("--size", type=int, default=8192)
    args = ap.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("no CUDA")
    dev = torch.device("cuda")
    name = torch.cuda.get_device_name(0)
    total = torch.cuda.get_device_properties(0).total_memory / 1e9
    log("device: %s  %.1f GB" % (name, total))
    log("target duration: %ds" % args.seconds)

    # Ramp: fraction of each second spent computing. 1.0 = saturated.
    steps = [(0.25, "25%"), (0.50, "50%"), (0.75, "75%"), (1.00, "100%")]
    per_step = max(30, args.seconds // (len(steps) + 2))

    n = args.size
    a = torch.randn(n, n, device=dev, dtype=torch.float16)
    b = torch.randn(n, n, device=dev, dtype=torch.float16)
    host = torch.randn(2048, 2048, dtype=torch.float32).pin_memory()
    log("allocated %dx%d fp16 pair (~%.1f GB)" % (n, n, 3 * n * n * 2 / 1e9))

    t_end = time.time() + args.seconds
    it = 0
    for duty, label in steps:
        t_step = time.time() + per_step
        log("--- ramp %s duty for %ds ---" % (label, per_step))
        while time.time() < t_step and time.time() < t_end:
            t0 = time.time()
            while time.time() - t0 < duty:
                c = a @ b
                a = (c * 0.0001).half()
                it += 1
            # exercise PCIe + copy engines as well as the SMs
            g = host.to(dev, non_blocking=True)
            _ = (g * 1.0001).sum().item()
            torch.cuda.synchronize()
            if time.time() - t0 < 1.0:
                time.sleep(max(0.0, 1.0 - (time.time() - t0)))
        log("  step %s done, iters=%d, mem=%.2f GB" %
            (label, it, torch.cuda.memory_allocated() / 1e9))

    # sustained saturation for whatever time remains
    if time.time() < t_end:
        log("--- sustained 100%% until %ds elapse ---" % args.seconds)
        last = time.time()
        while time.time() < t_end:
            c = a @ b
            a = (c * 0.0001).half()
            it += 1
            if time.time() - last >= 10:
                torch.cuda.synchronize()
                log("  sustained: iters=%d  remaining=%ds" %
                    (it, int(t_end - time.time())))
                last = time.time()

    torch.cuda.synchronize()
    log("SURVIVED. total iters=%d" % it)


if __name__ == "__main__":
    main()
