#!/usr/bin/env python3
"""Is 700 img/s reasonable for a 38M ViT on an RTX 3080? Compute the roofline.

Rather than guessing, count the actual FLOPs of a forward pass and compare the
achieved rate against the card spec. That tells us whether we are near a
hardware limit (nothing more to win) or leaving performance on the table.
"""
import time

import torch


def main():
    import sys
    import os
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from train_student import Student

    ARCH = "timm:vit_medium_patch16_clip_224.tinyclip_yfcc15m"
    st = Student(ARCH, "pretrained")
    params = sum(p.numel() for p in st.parameters())
    print("params: %.1fM" % (params / 1e6))

    try:
        from timm.utils import model as _m  # noqa
    except Exception:
        pass

    # FLOPs via torch profiler flop counter if available
    dev = torch.device("cuda")
    model = st.to(dev).eval()
    x = torch.randn(1, 3, 224, 224, device=dev)
    flops = None
    try:
        from torch.utils.flop_counter import FlopCounterMode
        fc = FlopCounterMode(display=False)
        with fc:
            model(x)
        flops = fc.get_total_flops()
        print("fwd FLOPs/img: %.2f GFLOP" % (flops / 1e9))
    except Exception as e:
        print("flop counter unavailable:", str(e)[:60])

    # measured throughput, fwd+bwd+step
    model = model.train()
    opt = torch.optim.AdamW(model.parameters(), lr=7e-5)
    B = 96
    xb = torch.randn(B, 3, 224, 224, device=dev)
    yb = torch.randn(B, 768, device=dev)
    yb = yb / yb.norm(dim=-1, keepdim=True)

    def step():
        with torch.amp.autocast("cuda", dtype=torch.bfloat16):
            out = model(xb)
            loss = (1 - (out * yb).sum(-1)).mean()
        loss.backward()
        opt.step()
        opt.zero_grad(set_to_none=True)

    for _ in range(8):
        step()
    torch.cuda.synchronize()
    t0 = time.time()
    N = 25
    for _ in range(N):
        step()
    torch.cuda.synchronize()
    el = time.time() - t0
    rate = N * B / el
    print("measured: %.1f img/s (fwd+bwd+step, bf16)" % rate)

    if flops:
        # training is ~3x forward FLOPs (fwd + bwd is ~2x fwd)
        train_flops = 3.0 * flops
        achieved = rate * train_flops / 1e12
        print("")
        print("achieved: %.1f TFLOP/s (training, = 3x fwd)" % achieved)
        # RTX 3080 (GA102, 8704 CUDA cores @ ~1.71 GHz)
        print("")
        print("RTX 3080 spec:")
        print("  fp32 (non-tensor)      ~29.8 TFLOP/s")
        print("  bf16/fp16 tensor core  ~119 TFLOP/s (dense, no sparsity)")
        print("")
        print("  => we are at %.1f%% of dense tensor-core peak" % (100 * achieved / 119.0))
        print("  (60-70%% is typical for real ViT training; >80%% is exceptional)")


if __name__ == "__main__":
    main()
