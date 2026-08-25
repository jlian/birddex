#!/usr/bin/env python3
"""Does the PyTorch-fitted abstention threshold TRANSFER to ONNX embeddings?

parity_emb.py showed max |dP_cal| = 0.0209, above the 0.01 gate, and the drift
is systematically POSITIVE (ONNX reads more bird-like than PyTorch). A bias in
that direction makes the gate reject FEWER non-birds than measured.

This measures the operating point directly rather than inferring it:
  1. threshold = 0.1% quantile of P_cal over PyTorch validation birds
     (the shipped rule)
  2. apply that SAME threshold to ONNX embeddings of the same images
  3. report flagged-bird rate and hardneg / imagenette rejection under both

If the ONNX rejection rates collapse relative to the PyTorch numbers
(51.6% hardneg, 69.0% imagenette), the threshold does not transfer and the
gate must be refit on ONNX embeddings before shipping.
"""
import argparse
import io
import json
import os
import sys
import tarfile
import time

import numpy as np
import pandas as pd
import torch
import torch.nn.functional as F
from PIL import Image

sys.path.insert(0, '/home/jlian/wingdex/ml/distill')
import emit_calib_candidates as E

A = 1.3595343229097947
B = 2.581534818041523


def log(m):
    print('[' + time.strftime('%H:%M:%S') + '] ' + str(m), flush=True)


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


def logit(p):
    p = np.clip(p, 1e-12, 1 - 1e-12)
    return np.log(p / (1 - p))


def pcal(e, coef, inter):
    return sigmoid(A * logit(sigmoid(e @ coef + inter)) + B)


