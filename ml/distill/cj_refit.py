#!/usr/bin/env python3
"""Crop-jitter spread with the REFIT discriminator arms.

Extends cj_disc.py with two extra arms:
  C  disc+Platt        P_cal(bird) * P(species|bird)   at T0,beta0,k0.3
  D  disc+Platt+joint  P_cal(bird) * P(species|bird)   at refit T,beta,k

Platt / joint parameters are read from refit_battery2.json so this uses the
exact fitted values, not re-derived ones.

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

EPS = 1e-7


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


def top1(s, ent, T, beta, kk, FLOOR, K, cos):
    vi = np.argpartition(-s, K)[:K]
    vi = vi[np.argsort(-s[vi])]
    lp = lp_vec(ent, vi, kk, FLOOR)
    sc = s[vi] / T + beta * lp
    o = np.argsort(-sc)
    sc_s, lp_s = sc[o], lp[o]
    ee = np.exp(sc_s - sc_s.max())
    plain = ee[0] / ee.sum()
    ns = cos / T + beta * float(np.median(lp_s))
    a = np.concatenate([sc_s, [ns]])
    ea = np.exp(a - a.max())
    p = ea / ea.sum()
    return plain, p[0]


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
    ap.add_argument('--params', default='/home/jlian/refit_battery2.json')
    ap.add_argument('--floor', type=float, default=3e-5)
    ap.add_argument('--k', type=float, default=0.3)
    ap.add_argument('--temperature', type=float, default=0.007435)
    ap.add_argument('--beta', type=float, default=1.1634)
    ap.add_argument('--cos', type=float, default=0.54)
    ap.add_argument('--images', type=int, default=200)
    ap.add_argument('--crops', type=int, default=8)
    ap.add_argument('--topk', type=int, default=25)
    ap.add_argument('--out', default='/home/jlian/cropjitter_refit.json')
    args = ap.parse_args()
    T, beta, K, kk = args.temperature, args.beta, args.topk, args.k
    FLOOR = math.log(args.floor)

    P = json.load(open(args.params))
    a_p, b_p = P['platt']['a'], P['platt']['b']
    J = P['joint_best']
    aJ, bJ, TJ, BJ, kJ = J['a'], J['b'], J['T'], J['beta'], J['k']
    print('Platt a=' + ('%.4f' % a_p) + ' b=' + ('%.4f' % b_p) +
          '   joint a=' + ('%.4f' % aJ) + ' b=' + ('%.4f' % bJ) +
          ' T=' + ('%.6f' % TJ) + ' beta=' + ('%.4f' % BJ) + ' k=' + str(kJ),
          flush=True)

    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    tf, _ = E.build_text(args.taxonomy, device)
    st, preprocess = E.load_student(args.checkpoint,
                                    '/home/jlian/wingdex/ml/distill', device)
    occ = Occ(args.occ)

    pr = np.load('/home/jlian/refit_probe.npz')
    coef, inter = pr['coef'][0], pr['intercept'][0]

    def pbird(emb):
        zz = emb @ coef + inter
        return 1.0 / (1.0 + np.exp(-zz))

    def platt(p, a, b):
        pc = np.clip(p, EPS, 1 - EPS)
        z = np.log(pc / (1 - pc))
        return 1.0 / (1.0 + np.exp(-(a * z + b)))

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
                pb = pbird(emb)
                pc = platt(pb, a_p, b_p)
                pcJ = platt(pb, aJ, bJ)

                nc = len(crops)
                c_plain = np.zeros(nc)
                c_null = np.zeros(nc)
                c_plainJ = np.zeros(nc)
                for ci in range(nc):
                    c_plain[ci], c_null[ci] = top1(
                        s_all[ci], ent, T, beta, kk, FLOOR, K, args.cos)
                    c_plainJ[ci], _ = top1(
                        s_all[ci], ent, TJ, BJ, kJ, FLOOR, K, args.cos)
                per_image.append({
                    'maxsim': float(s_all.max(axis=1).mean()),
                    'plain_spread': float(c_plain.max() - c_plain.min()),
                    'null_spread': float(c_null.max() - c_null.min()),
                    'discraw_spread': float((pb * c_plain).max() -
                                            (pb * c_plain).min()),
                    'platt_spread': float((pc * c_plain).max() -
                                          (pc * c_plain).min()),
                    'joint_spread': float((pcJ * c_plainJ).max() -
                                          (pcJ * c_plainJ).min()),
                    'pbird_spread': float(pb.max() - pb.min()),
                    'pcal_spread': float(pc.max() - pc.min()),
                    'plain_conf': float(c_plain.mean()),
                    'null_conf': float(c_null.mean()),
                    'discraw_conf': float((pb * c_plain).mean()),
                    'platt_conf': float((pc * c_plain).mean()),
                    'joint_conf': float((pcJ * c_plainJ).mean()),
                })
                if len(per_image) % 50 == 0:
                    print('  ' + str(len(per_image)) + ' images', flush=True)

    NAMES = ['plain_spread', 'null_spread', 'discraw_spread', 'platt_spread',
             'joint_spread', 'pbird_spread', 'pcal_spread', 'maxsim']
    arrs = {nm: np.array([r[nm] for r in per_image]) for nm in NAMES}
    print('')
    print('  ' + str(len(per_image)) + ' images x ' + str(args.crops) +
          ' crops   skipped ' + str(skipped))
    print('')
    print('  TOP-1 DISPLAYED CONFIDENCE SPREAD ACROSS 8 CROPS (lower better)')
    print('          plain   cos-null  disc-raw  C:Platt  D:joint  [P(bird)]  [P_cal]')
    for nm, q in [('p50', 50), ('p90', 90), ('max', 100)]:
        row = '    ' + nm.ljust(6)
        for key in NAMES[:-1]:
            row += ('%.1f%%' % (100 * np.percentile(arrs[key], q))).rjust(10)
        print(row)
    print('')
    print('  mean displayed conf   plain ' +
          ('%.1f%%' % (100 * np.mean([r['plain_conf'] for r in per_image]))) +
          '   null ' +
          ('%.1f%%' % (100 * np.mean([r['null_conf'] for r in per_image]))) +
          '   disc-raw ' +
          ('%.1f%%' % (100 * np.mean([r['discraw_conf'] for r in per_image]))) +
          '   C ' +
          ('%.1f%%' % (100 * np.mean([r['platt_conf'] for r in per_image]))) +
          '   D ' +
          ('%.1f%%' % (100 * np.mean([r['joint_conf'] for r in per_image]))))
    cutv = np.percentile(arrs['maxsim'], 33.3)
    w = arrs['maxsim'] <= cutv
    print('')
    print('  WEAKEST THIRD BY MAX SIM  (n=' + str(int(w.sum())) + ')')
    for lbl, q in [('median', 50), ('p90', 90)]:
        row = '    ' + lbl.ljust(8)
        for key in ['plain_spread', 'null_spread', 'discraw_spread',
                    'platt_spread', 'joint_spread']:
            row += ('%.1f%%' % (100 * np.percentile(arrs[key][w], q))).rjust(10)
        print(row)
    json.dump(per_image, open(args.out, 'w'))
    print('')
    print('  wrote ' + args.out)
    print('=== CROPJIT REFIT DONE ===')


if __name__ == '__main__':
    main()
