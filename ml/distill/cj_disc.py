#!/usr/bin/env python3
"""Crop-jitter spread: plain vs cosine-null vs discriminator.

Extends eval_crop_jitter_real.py with a third arm. Per crop the discriminator
displayed confidence is P(bird|crop) * P(species|bird, crop), where the second
factor is the no-null species softmax top-1. The probe is the SAME logistic
regression on 768-d embeddings used everywhere else, fit on the protocol
training birds against both negative sets.

Scoring path, temperature and beta are taken from the RECOMMENDED config
(floor 3e-5, k 0.3, T 0.007435, beta 1.1634) rather than the older k=1 numbers
hard-coded in eval_crop_jitter_real.py, so this is comparable to the battery.
The plain and cosine-null arms are recomputed here under the same config, so
all three arms are measured on identical crops.

SUPERSEDED RESULTS. Every number previously produced by this file was
measured with runs/ft_tiny39_fresh/wise_a0.90.pt, which is WingCLIP-0.1's
best alpha and NOT the model that ships. The default is now the pinned
shipped checkpoint (shipped_model.SHIPPED_CHECKPOINT, alpha 0.60). Treat
any earlier output of this script as describing a different model.
"""
import argparse
import io
import json
import math
import os
import tarfile

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

import emit_calib_candidates as E
from ee_port import lonlat_to_ee, xy_to_cell
from occ4 import Occ
import shipped_model as SM  # noqa: E402  the pinned shipped checkpoint


def jitter_crops(img, n, seed):
    rng = np.random.RandomState(seed)
    w, h = img.size
    short = min(w, h)
    out = []
    for _ in range(n):
        side = int(short * rng.uniform(0.80, 1.00))
        x = rng.randint(0, max(1, w - side + 1))
        y = rng.randint(0, max(1, h - side + 1))
        out.append(img.crop((x, y, x + side, y + side)))
    return out


