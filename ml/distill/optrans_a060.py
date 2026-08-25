#!/usr/bin/env python3
"""Operating-point transfer, identical criterion to onnx_refit.py STEP 4.

onnx_refit measured: one probe, threshold = 0.1% quantile of that probe's
scores on ONNX val birds, applied to ONNX embeddings (the app) and to
PyTorch embeddings (the harness) of the SAME images. It found hardneg
rejection collapsing by -10.94 pp between the two. The PyTorch side there
was the a0.90 checkpoint.

This repeats the exact criterion twice:
  A  int8 vs a0.90 fp32   reproduce the old number
  B  int8 vs a0.60 fp32   same thing with alpha held fixed
The difference between A and B is the part of the collapse that was ALPHA.
"""
import json

import numpy as np
import pandas as pd
import torch

EPS = 1e-7


def sig(x):
    return 1.0 / (1.0 + np.exp(-x))


def pct(v):
    return '%.2f%%' % (100 * v)


def load(p):
    d = np.load(p)
    e = d['emb'].astype(np.float64)
    return e / np.linalg.norm(e, axis=1, keepdims=True), np.array(
        [str(x) for x in d['key']])


def main():
    pr = np.load('/home/jlian/refit_probe_onnx.npz')
    c = pr['coef'].astype(np.float64).ravel()
    i0 = float(pr['intercept'].ravel()[0])

    df = pd.read_parquet(
        '/home/jlian/wingdex/ml/distill/calib_cands_tiny39_a060.parquet')
    n = len(df)
    torch.manual_seed(0)
    perm = torch.randperm(n).numpy()
    va_pid = set(int(p) for p in df['photo_id'].values[perm[int(n * 0.7):]])

    bo, bk = load('/home/jlian/bird_emb_onnx.npz')
    vam = np.array([int(p) in va_pid for p in bk])
    p_val_onnx = sig(bo[vam] @ c + i0)
    thr = float(np.quantile(p_val_onnx, 0.001))
    print('  ONNX-fitted probe, threshold = 0.1% quantile of ONNX val birds')
    print('  threshold ' + ('%.6f' % thr))
    print('')

    out = {'thr': thr, 'arms': {}}
    for label, suffix in [('a0.90 fp32 (the OLD comparison arm)', ''),
                          ('a0.60 fp32 (alpha held FIXED)', '_a060')]:
        print('  int8(app) vs ' + label)
        print('  ' + 'set'.ljust(13) + 'int8(app)'.rjust(12) +
              'pytorch'.rjust(12) + 'delta'.rjust(14))
        rows = {}
        for nm, stem in [('bird', 'bird_emb'), ('hardneg', 'hardneg_emb'),
                         ('imagenette', 'imagenette_emb'),
                         ('nabirds', 'nabirds_emb')]:
            eo, _ = load('/home/jlian/' + stem + '_onnx.npz')
            ep, _ = load('/home/jlian/' + stem + suffix + '.npz')
            fo = float((sig(eo @ c + i0) < thr).mean())
            fp = float((sig(ep @ c + i0) < thr).mean())
            rows[nm] = dict(int8=fo, pytorch=fp, delta_pp=100 * (fo - fp))
            print('  ' + nm.ljust(13) + pct(fo).rjust(12) + pct(fp).rjust(12) +
                  ('%+.2f pp' % (100 * (fo - fp))).rjust(14))
        out['arms'][label] = rows
        print('')

    json.dump(out, open('/home/jlian/optrans_a060.json', 'w'), indent=1)
    print('wrote /home/jlian/optrans_a060.json')
    print('=== OPTRANS DONE ===')


if __name__ == '__main__':
    main()
