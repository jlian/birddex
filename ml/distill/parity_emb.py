#!/usr/bin/env python3
"""Embedding parity: PyTorch fp32 student (all measured numbers) vs the
shipped int8 ONNX visual encoder (what the browser actually runs).

Every discriminator/gate number was computed from the PyTorch path. The app
computes its embedding through ONNX. If those differ, P_cal(bird) shifts and
the abstention threshold does not transfer.

Reports, per image:
  max |dEmb| per component, cosine(pt, onnx), P_raw and P_cal under both.
Gate criterion: max |dP_cal| must stay under 0.01.

Both paths get the IDENTICAL preprocessed tensor, so this isolates the
encoder difference (fp32 weights vs int8 quantized) and does not conflate it
with a resize/crop mismatch. Preprocessing parity is a separate, already
solved problem (clip-preprocess.ts mirrors PIL).
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


def log(m):
    print('[' + time.strftime('%H:%M:%S') + '] ' + str(m), flush=True)


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


def logit(p):
    p = np.clip(p, 1e-12, 1 - 1e-12)
    return np.log(p / (1 - p))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--shards',
                    default='/mnt/nas/WingDex-Distill/datasets/calib-11k-500px')
    ap.add_argument('--checkpoint',
                    default='/home/jlian/wingdex/ml/distill/runs/'
                            'ft_tiny39_fresh/wise_a0.90.pt')
    ap.add_argument('--onnx',
                    default='/home/jlian/wingdex/public/models/'
                            'wingclip_visual_int8.onnx')
    ap.add_argument('--n', type=int, default=24)
    ap.add_argument('--out', default='/home/jlian/parity_emb.json')
    args = ap.parse_args()

    A = 1.3595343229097947
    B = 2.581534818041523

    pr = np.load('/home/jlian/refit_probe.npz')
    coef = pr['coef'].astype(np.float64).ravel()
    inter = float(pr['intercept'].ravel()[0])
    log('probe loaded: coef ' + str(coef.shape) + ' intercept ' +
        ('%.6f' % inter))

    # Validation split, same protocol as every measured number.
    df = pd.read_parquet('/home/jlian/wingdex/ml/distill/'
                         'calib_cands_tiny39_a060.parquet')
    n = len(df)
    g = torch.Generator()
    g.manual_seed(0)
    perm = torch.randperm(n, generator=g).numpy()
    val_pid = [int(p) for p in df['photo_id'].values[perm[int(n * 0.7):]]]
    log('val split: ' + str(len(val_pid)) + ' photos')

    # Rank val photos by PyTorch P(bird) so the sample spans the range.
    bd = np.load('/home/jlian/bird_emb.npz')
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
    st, preprocess = E.load_student(args.checkpoint,
                                    '/home/jlian/wingdex/ml/distill', device)
    log('student loaded on ' + device)

    import onnxruntime as ort
    sess = ort.InferenceSession(args.onnx,
                                providers=['CPUExecutionProvider'])
    iname = sess.get_inputs()[0].name
    log('onnx loaded')

    tensors = []
    labels = []

    # The Guatemala vulture, the headline number.
    vim = Image.open('/home/jlian/vulture_crop.png').convert('RGB')
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
    ok = bool(dpc.max() <= 0.01)
    print('  GATE (max |dP_cal| <= 0.01): ' + ('PASS' if ok else 'FAIL'))
    print('')

    json.dump({
        'n': len(labels),
        'labels': labels,
        'max_abs_demb': float(d.max()),
        'mean_abs_demb': float(d.mean()),
        'worst_cosine': float(cos.min()),
        'max_dpcal': float(dpc.max()),
        'mean_dpcal': float(dpc.mean()),
        'pass': ok,
        'p_cal_pt': [float(v) for v in pc_pt],
        'p_cal_onnx': [float(v) for v in pc_on],
    }, open(args.out, 'w'), indent=2)
    print('wrote ' + args.out)
    print('=== PARITY DONE ===')


if __name__ == '__main__':
    main()