def encode_dir(d, preprocess, st, sess, iname, device, limit, keep=None):
    """Return (pt_emb, onnx_emb, keys) for up to `limit` images in shard dir."""
    pt = []
    on = []
    keys = []
    buf = []
    bk = []

    def flush():
        if not buf:
            return
        x = torch.stack(buf).to(device)
        with torch.no_grad():
            a = F.normalize(st(x), dim=-1).cpu().numpy().astype(np.float64)
        xn = x.cpu().numpy().astype(np.float32)
        b = sess.run(None, {iname: xn})[0].astype(np.float64)
        b = b / np.linalg.norm(b, axis=1, keepdims=True)
        for i in range(len(buf)):
            pt.append(a[i])
            on.append(b[i])
            keys.append(bk[i])
        buf.clear()
        bk.clear()

    for sh in sorted(f for f in os.listdir(d) if f.endswith('.tar')):
        with tarfile.open(os.path.join(d, sh)) as tf:
            for m in tf:
                if len(keys) + len(buf) >= limit:
                    break
                if not m.isfile():
                    continue
                low = m.name.lower()
                if not low.endswith(('.jpg', '.jpeg', '.png')):
                    continue
                key = os.path.basename(m.name)
                key = key[:key.rindex('.')]
                if keep is not None and key not in keep:
                    continue
                try:
                    bts = tf.extractfile(m).read()
                    im = Image.open(io.BytesIO(bts)).convert('RGB')
                except Exception:
                    continue
                buf.append(preprocess(im))
                bk.append(key)
                if len(buf) >= 64:
                    flush()
                    log('  ' + os.path.basename(d) + ': ' + str(len(keys)))
        if len(keys) + len(buf) >= limit:
            break
    flush()
    return (np.array(pt), np.array(on), keys)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--checkpoint',
                    default='/home/jlian/wingdex/ml/distill/runs/'
                            'ft_tiny39_fresh/wise_a0.90.pt')
    ap.add_argument('--onnx',
                    default='/home/jlian/wingdex/public/models/'
                            'wingclip_visual_int8.onnx')
    ap.add_argument('--nbird', type=int, default=700)
    ap.add_argument('--nneg', type=int, default=700)
    ap.add_argument('--out', default='/home/jlian/parity_gate.json')
    args = ap.parse_args()

    pr = np.load('/home/jlian/refit_probe.npz')
    coef = pr['coef'].astype(np.float64).ravel()
    inter = float(pr['intercept'].ravel()[0])

    df = pd.read_parquet('/home/jlian/wingdex/ml/distill/'
                         'calib_cands_tiny39_a060.parquet')
    n = len(df)
    g = torch.Generator()
    g.manual_seed(0)
    perm = torch.randperm(n, generator=g).numpy()
    val_pid = set(str(int(p))
                  for p in df['photo_id'].values[perm[int(n * 0.7):]])
    log('val split ' + str(len(val_pid)))

    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    st, preprocess = E.load_student(args.checkpoint,
                                    '/home/jlian/wingdex/ml/distill', device)
    import onnxruntime as ort
    sess = ort.InferenceSession(args.onnx,
                                providers=['CPUExecutionProvider'])
    iname = sess.get_inputs()[0].name
    log('models loaded on ' + device)

    DS = '/mnt/nas/WingDex-Distill/datasets/'
    log('encoding validation birds')
    bp, bo, _ = encode_dir(DS + 'calib-11k-500px', preprocess, st, sess,
                           iname, device, args.nbird, keep=val_pid)
    log('encoding hard negatives')
    hp, ho, _ = encode_dir(DS + 'eval-hard-negatives-nonbird', preprocess,
                           st, sess, iname, device, args.nneg)
    log('encoding imagenette')
    ip, io_, _ = encode_dir(DS + 'eval-imagenette-easy-negatives', preprocess,
                            st, sess, iname, device, args.nneg)
    log('encoded  birds ' + str(len(bp)) + '  hardneg ' + str(len(hp)) +
        '  imagenette ' + str(len(ip)))

    P = {}
    for nm, (a, b) in [('bird', (bp, bo)), ('hardneg', (hp, ho)),
                       ('imagenette', (ip, io_))]:
        P[nm] = (pcal(a, coef, inter), pcal(b, coef, inter))

    # The shipped rule: threshold = 0.1% quantile over PyTorch birds.
    thr_pt = float(np.quantile(P['bird'][0], 0.001))
    # What the threshold WOULD be if refit on ONNX birds.
    thr_on = float(np.quantile(P['bird'][1], 0.001))

    print('')
    print('=== ABSTENTION GATE TRANSFER: PyTorch threshold on ONNX ===')
    print('')
    print('  threshold fitted on PyTorch birds (0.1% quantile)  ' +
          ('%.6f' % thr_pt))
    print('  threshold if refit on ONNX birds  (0.1% quantile)  ' +
          ('%.6f' % thr_on))
    print('')
    print('  ' + 'set'.ljust(14) + 'n'.rjust(6) +
          'flagged pt'.rjust(13) + 'flagged onnx'.rjust(14) +
          'delta'.rjust(10) + '   (PyTorch threshold applied to both)')
    rows = {}
    for nm in ['bird', 'hardneg', 'imagenette']:
        a, b = P[nm]
        fa = float((a < thr_pt).mean())
        fb = float((b < thr_pt).mean())
        rows[nm] = dict(n=len(a), pt=fa, onnx=fb)
        print('  ' + nm.ljust(14) + str(len(a)).rjust(6) +
              ('%.2f%%' % (100 * fa)).rjust(13) +
              ('%.2f%%' % (100 * fb)).rjust(14) +
              ('%+.2f pp' % (100 * (fb - fa))).rjust(10))

    print('')
    print('  mean displayed P_cal')
    for nm in ['bird', 'hardneg', 'imagenette']:
        a, b = P[nm]
        print('  ' + nm.ljust(14) + ('pt %.4f' % a.mean()).rjust(12) +
              ('onnx %.4f' % b.mean()).rjust(14) +
              ('%+.4f' % (b.mean() - a.mean())).rjust(10))

    print('')
    print('  ONNX-vs-PyTorch P_cal drift on the SAME images')
    for nm in ['bird', 'hardneg', 'imagenette']:
        a, b = P[nm]
        d = b - a
        print('  ' + nm.ljust(14) + ('max|d| %.4f' % np.abs(d).max()).rjust(16) +
              ('mean d %+.4f' % d.mean()).rjust(16) +
              ('frac d>0 %.1f%%' % (100 * (d > 0).mean())).rjust(18))
    print('')

    json.dump({'thr_pt': thr_pt, 'thr_onnx': thr_on, 'rows': rows},
              open(args.out, 'w'), indent=2, default=float)
    print('wrote ' + args.out)
    print('=== GATE TRANSFER DONE ===')


if __name__ == '__main__':
    main()
