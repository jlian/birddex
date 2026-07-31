#!/usr/bin/env python3
"""How much does quantisation hurt accuracy? Answered on GPU, in PyTorch.

No ONNX, no export formats, no runtime plumbing. Quantise the WEIGHTS the way
each deployment format would, run the normal GPU eval, compare top-1. That
isolates the only thing actually in question: what the precision loss costs.

  fp16   - exactly what Core ML / WebGPU ship. Native torch, lossless to run.
  bf16   - wider exponent, narrower mantissa; a useful contrast to fp16.
  int8   - per-output-channel symmetric fake-quant of every Linear/Conv weight,
           which is what dynamic int8 does to the weights.
  int4   - same, 4-bit, block-wise (block=128) like MatMulNBitsQuantizer.

Activations stay fp32/fp16: dynamic quantisation only quantises weights, so
this measures the same thing the deployed model would suffer.
"""
import argparse
import json
import os
import sys
import time

import numpy as np
import torch
import torch.nn as nn


def log(m):
    print("[" + time.strftime("%H:%M:%S") + "] " + str(m), flush=True)


def fake_quant_int(w, bits, block=0):
    """Symmetric fake-quant, per output channel, optionally block-wise."""
    qmax = 2 ** (bits - 1) - 1
    orig_shape = w.shape
    x = w.reshape(orig_shape[0], -1).float()
    if block and x.shape[1] % block == 0:
        x = x.reshape(-1, block)
    s = x.abs().amax(dim=1, keepdim=True) / qmax
    s = torch.where(s == 0, torch.ones_like(s), s)
    q = torch.clamp(torch.round(x / s), -qmax - 1, qmax)
    return (q * s).reshape(orig_shape).to(w.dtype)


