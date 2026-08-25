"""Emit the end-to-end fixture the TS test checks the shipped path against.

Picks real embeddings from both sides of the gate: birds that pass, hard
negatives and Imagenette images that are rejected, and a couple of NABirds.
P_raw and P_cal are computed in float64 with the QUANTIZED probe row read back
out of the shipped classifier file, so the TS side is compared against the
same weights it loads rather than against the pre-quantization fit.
"""
import json

import numpy as np

DIM = 768
BIN = '/home/jlian/wingdex/public/models/text_classifier_int8.bin'
OUT = '/home/jlian/wingdex/src/__tests__/fixtures/probe-e2e.json'
BIAS = 1.7004907607405835
PA = 1.248338657716024
PB = 2.1821600341974303
THR = 0.3736373465
EPS = 1e-7


def sig(x):
    return 1.0 / (1.0 + np.exp(-x))


def main():
    buf = np.fromfile(BIN, dtype=np.uint8)
    n = len(buf) // (DIM + 4)
    q = buf[:n * DIM].view(np.int8).reshape(n, DIM)
    sc = buf[n * DIM:].view(np.float32)
    w = q[n - 1].astype(np.float64) * float(sc[n - 1])

    cases = []
    src = [('bird', '/home/jlian/bird_emb_onnx.npz', 4),
           ('hardneg', '/home/jlian/hardneg_emb_onnx.npz', 4),
           ('imagenette', '/home/jlian/imagenette_emb_onnx.npz', 4),
           ('nabirds', '/home/jlian/nabirds_emb_onnx.npz', 2)]
    for name, path, k in src:
        e = np.load(path)['emb'].astype(np.float64)
        e = e / np.linalg.norm(e, axis=1, keepdims=True)
        raw = sig(e @ w + BIAS)
        c = np.clip(raw, EPS, 1 - EPS)
        cal = sig(PA * np.log(c / (1 - c)) + PB)
        # Spread across the score range rather than taking the first k, so the
        # fixture straddles the threshold instead of sampling one mode.
        order = np.argsort(cal)
        pick = order[np.linspace(0, len(order) - 1, k).astype(int)]
        for i in pick:
            cases.append(dict(set=name,
                              emb=[float(x) for x in e[i]],
                              pRaw=float(raw[i]),
                              pCal=float(cal[i]),
                              flagged=bool(cal[i] < THR)))

    nf = sum(1 for x in cases if x['flagged'])
    if nf == 0 or nf == len(cases):
        raise SystemExit('fixture does not straddle the threshold')
    with open(OUT, 'w') as f:
        json.dump(dict(cases=cases), f)
    print('wrote %d cases, %d flagged' % (len(cases), nf))


main()
