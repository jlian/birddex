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

SUPERSEDED RESULTS. The PyTorch side of this comparison previously ran
runs/ft_tiny39_fresh/wise_a0.90.pt, a DIFFERENT model from the int8 ONNX
it was being compared against, which was exported from alpha 0.60. Any
earlier delta from this file therefore mixes the quantisation difference
with a 0.34-point model difference and is not a parity measurement. The
default is now the pinned shipped checkpoint.
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

# Paths this script reads, resolved from THIS FILE rather than hardcoded.
#
# The script is committed evidence for a measurement, so it has to be
# re-runnable by a reviewer, not only on the workstation it was written on.
# Every external input is a flag with the original value as its default, so
# the invocation that produced the reported numbers still works verbatim.
HERE = os.path.dirname(os.path.abspath(__file__))          # ml/distill
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))
HOME = os.path.expanduser('~')

# emit_calib_candidates lives beside this file. Importing it by a hardcoded
# sys.path entry made the script unrunnable from any other checkout.
sys.path.insert(0, HERE)
import emit_calib_candidates as E  # noqa: E402
import shipped_model as SM  # noqa: E402  the pinned shipped checkpoint

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
    ap.add_argument('--repo-root', default=REPO_ROOT,
                    help='WingDex checkout. Only the shipped ONNX is read '
                         'from it.')
    ap.add_argument('--distill-root', default=HERE,
                    help='ml/distill, passed to E.load_student for its '
                         'relative model sources.')
    ap.add_argument('--checkpoint',
                    default=SM.SHIPPED_CHECKPOINT,
                    help='PyTorch student. The threshold is fitted on its '
                         'embeddings.')
    ap.add_argument('--onnx', default=None,
                    help='Shipped int8 visual encoder. Defaults to '
                         'public/models/wingclip_visual_int8.onnx under '
                         '--repo-root.')
    ap.add_argument('--probe', default=os.path.join(HOME, 'refit_probe.npz'),
                    help='Refit linear bird probe (coef, intercept).')
    ap.add_argument('--candidates',
                    default=os.path.join(HERE,
                                         'calib_cands_tiny39_a060.parquet'),
                    help='Candidate parquet. Its row order plus seed 0 define '
                         'the 70/30 split every measured number used, so '
                         'changing it changes the validation set.')
    ap.add_argument('--datasets',
                    default='/mnt/nas/WingDex-Distill/datasets',
                    help='Root holding the three shard dirs below.')
    ap.add_argument('--birds-dir', default=None,
                    help='Validation birds. Default calib-11k-500px under '
                         '--datasets.')
    ap.add_argument('--hardneg-dir', default=None,
                    help='Hard negatives. Default '
                         'eval-hard-negatives-nonbird under --datasets.')
    ap.add_argument('--imagenette-dir', default=None,
                    help='Easy negatives. Default '
                         'eval-imagenette-easy-negatives under --datasets.')
    ap.add_argument('--nbird', type=int, default=700)
    ap.add_argument('--nneg', type=int, default=700)
    ap.add_argument('--out', default=os.path.join(HOME, 'parity_gate.json'))
    args = ap.parse_args()

    if args.onnx is None:
        args.onnx = os.path.join(args.repo_root, 'public', 'models',
                                 'wingclip_visual_int8.onnx')
    if args.birds_dir is None:
        args.birds_dir = os.path.join(args.datasets, 'calib-11k-500px')
    if args.hardneg_dir is None:
        args.hardneg_dir = os.path.join(args.datasets,
                                        'eval-hard-negatives-nonbird')
    if args.imagenette_dir is None:
        args.imagenette_dir = os.path.join(args.datasets,
                                           'eval-imagenette-easy-negatives')

    pr = np.load(args.probe)
    coef = pr['coef'].astype(np.float64).ravel()
    inter = float(pr['intercept'].ravel()[0])

    df = pd.read_parquet(args.candidates)
    n = len(df)
    g = torch.Generator()
    g.manual_seed(0)
    perm = torch.randperm(n, generator=g).numpy()
    val_pid = set(str(int(p))
                  for p in df['photo_id'].values[perm[int(n * 0.7):]])
    log('val split ' + str(len(val_pid)))

    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    st, preprocess = E.load_student(args.checkpoint, args.distill_root,
                                    device)
    import onnxruntime as ort
    sess = ort.InferenceSession(args.onnx,
                                providers=['CPUExecutionProvider'])
    iname = sess.get_inputs()[0].name
    log('models loaded on ' + device)

    log('encoding validation birds')
    bp, bo, _ = encode_dir(args.birds_dir, preprocess, st, sess,
                           iname, device, args.nbird, keep=val_pid)
    log('encoding hard negatives')
    hp, ho, _ = encode_dir(args.hardneg_dir, preprocess,
                           st, sess, iname, device, args.nneg)
    log('encoding imagenette')
    ip, io_, _ = encode_dir(args.imagenette_dir, preprocess,
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