def apply_weight_quant(model, bits, block=0):
    """Quantise EVERY weight matrix, not just nn.Linear/nn.Conv2d.

    nn.MultiheadAttention stores its projections as a raw Parameter
    (attn.in_proj_weight, 1.77M each x 12 blocks = 21.2M params, 24.5% of
    the model). An isinstance(nn.Linear) filter SKIPS those entirely,
    which both understates compression and overstates accuracy.
    """
    n = 0
    done = set()
    for m in model.modules():
        if isinstance(m, (nn.Linear, nn.Conv2d)):
            with torch.no_grad():
                m.weight.copy_(fake_quant_int(m.weight.data, bits, block))
            done.add(id(m.weight))
            n += 1
    # sweep up every remaining 2-D weight (attention in_proj, etc.)
    for name, prm in model.named_parameters():
        if id(prm) in done or prm.dim() < 2:
            continue
        with torch.no_grad():
            prm.copy_(fake_quant_int(prm.data, bits, block))
        n += 1
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--nabirds", default="nabirds")
    ap.add_argument("--nb-map", default="nabirds_to_taxo.json")
    ap.add_argument("--taxonomy", required=True)
    ap.add_argument("--batch", type=int, default=128)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from eval_nabirds import load_samples, build_text_classifier
    from train_student import Student
    from PIL import Image

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    log("device " + dev)

    taxo = json.load(open(args.taxonomy))
    nb_map = json.load(open(args.nb_map))
    samples = load_samples(args.nabirds, nb_map, None)
    if args.limit:
        samples = samples[:args.limit]
    log("nabirds " + str(len(samples)) + " images")

    tf, txt_model = build_text_classifier(taxo, dev)
    del txt_model
    torch.cuda.empty_cache()
    tf = tf.to(dev).float()
    log("text classifier " + str(tuple(tf.shape)))

    ck = torch.load(args.checkpoint, map_location="cpu")
    ca = ck.get("args", {})

    def fresh():
        s = Student(ca.get("arch", "ViT-B-16"),
                    ca.get("pretrained", "laion2b_s34b_b88k"))
        s.load_state_dict(ck["model"])
        return s.eval()

    pp = fresh().preprocess

    # preprocess once, keep on CPU in uint8-free float16 to bound memory
    log("preprocessing once into a memmap ...")
    mmpath = "/tmp/qa_pixels.f16"
    probe = pp(Image.open(samples[0][0]).convert("RGB"))
    R = probe.shape[-1]
    mm = np.memmap(mmpath, dtype=np.float16, mode="w+",
                   shape=(len(samples), 3, R, R))
    labs = []
    k = 0
    for i, (p, lab) in enumerate(samples):
        try:
            mm[k] = pp(Image.open(p).convert("RGB")).numpy().astype(np.float16)
            labs.append(lab)
            k += 1
        except Exception:
            pass
        if (i + 1) % 6000 == 0:
            log("  " + str(i + 1) + "/" + str(len(samples)))
    mm.flush()
    X = np.memmap(mmpath, dtype=np.float16, mode="r",
                  shape=(len(samples), 3, R, R))[:k]
    y = torch.tensor(labs)
    log("pixels " + str(tuple(X.shape)) + "  {:.1f} GB on disk".format(
        X.size * 2 / 1e9))

    def run(model, dtype):
        model = model.to(dev).eval()
        if dtype is not None:
            model = model.to(dtype)
        outs = []
        with torch.no_grad():
            for i in range(0, len(X), args.batch):
                b = torch.from_numpy(np.ascontiguousarray(X[i:i + args.batch])).to(dev)
                b = b.to(dtype) if dtype is not None else b.float()
                e = model(b).float()
                outs.append(torch.nn.functional.normalize(e, dim=-1).cpu())
        model.cpu()
        torch.cuda.empty_cache()
        return torch.cat(outs)

    variants = [
        ("fp32", lambda: fresh(), None, 0, 4.0),
        ("fp16", lambda: fresh(), torch.float16, 0, 2.0),
        ("bf16", lambda: fresh(), torch.bfloat16, 0, 2.0),
        ("int8", lambda: fresh(), None, 8, 1.0),
        ("int4-blk128", lambda: fresh(), None, 4, 0.5),
        ("int3-blk128", lambda: fresh(), None, 3, 0.375),
        ("int2-blk128", lambda: fresh(), None, 2, 0.25),
    ]

    ref = None
    rows = []
    nparam = None
    for tag, mk, dt, bits, bpw in variants:
        m = mk()
        if nparam is None:
            nparam = sum(p.numel() for p in m.parameters())
        if bits:
            nq = apply_weight_quant(m, bits, block=128 if bits == 4 else 0)
            log(tag + ": fake-quantised " + str(nq) + " Linear/Conv layers")
        t0 = time.time()
        E = run(m, dt)
        dt_s = time.time() - t0
        sims = E.to(dev) @ tf.T
        p1 = sims.argmax(dim=1).cpu()
        top5 = sims.topk(5, dim=1).indices.cpu()
        a1 = float((p1 == y).float().mean())
        a5 = float((top5 == y.unsqueeze(1)).any(dim=1).float().mean())
        if ref is None:
            ref, refp = E, p1
            cos, agree = 1.0, 1.0
        else:
            cos = float((ref * E).sum(dim=1).mean())
            agree = float((p1 == refp).float().mean())
        rows.append((tag, nparam * bpw / 1e6, cos, agree, a1, a5, dt_s))
        log(tag + " top-1 {:.2f}  ({:.0f}s)".format(100 * a1, dt_s))
        del m, E, sims
        torch.cuda.empty_cache()

    print()
    print("HOW MUCH DOES QUANTISATION HURT? (NABirds, " + str(len(y)) + " images)")
    print()
    print("variant       ~MB   cos(fp32)  agree%   top-1   top-5   d(top-1)   sec")
    print("-" * 76)
    base = rows[0][4]
    for tag, mbs, cos, agree, a1, a5, dts in rows:
        d = 100 * (a1 - base)
        print(tag.ljust(12) + "{:6.0f}   {:9.6f}  {:6.2f}  {:6.2f}  {:6.2f}   {:+6.2f}  {:5.0f}".format(
            mbs, cos, 100 * agree, 100 * a1, 100 * a5, d, dts))
    print()
    print("=== QUANT ACCURACY DONE ===")


if __name__ == "__main__":
    main()