def lp_vec(ent, idxs, kk, FLOOR):
    pri, pooled, ncm = ent
    ub = (pooled is not None) and (ncm is not None) and kk > 0
    out = np.empty(len(idxs), dtype=np.float64)
    for j, ix in enumerate(idxs):
        ix = int(ix)
        lp = pri.get(ix)
        if ub:
            nscm = 0.0 if lp is None else math.exp(lp) * ncm
            pp = pooled.get(ix)
            ppv = 0.0 if pp is None else math.exp(pp)
            num = nscm + kk * ppv
            v = math.log(num / (ncm + kk)) if num > 0 else FLOOR
        else:
            v = FLOOR if lp is None else lp
        if v < FLOOR:
            v = FLOOR
        out[j] = v
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--checkpoint',
                    default=SM.SHIPPED_CHECKPOINT,
                    help="pinned shipped checkpoint; see shipped_model.py")
    ap.add_argument('--taxonomy',
                    default='/home/jlian/wingdex/src/lib/taxonomy.json')
    ap.add_argument('--shards',
                    default='/mnt/nas/WingDex-Distill/datasets/calib-11k-500px')
    ap.add_argument('--occ',
                    default='/home/jlian/v4build/occ_v4.4f5c1a15.bin.gz')
    ap.add_argument('--floor', type=float, default=3e-5)
    ap.add_argument('--k', type=float, default=0.3)
    ap.add_argument('--temperature', type=float, default=0.007435)
    ap.add_argument('--beta', type=float, default=1.1634)
    ap.add_argument('--cos', type=float, default=0.54)
    ap.add_argument('--images', type=int, default=200)
    ap.add_argument('--crops', type=int, default=8)
    ap.add_argument('--topk', type=int, default=25)
    ap.add_argument('--out', default='/home/jlian/cropjitter_disc.json')
    args = ap.parse_args()
    T, beta, K, kk = args.temperature, args.beta, args.topk, args.k
    FLOOR = math.log(args.floor)

    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    tf, _ = E.build_text(args.taxonomy, device)
    st, preprocess = E.load_student(args.checkpoint,
                                    '/home/jlian/wingdex/ml/distill', device)
    occ = Occ(args.occ)

    # ---- the probe, same fit as the battery ----
    import pandas as pd
    from sklearn.linear_model import LogisticRegression
    bd = np.load('/home/jlian/bird_emb.npz')
    b_emb = bd['emb'].astype(np.float32)
    b_key = np.array([int(x) for x in bd['key']])
    df = pd.read_parquet('calib_cands_tiny39_a060.parquet')
    n = len(df)
    torch.manual_seed(0)
    perm = torch.randperm(n).numpy()
    tr_pid = set(int(p) for p in df['photo_id'].values[perm[:int(n * 0.7)]])
    b_tr = b_emb[np.array([int(p) in tr_pid for p in b_key])]
    hn = np.load('/home/jlian/hardneg_emb.npz')['emb'].astype(np.float32)
    ime = np.load('/home/jlian/imagenette_emb.npz')['emb'].astype(np.float32)
    hn_tr, im_tr = hn[:len(hn) // 2], ime[:len(ime) // 2]
    X = np.concatenate([b_tr, hn_tr, im_tr]).astype(np.float64)
    y = np.concatenate([np.ones(len(b_tr)),
                        np.zeros(len(hn_tr) + len(im_tr))])
    clf = LogisticRegression(max_iter=3000, C=1.0,
                             class_weight='balanced').fit(X, y)
    print('probe fit on ' + str(len(b_tr)) + ' birds, ' +
          str(len(hn_tr) + len(im_tr)) + ' negatives', flush=True)

    shards = sorted(f for f in os.listdir(args.shards) if f.endswith('.tar'))
    per_image = []
    skipped = 0
    for sh in shards:
        if len(per_image) >= args.images:
            break
        with tarfile.open(os.path.join(args.shards, sh)) as tar:
            meta = {}
            pending = {}
            for m in tar:
                stem = os.path.basename(m.name).rsplit('.', 1)[0]
                if m.name.endswith('.json'):
                    try:
                        meta[stem] = json.loads(tar.extractfile(m).read())
                    except Exception:
                        pass
                    continue
                if not (m.name.endswith('.jpg') or m.name.endswith('.jpeg')):
                    continue
                f = tar.extractfile(m)
                if f is None:
                    continue
                try:
                    pending[stem] = Image.open(
                        io.BytesIO(f.read())).convert('RGB')
                except Exception:
                    continue
            for stem, img in pending.items():
                if len(per_image) >= args.images:
                    break
                md = meta.get(stem)
                if not md:
                    skipped += 1
                    continue
                lat, lon = md.get('latitude'), md.get('longitude')
                obs = md.get('observed_on') or ''
                try:
                    month = int(str(obs)[5:7])
                except Exception:
                    month = 0
                if lat is None or lon is None or not (1 <= month <= 12):
                    skipped += 1
                    continue
                try:
                    rc = xy_to_cell(*lonlat_to_ee(float(lon), float(lat)))
                except Exception:
                    rc = None
                if rc is None:
                    skipped += 1
                    continue
                pri = occ.cell_priors(rc[0], rc[1], month)
                if not pri:
                    skipped += 1
                    continue
                pooled = occ.cell_pooled(rc[0], rc[1]) if occ.version >= 4 else None
                ncm = occ.total(rc[0], rc[1], month) if occ.version >= 4 else None
                ent = (pri, pooled, ncm)

                crops = jitter_crops(img, args.crops, seed=len(per_image))
                x = torch.stack([preprocess(c) for c in crops]).to(device)
                with torch.no_grad():
                    e = F.normalize(st(x), dim=-1)
                    s_all = (e @ tf.T).cpu().numpy().astype(np.float64)
                emb = e.cpu().numpy().astype(np.float64)
                pbird = clf.predict_proba(emb)[:, 1]

                c_plain = np.zeros(len(crops))
                c_null = np.zeros(len(crops))
                for ci in range(len(crops)):
                    s = s_all[ci]
                    vi = np.argpartition(-s, K)[:K]
                    vi = vi[np.argsort(-s[vi])]
                    lp = lp_vec(ent, vi, kk, FLOOR)
                    sc = s[vi] / T + beta * lp
                    o = np.argsort(-sc)
                    sc_s, lp_s = sc[o], lp[o]
                    ee = np.exp(sc_s - sc_s.max())
                    c_plain[ci] = ee[0] / ee.sum()
                    ns = args.cos / T + beta * float(np.median(lp_s))
                    a = np.concatenate([sc_s, [ns]])
                    ea = np.exp(a - a.max())
                    p = ea / ea.sum()
                    c_null[ci] = p[0]
                c_disc = pbird * c_plain
                per_image.append({
                    'maxsim': float(s_all.max(axis=1).mean()),
                    'plain_spread': float(c_plain.max() - c_plain.min()),
                    'null_spread': float(c_null.max() - c_null.min()),
                    'disc_spread': float(c_disc.max() - c_disc.min()),
                    'pbird_spread': float(pbird.max() - pbird.min()),
                    'plain_conf': float(c_plain.mean()),
                    'null_conf': float(c_null.mean()),
                    'disc_conf': float(c_disc.mean()),
                    'pbird_mean': float(pbird.mean()),
                })
                if len(per_image) % 50 == 0:
                    print('  ' + str(len(per_image)) + ' images', flush=True)

    arrs = {nm: np.array([r[nm] for r in per_image])
            for nm in ['plain_spread', 'null_spread', 'disc_spread',
                       'pbird_spread', 'maxsim']}
    print('')
    print('  ' + str(len(per_image)) + ' images x ' + str(args.crops) +
          ' crops   skipped ' + str(skipped))
    print('  recommended config: floor 3e-5 k 0.3 T ' + ('%.6f' % T) +
          ' beta ' + ('%.4f' % beta) + ' cos ' + ('%.2f' % args.cos))
    print('')
    print('  TOP-1 DISPLAYED CONFIDENCE SPREAD ACROSS 8 CROPS (lower better)')
    print('             plain    cosine-null   discriminator   [P(bird) alone]')
    for nm, q in [('p50', 50), ('p90', 90), ('max', 100)]:
        print('    ' + nm.ljust(8) +
              ('%.1f%%' % (100 * np.percentile(arrs['plain_spread'], q))).rjust(8) +
              ('%.1f%%' % (100 * np.percentile(arrs['null_spread'], q))).rjust(14) +
              ('%.1f%%' % (100 * np.percentile(arrs['disc_spread'], q))).rjust(16) +
              ('%.1f%%' % (100 * np.percentile(arrs['pbird_spread'], q))).rjust(18))
    print('')
    print('  mean displayed conf   plain ' +
          ('%.1f%%' % (100 * np.mean([r['plain_conf'] for r in per_image]))) +
          '   null ' +
          ('%.1f%%' % (100 * np.mean([r['null_conf'] for r in per_image]))) +
          '   disc ' +
          ('%.1f%%' % (100 * np.mean([r['disc_conf'] for r in per_image]))))
    cutv = np.percentile(arrs['maxsim'], 33.3)
    w = arrs['maxsim'] <= cutv
    print('')
    print('  WEAKEST THIRD BY MAX SIM  (n=' + str(int(w.sum())) + ')')
    print('    median spread  plain ' +
          ('%.1f%%' % (100 * np.median(arrs['plain_spread'][w]))) +
          '   null ' + ('%.1f%%' % (100 * np.median(arrs['null_spread'][w]))) +
          '   disc ' + ('%.1f%%' % (100 * np.median(arrs['disc_spread'][w]))))
    print('    p90 spread     plain ' +
          ('%.1f%%' % (100 * np.percentile(arrs['plain_spread'][w], 90))) +
          '   null ' + ('%.1f%%' % (100 * np.percentile(arrs['null_spread'][w], 90))) +
          '   disc ' + ('%.1f%%' % (100 * np.percentile(arrs['disc_spread'][w], 90))))
    json.dump(per_image, open(args.out, 'w'))
    print('')
    print('  wrote ' + args.out)
    print('=== CROPJIT DISC DONE ===')


if __name__ == '__main__':
    main()
