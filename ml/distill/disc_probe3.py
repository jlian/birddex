#!/usr/bin/env python3
"""Stage 3: realism. Degraded BIRD photos, the actual user failure mode.

Neither negative set resembles what users upload. Nobody points a bird app at
a golf ball. The realistic bad upload is a REAL bird photo that is blurry, too
distant, or mostly empty background. Those must NOT be rejected as non-bird;
they should degrade to low species confidence.

Three degradations applied to the same validation birds:
  blur      gaussian blur, radius 6 on a 500px image
  tiny      center crop to 15% then upscale back (bird too small to resolve)
  bg        take an off-center corner crop (mostly background/branch/sky)

SUPERSEDED RESULTS. Every number previously produced by this file was
measured with runs/ft_tiny39_fresh/wise_a0.90.pt, which is WingCLIP-0.1's
best alpha and NOT the model that ships. The default is now the pinned
shipped checkpoint (shipped_model.SHIPPED_CHECKPOINT, alpha 0.60). Treat
any earlier output of this script as describing a different model.
"""
import argparse
import io
import json
import os
import tarfile
import time

import numpy as np
import pandas as pd
import torch
import torch.nn.functional as F
from PIL import Image, ImageFilter

import emit_calib_candidates as E
import shipped_model as SM  # noqa: E402  the pinned shipped checkpoint


def log(m):
    print('[' + time.strftime('%H:%M:%S') + '] ' + str(m), flush=True)


def degrade(im, mode):
    w, h = im.size
    if mode == 'blur':
        return im.filter(ImageFilter.GaussianBlur(radius=6))
    if mode == 'tiny':
        s = 0.15
        cw, ch = int(w * s), int(h * s)
        x0, y0 = (w - cw) // 2, (h - ch) // 2
        c = im.crop((x0, y0, x0 + cw, y0 + ch))
        return c.resize((w, h), Image.BICUBIC)
    if mode == 'bg':
        # top-left corner, 30% -- usually branch/sky, bird rarely there
        cw, ch = int(w * 0.30), int(h * 0.30)
        return im.crop((0, 0, cw, ch)).resize((w, h), Image.BICUBIC)
    raise ValueError(mode)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--checkpoint',
                    default=SM.SHIPPED_CHECKPOINT,
                    help="pinned shipped checkpoint; see shipped_model.py")
    ap.add_argument('--corpus',
                    default='/mnt/nas/WingDex-Distill/datasets/calib-11k-500px')
    ap.add_argument('--limit', type=int, default=1500)
    ap.add_argument('--out', default='/home/jlian/disc_probe3.json')
    args = ap.parse_args()

    df = pd.read_parquet('calib_cands_tiny39_a060.parquet')
    n = len(df)
    torch.manual_seed(0)
    perm = torch.randperm(n).numpy()
    va_pid = set(int(p) for p in df['photo_id'].values[perm[int(n * 0.7):]])

    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    st, preprocess = E.load_student(args.checkpoint,
                                    '/home/jlian/wingdex/ml/distill', device)

    modes = ['orig', 'blur', 'tiny', 'bg']
    out = {m: [] for m in modes}
    bufs = {m: [] for m in modes}

    def flush(m):
        if not bufs[m]:
            return
        x = torch.stack(bufs[m]).to(device)
        with torch.no_grad():
            e = F.normalize(st(x), dim=-1)
        out[m].append(e.cpu().numpy().astype(np.float32))
        bufs[m].clear()

    seen = 0
    t0 = time.time()
    shards = sorted(f for f in os.listdir(args.corpus) if f.endswith('.tar'))
    done = False
    for sh in shards:
        if done:
            break
        with tarfile.open(os.path.join(args.corpus, sh)) as tf:
            for mem in tf:
                if not mem.isfile() or not mem.name.lower().endswith('.jpg'):
                    continue
                key = os.path.basename(mem.name)
                key = key[:key.rindex('.')]
                try:
                    pid = int(key)
                except ValueError:
                    continue
                if pid not in va_pid:
                    continue
                try:
                    im = Image.open(io.BytesIO(
                        tf.extractfile(mem).read())).convert('RGB')
                except Exception:
                    continue
                for m in modes:
                    z = im if m == 'orig' else degrade(im, m)
                    bufs[m].append(preprocess(z))
                seen += 1
                if len(bufs['orig']) >= 64:
                    for m in modes:
                        flush(m)
                if seen % 256 == 0:
                    log('  ' + str(seen) + '  ' +
                        ('%.1f' % (seen / max(1e-9, time.time() - t0))) + '/s')
                if seen >= args.limit:
                    done = True
                    break
    for m in modes:
        flush(m)
    embs = {m: np.concatenate(out[m]) for m in modes}
    log('degraded set built: ' + str(embs['orig'].shape) +
        ' per mode, ' + str(len(modes)) + ' modes')

    # classifier trained on the protocol training split
    bd = np.load('/home/jlian/bird_emb.npz')
    b_emb = bd['emb'].astype(np.float32)
    b_key = np.array([int(x) for x in bd['key']])
    tr_pid = set(int(p) for p in df['photo_id'].values[perm[:int(n * 0.7)]])
    b_tr = b_emb[np.array([int(p) in tr_pid for p in b_key])]
    hn = np.load('/home/jlian/hardneg_emb.npz')['emb'].astype(np.float32)
    im_e = np.load('/home/jlian/imagenette_emb.npz')['emb'].astype(np.float32)
    hn_tr, hn_te = hn[:len(hn) // 2], hn[len(hn) // 2:]
    im_tr = im_e[:len(im_e) // 2]

    from sklearn.linear_model import LogisticRegression
    X = np.concatenate([b_tr, hn_tr, im_tr]).astype(np.float64)
    y = np.concatenate([np.ones(len(b_tr)),
                        np.zeros(len(hn_tr) + len(im_tr))])
    clf = LogisticRegression(max_iter=3000, class_weight='balanced').fit(X, y)

    p_hn = clf.predict_proba(hn_te.astype(np.float64))[:, 1]
    P = {m: clf.predict_proba(embs[m].astype(np.float64))[:, 1] for m in modes}

    res = {'n': int(len(embs['orig'])), 'rows': []}
    print('')
    print('=== DEGRADED REAL BIRD PHOTOS (the actual failure mode) ===')
    print('  n=' + str(len(embs['orig'])) + ' validation birds, each degraded')
    print('')
    print('  mean P(bird):  ' + '  '.join(
        [m + ' ' + ('%.4f' % P[m].mean()) for m in modes]))
    print('')
    print('  target_hardneg_rej   ' +
          '   '.join([m.ljust(8) for m in modes]))
    for target in [0.15, 0.25, 0.40]:
        thr = float(np.quantile(p_hn, target))
        row = dict(target=target)
        line = '  ' + ('%.0f%%' % (100 * target)).ljust(21)
        for m in modes:
            v = float((P[m] < thr).mean())
            row[m] = v
            line += ('%.2f%%' % (100 * v)).rjust(9) + '  '
        res['rows'].append(row)
        print(line)

    json.dump(res, open(args.out, 'w'), indent=2, default=float)
    print('')
    print('wrote ' + args.out)
    print('=== PROBE3 DONE ===')


if __name__ == '__main__':
    main()
