#!/usr/bin/env python3
"""Re-derive the bird_q 0.5% threshold against the QUANTIZED probe row.

The client scores with the int8-quantized w, so a threshold taken as a
quantile of FIT-half bird P_raw computed with the SAME quantized w puts the
shipped gate exactly at bird_q 0.5% by construction, instead of inheriting
the fp32-probe threshold and drifting.
"""
import json

import numpy as np
import pandas as pd
import torch

EPS = 1e-7
PA = 1.248338657716024
PB = 2.1821600341974303
Q = 0.005


def sig(x):
    return 1.0 / (1.0 + np.exp(-x))


def logit(p):
    p = np.clip(p, EPS, 1 - EPS)
    return np.log(p / (1 - p))


def load(path):
    d = np.load(path)
    e = d['emb'].astype(np.float64)
    return e / np.linalg.norm(e, axis=1, keepdims=True)


def main():
    pr = np.load('/home/jlian/refit_probe_onnx.npz')
    w = pr['coef'].astype(np.float64).ravel()
    b = float(pr['intercept'].ravel()[0])
    scale = float(np.abs(w).max()) / 127.0
    q = np.clip(np.round(w / scale), -127, 127).astype(np.int8)
    wq = q.astype(np.float64) * scale

    d = np.load('/home/jlian/bird_emb_onnx.npz')
    e = d['emb'].astype(np.float64)
    e = e / np.linalg.norm(e, axis=1, keepdims=True)
    keys = np.array([int(x) for x in d['key']])
    df = pd.read_parquet(
        '/home/jlian/wingdex/ml/distill/calib_cands_tiny39_a060.parquet')
    torch.manual_seed(0)
    perm = torch.randperm(len(df)).numpy()
    cut = int(len(df) * 0.7)
    tr_pid = set(int(p) for p in df['photo_id'].values[perm[:cut]])
    va_pid = set(int(p) for p in df['photo_id'].values[perm[cut:]])
    b_tr = e[np.array([int(p) in tr_pid for p in keys])]
    b_va = e[np.array([int(p) in va_pid for p in keys])]

    hn = load('/home/jlian/hardneg_emb_onnx.npz')
    im = load('/home/jlian/imagenette_emb_onnx.npz')
    nb = load('/home/jlian/nabirds_emb_onnx.npz')

    out = {}
    for tag, ww in [('fp32probe', w), ('int8probe', wq)]:
        thr = float(np.quantile(sig(b_tr @ ww + b), Q))
        r = dict(
            thr_raw=thr,
            thr_cal=float(sig(PA * logit(thr) + PB)),
            val_bird_flag=float((sig(b_va @ ww + b) < thr).mean()),
            hardneg_rej=float((sig(hn @ ww + b) < thr).mean()),
            imagenette_rej=float((sig(im @ ww + b) < thr).mean()),
            nabirds_rej=float((sig(nb @ ww + b) < thr).mean()),
        )
        out[tag] = r

    # Also: the shipped path (quantized w) evaluated at the FP32-derived
    # threshold, which is what "just append the row and keep the old number"
    # would do.
    thr32 = out['fp32probe']['thr_raw']
    out['int8probe_at_fp32_thr'] = dict(
        thr_raw=thr32,
        val_bird_flag=float((sig(b_va @ wq + b) < thr32).mean()),
        hardneg_rej=float((sig(hn @ wq + b) < thr32).mean()),
        imagenette_rej=float((sig(im @ wq + b) < thr32).mean()),
        nabirds_rej=float((sig(nb @ wq + b) < thr32).mean()),
    )
    out['n'] = dict(b_tr=int(len(b_tr)), b_va=int(len(b_va)),
                    hardneg=int(len(hn)), imagenette=int(len(im)),
                    nabirds=int(len(nb)))
    out['quant'] = dict(scale=scale,
                        int8_row_first8=[int(x) for x in q[:8]],
                        bias=b)

    print(json.dumps(out, indent=1))
    with open('/home/jlian/probe_thr.json', 'w') as f:
        json.dump(out, f, indent=1)

    print('')
    print('bird_q 0.5% GATE, threshold derived per scorer')
    print('  scorer                      thr_raw     bird_flag  '
          'hardneg_rej  imagenette_rej  nabirds_rej')
    for k in ['fp32probe', 'int8probe', 'int8probe_at_fp32_thr']:
        r = out[k]
        print('  ' + k.ljust(24) + ('%.6f' % r['thr_raw']).rjust(11) +
              ('%.4f%%' % (100 * r['val_bird_flag'])).rjust(12) +
              ('%.2f%%' % (100 * r['hardneg_rej'])).rjust(13) +
              ('%.2f%%' % (100 * r['imagenette_rej'])).rjust(16) +
              ('%.4f%%' % (100 * r['nabirds_rej'])).rjust(13))
    print('')
    print('  SHIP: int8probe thr_raw %.10f  thr_cal %.10f'
          % (out['int8probe']['thr_raw'], out['int8probe']['thr_cal']))


main()
