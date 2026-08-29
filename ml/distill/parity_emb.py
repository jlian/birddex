#!/usr/bin/env python3
"""Embedding parity: PyTorch fp32 student (all measured numbers) vs the
shipped int8 ONNX visual encoder (what the browser actually runs).

Every discriminator/gate number was computed from the PyTorch path. The app
computes its embedding through ONNX. If those differ, P_cal(bird) shifts and
the abstention threshold does not transfer.

Reports, per image:
  max |dEmb| per component, cosine(pt, onnx), P_raw and P_cal under both.
These are diagnostics, not a pass/fail gate. Flag-rate movement at the shipped
operating point is the decision-relevant transfer measurement.

Both paths get the IDENTICAL preprocessed tensor, so this isolates the
encoder difference (fp32 weights vs int8 quantized) and does not conflate it
with a resize/crop mismatch. Preprocessing parity is a separate, already
solved problem (clip-preprocess.ts mirrors PIL).

Both sides default to alpha 0.60. Measured transfer at bird_q 0.5%:

  bird flag rate      +0.03 pp
  hardneg rejection   +2.33 pp
  imagenette          +3.33 pp   (all three at bird_q 0.5%)
  threshold transfer  0.18 pp worst case

The threshold transfers. The shipped probe is fitted in the int8 space and
decoded from the shipped classifier row by default.
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

DIM = 768
BIAS = 1.7004907607405835


def log(m):
    print('[' + time.strftime('%H:%M:%S') + '] ' + str(m), flush=True)


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


def logit(p):
    p = np.clip(p, 1e-12, 1 - 1e-12)
    return np.log(p / (1 - p))


def load_probe(classifier, probe):
    if probe is not None:
        data = np.load(probe)
        return (data['coef'].astype(np.float64).ravel(),
                float(data['intercept'].ravel()[0]))
    buf = np.fromfile(classifier, dtype=np.uint8)
    n = len(buf) // (DIM + 4)
    if n == 0 or n * (DIM + 4) != len(buf):
        raise ValueError('invalid int8 classifier length: ' + str(len(buf)))
    rows = buf[:n * DIM].view(np.int8).reshape(n, DIM)
    scales = buf[n * DIM:].view(np.float32)
    return rows[-1].astype(np.float64) * float(scales[-1]), BIAS


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--datasets',
                    default='/mnt/nas/WingDex-Distill/datasets',
                    help='Root holding the shard directories.')
    ap.add_argument('--shards', default=None,
                    help='Validation-bird shard dir. Defaults to '
                         'calib-11k-500px under --datasets.')
    ap.add_argument('--repo-root', default=REPO_ROOT,
                    help='WingDex checkout. Only the shipped ONNX is read '
                         'from it.')
    ap.add_argument('--distill-root', default=HERE,
                    help='ml/distill, passed to E.load_student for its '
                         'relative model sources.')
    ap.add_argument('--checkpoint',
                    default=SM.SHIPPED_CHECKPOINT,
                    help='PyTorch student. The fp32 side of the comparison.')
    ap.add_argument('--onnx', default=None,
                    help='Shipped int8 visual encoder. Defaults to '
                         'public/models/wingclip_visual_int8.onnx under '
                         '--repo-root.')
    ap.add_argument('--classifier', default=None, help='Shipped int8 classifier; defaults under --repo-root.')
    ap.add_argument('--probe', default=None, help='Optional fp32 probe NPZ override; bypasses --classifier.')
    ap.add_argument('--candidates',
                    default=os.path.join(HERE,
                                         'calib_cands_tiny39_a060.parquet'),
                    help='Candidate parquet. Its row order plus seed 0 define '
                         'the 70/30 split every measured number used, so '
                         'changing it changes the validation set.')
    ap.add_argument('--bird-emb',
                    default=os.path.join(HOME, 'bird_emb_onnx.npz'),
                    help='Precomputed shipped-ONNX bird embeddings, used only '
                         'to spread the sample across the P(bird) range.')
    ap.add_argument('--vulture', default=os.path.join(HOME,
                                                      'vulture_crop.png'),
                    help='The Guatemala vulture, the headline number.')
    ap.add_argument('--n', type=int, default=24)
    ap.add_argument('--out', default=os.path.join(HOME, 'parity_emb.json'))
    args = ap.parse_args()

    if args.shards is None:
        args.shards = os.path.join(args.datasets, 'calib-11k-500px')
    if args.onnx is None:
        args.onnx = os.path.join(args.repo_root, 'public', 'models',
                                 'wingclip_visual_int8.onnx')
    if args.classifier is None:
        args.classifier = os.path.join(args.repo_root, 'public', 'models',
                                       'text_classifier_int8.bin')

    A = 1.248338657716024
    B = 2.1821600341974303

    coef, inter = load_probe(args.classifier, args.probe)
    log('probe loaded: coef ' + str(coef.shape) + ' intercept ' +
        ('%.6f' % inter))

    # Validation split, same protocol as every measured number.
    df = pd.read_parquet(args.candidates)
    n = len(df)
    g = torch.Generator()
    g.manual_seed(0)
    perm = torch.randperm(n, generator=g).numpy()
    val_pid = [int(p) for p in df['photo_id'].values[perm[int(n * 0.7):]]]
    log('val split: ' + str(len(val_pid)) + ' photos')

    # Rank val photos by shipped-ONNX P(bird) so the sample spans the range.
    bd = np.load(args.bird_emb)
    b_emb = bd['emb'].astype(np.float64)
    b_key = np.array([int(x) for x in bd['key']])
    vset = set(val_pid)
    mask = np.array([int(k) in vset for k in b_key])
    ve = b_emb[mask]
    vk = b_key[mask]
    p_v = sigmoid(ve @ coef + inter)
    order = np.argsort(p_v)
    take = np.linspace(0, len(order) - 1, args.n - 1).astype(int)
    want = {int(vk[order[t]]): float(p_v[order[t]]) for t in take}
    log('selected ' + str(len(want)) + ' val photos spanning P(bird) ' +
        ('%.4f' % min(want.values())) + ' .. ' +
        ('%.4f' % max(want.values())))

    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    st, preprocess = E.load_student(args.checkpoint, args.distill_root,
                                    device)
    log('student loaded on ' + device)

    import onnxruntime as ort
    sess = ort.InferenceSession(args.onnx,
                                providers=['CPUExecutionProvider'])
    iname = sess.get_inputs()[0].name
    log('onnx loaded')

    tensors = []
    labels = []

    # The Guatemala vulture, the headline number.
    vim = Image.open(args.vulture).convert('RGB')
    tensors.append(preprocess(vim))
    labels.append('vulture')

    found = set()
    for sh in sorted(f for f in os.listdir(args.shards)
                     if f.endswith('.tar')):
        with tarfile.open(os.path.join(args.shards, sh)) as tf:
            for m in tf:
                if not m.isfile():
                    continue
                low = m.name.lower()
                if not low.endswith(('.jpg', '.jpeg', '.png')):
                    continue
                key = os.path.basename(m.name)
                key = key[:key.rindex('.')]
                try:
                    pid = int(key)
                except ValueError:
                    continue
                if pid not in want or pid in found:
                    continue
                try:
                    b = tf.extractfile(m).read()
                    im = Image.open(io.BytesIO(b)).convert('RGB')
                except Exception:
                    continue
                tensors.append(preprocess(im))
                labels.append(str(pid))
                found.add(pid)
        if len(found) >= len(want):
            break
    log('encoded ' + str(len(tensors)) + ' images')

    x = torch.stack(tensors).to(device)
    with torch.no_grad():
        e_pt = F.normalize(st(x), dim=-1).cpu().numpy().astype(np.float64)

    xn = x.cpu().numpy().astype(np.float32)
    e_on = sess.run(None, {iname: xn})[0].astype(np.float64)
    e_on = e_on / np.linalg.norm(e_on, axis=1, keepdims=True)

    d = np.abs(e_pt - e_on)
    cos = (e_pt * e_on).sum(axis=1)

    z_pt = e_pt @ coef + inter
    z_on = e_on @ coef + inter
    p_pt = sigmoid(z_pt)
    p_on = sigmoid(z_on)
    pc_pt = sigmoid(A * logit(p_pt) + B)
    pc_on = sigmoid(A * logit(p_on) + B)
    dpc = np.abs(pc_pt - pc_on)

    print('')
    print('=== EMBEDDING PARITY: PyTorch fp32 vs shipped int8 ONNX ===')
    print('')
    hdr = ('  ' + 'image'.ljust(12) + 'max|dEmb|'.rjust(11) +
           'cosine'.rjust(11) + 'P_raw pt'.rjust(11) + 'P_raw onnx'.rjust(12) +
           'P_cal pt'.rjust(11) + 'P_cal onnx'.rjust(12) + 'dP_cal'.rjust(10))
    print(hdr)
    for i in range(len(labels)):
        print('  ' + labels[i].ljust(12) +
              ('%.6f' % d[i].max()).rjust(11) +
              ('%.6f' % cos[i]).rjust(11) +
              ('%.4f' % p_pt[i]).rjust(11) +
              ('%.4f' % p_on[i]).rjust(12) +
              ('%.4f' % pc_pt[i]).rjust(11) +
              ('%.4f' % pc_on[i]).rjust(12) +
              ('%.5f' % dpc[i]).rjust(10))

    print('')
    print('  n images                 ' + str(len(labels)))
    print('  max |dEmb| per component ' + ('%.6f' % d.max()))
    print('  mean|dEmb| per component ' + ('%.6f' % d.mean()))
    print('  worst row cosine         ' + ('%.6f' % cos.min()))
    print('  MAX |dP_cal|             ' + ('%.5f' % dpc.max()))
    print('  mean |dP_cal|            ' + ('%.5f' % dpc.mean()))
    print('')

    json.dump({
        'n': len(labels),
        'labels': labels,
        'max_abs_demb': float(d.max()),
        'mean_abs_demb': float(d.mean()),
        'worst_cosine': float(cos.min()),
        'max_dpcal': float(dpc.max()),
        'mean_dpcal': float(dpc.mean()),
        'p_cal_pt': [float(v) for v in pc_pt],
        'p_cal_onnx': [float(v) for v in pc_on],
    }, open(args.out, 'w'), indent=2)
    print('wrote ' + args.out)
    print('=== PARITY DONE ===')


if __name__ == '__main__':
    main()
