#!/usr/bin/env python3
"""Measure the cost of quantizing the probe row to int8 in the shipped
classifier file's per-row format.

The app embeds through the int8 ONNX tower, so the probe that ships is the
one fitted in THAT space (refit_probe_onnx.npz), not the fp32 arm
(refit_probe_a060.npz). Platt (a,b) likewise comes from the a060-int8 arm.

The classifier layout is an int8 matrix followed by fp32 per-row scales, so
one extra 768-d row costs 772 bytes and needs NO format change. The row is
quantized exactly as emit_int8_classifier.py does it:
    scale = max|w| / 127 ;  q = clip(round(w / scale), -127, 127)
"""
import json

import numpy as np

EPS = 1e-7
PROBE = '/home/jlian/refit_probe_onnx.npz'
CACHE = '/home/jlian/refit_cache_onnx.npz'
# Platt for the a060-int8 arm, from /home/jlian/refit_a060.json.
PA = 1.248338657716024
PB = 2.1821600341974303
# bird_q 0.5% threshold, a060-int8 arm, a quantile of FIT-half bird P_raw.
THR_RAW = 0.10477584731235684


def sig(x):
    return 1.0 / (1.0 + np.exp(-x))


def logit(p):
    p = np.clip(p, EPS, 1 - EPS)
    return np.log(p / (1 - p))


def load(path):
    d = np.load(path)
    e = d['emb'].astype(np.float64)
    return e / np.linalg.norm(e, axis=1, keepdims=True)


def quant_row(w):
    scale = float(np.abs(w).max()) / 127.0
    if scale == 0:
        scale = 1e-12
    q = np.clip(np.round(w / scale), -127, 127).astype(np.int8)
    return q, scale


def main():
    pr = np.load(PROBE)
    w = pr['coef'].astype(np.float64).ravel()
    b = float(pr['intercept'].ravel()[0])
    q, scale = quant_row(w)
    wq = q.astype(np.float64) * scale

    out = {}
    out['probe_source'] = PROBE
    out['bias'] = b
    out['platt'] = {'a': PA, 'b': PB}
    out['thr_raw'] = THR_RAW
    out['thr_cal'] = float(sig(PA * logit(THR_RAW) + PB))
    out['quant'] = {
        'scale': scale,
        'max_abs_w': float(np.abs(w).max()),
        'cos_wq_w': float(wq @ w / (np.linalg.norm(wq) * np.linalg.norm(w))),
        'max_abs_dw': float(np.abs(wq - w).max()),
        'n_saturated': int((np.abs(q) == 127).sum()),
    }

    sets = {
        'val_bird': None,
        'hardneg': '/home/jlian/hardneg_emb_onnx.npz',
        'imagenette': '/home/jlian/imagenette_emb_onnx.npz',
        'nabirds': '/home/jlian/nabirds_emb_onnx.npz',
    }

    # Validation birds: the cached P_raw in refit_cache_onnx.npz was computed
    # by sklearn on the same fitted probe, so recomputing from the raw
    # embeddings must reproduce it. Rebuild the val-bird embedding matrix the
    # same way refit_prep_onnx.py split it.
    import pandas as pd
    import torch
    d = np.load('/home/jlian/bird_emb_onnx.npz')
    e = d['emb'].astype(np.float64)
    e = e / np.linalg.norm(e, axis=1, keepdims=True)
    keys = np.array([int(x) for x in d['key']])
    df = pd.read_parquet(
        '/home/jlian/wingdex/ml/distill/calib_cands_tiny39_a060.parquet')
    n = len(df)
    torch.manual_seed(0)
    perm = torch.randperm(n).numpy()
    cut = int(n * 0.7)
    tr_pid = set(int(p) for p in df['photo_id'].values[perm[:cut]])
    va_pid = set(int(p) for p in df['photo_id'].values[perm[cut:]])
    b_tr = e[np.array([int(p) in tr_pid for p in keys])]
    b_va = e[np.array([int(p) in va_pid for p in keys])]

    z = np.load(CACHE)
    chk_tr = np.abs(sig(b_tr @ w + b) - z['btr_pbird']).max()
    chk_va = np.abs(sig(b_va @ w + b) - z['bva_pbird']).max()
    out['reproduce_cached_praw'] = {
        'btr_max_abs_diff': float(chk_tr),
        'bva_max_abs_diff': float(chk_va),
        'n_btr': int(len(b_tr)),
        'n_bva': int(len(b_va)),
    }

    mats = {'val_bird': b_va}
    for k, p in sets.items():
        if p is not None:
            mats[k] = load(p)

    rows = []
    for name, m in mats.items():
        r32 = sig(m @ w + b)
        r8 = sig(m @ wq + b)
        c32 = sig(PA * logit(r32) + PB)
        c8 = sig(PA * logit(r8) + PB)
        d_cal = np.abs(c8 - c32)
        f32 = float((r32 < THR_RAW).mean())
        f8 = float((r8 < THR_RAW).mean())
        rows.append(dict(
            set=name, n=int(len(m)),
            max_dP_cal=float(d_cal.max()),
            mean_dP_cal=float(d_cal.mean()),
            p99_dP_cal=float(np.quantile(d_cal, 0.99)),
            flag_fp32probe=f32, flag_int8probe=f8,
            flag_delta_pp=float(100.0 * (f8 - f32)),
        ))
    out['rows'] = rows
    out['max_dP_cal_all'] = max(r['max_dP_cal'] for r in rows)
    out['max_abs_flag_delta_pp'] = max(abs(r['flag_delta_pp']) for r in rows)

    print(json.dumps(out, indent=1))
    with open('/home/jlian/probe_quant.json', 'w') as f:
        json.dump(out, f, indent=1)

    print('')
    print('PROBE ROW int8 QUANTIZATION, effect on P_cal and on the gate')
    print('  set             n       max|dP_cal|  mean|dP_cal|   '
          'flag fp32   flag int8   delta_pp')
    for r in rows:
        print('  ' + r['set'].ljust(14) + str(r['n']).rjust(6) +
              ('%.6f' % r['max_dP_cal']).rjust(14) +
              ('%.6f' % r['mean_dP_cal']).rjust(14) +
              ('%.4f%%' % (100 * r['flag_fp32probe'])).rjust(12) +
              ('%.4f%%' % (100 * r['flag_int8probe'])).rjust(12) +
              ('%+.4f' % r['flag_delta_pp']).rjust(11))
    print('')
    print('  worst flag movement %.4f pp (ship-if <= 0.1 pp)'
          % out['max_abs_flag_delta_pp'])
    print('  equivalent P_cal threshold %.10f' % out['thr_cal'])


main()
