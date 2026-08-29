#!/usr/bin/env python3
"""Stage A (a0.60 fp32): fit the discriminative probe on PyTorch embeddings
from the SHIPPED checkpoint, and cache everything the Platt fit and the
battery need.

Why this exists: the previous PyTorch arm was built from wise_a0.90.pt, the
PREVIOUS model's best alpha. The ONNX arm embeds through the int8 export of
wise_a0.60.pt. Comparing those two conflates ALPHA with QUANTIZATION. This
rebuilds the PyTorch arm at alpha 0.60 so the only remaining difference
between the arms is int8 quantization.

Split, top-k, negative geo assignment and occurrence config are identical to
refit_prep.py / refit_prep_onnx.py so all three arms are directly comparable.
"""
import argparse
import json
import math
import time

import numpy as np
import pandas as pd
import torch

from occ4 import Occ
from refit_prep import cache_set, get_ent, lp_vec, KS


def log(m):
    print('[' + time.strftime('%H:%M:%S') + '] ' + str(m), flush=True)


def auroc(sp, sn):
    from sklearn.metrics import roc_auc_score
    s = np.concatenate([sp, sn])
    y = np.concatenate([np.ones(len(sp)), np.zeros(len(sn))])
    return float(roc_auc_score(y, s))


def load(path):
    d = np.load(path)
    e = d['emb'].astype(np.float32)
    e = e / np.linalg.norm(e, axis=1, keepdims=True)
    return e, np.array([str(x) for x in d['key']])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--occ',
                    default='/home/jlian/v4build/occ_v4.4f5c1a15.bin.gz')
    ap.add_argument('--floor', type=float, default=3e-5)
    ap.add_argument('--taxonomy',
                    default='/home/jlian/wingdex/src/lib/taxonomy.json')
    ap.add_argument('--out', default='/home/jlian/refit_cache_a060.npz')
    ap.add_argument('--probe-out', default='/home/jlian/refit_probe_a060.npz')
    args = ap.parse_args()
    FLOOR = math.log(args.floor)
    device = 'cuda' if torch.cuda.is_available() else 'cpu'

    b_emb_all, b_keys = load('/home/jlian/bird_emb_a060.npz')
    hn_emb, hn_keys = load('/home/jlian/hardneg_emb_a060.npz')
    im_emb, im_keys = load('/home/jlian/imagenette_emb_a060.npz')
    nb_emb, nb_keys = load('/home/jlian/nabirds_emb_a060.npz')
    b_key_all = np.array([int(x) for x in b_keys])
    log('a060 birds ' + str(b_emb_all.shape) + '  hardneg ' +
        str(hn_emb.shape) + '  imagenette ' + str(im_emb.shape) +
        '  nabirds ' + str(nb_emb.shape))

    # Row-order agreement with the ONNX caches. Identical order means the
    # first-half/second-half negative splits are the SAME images in both
    # arms, so fp32-vs-int8 is like-for-like and not an accidental reshuffle.
    print('')
    print('  CACHE ALIGNMENT CHECK, a060 fp32 vs ONNX int8 caches')
    allok = True
    for nm, mine, other in [
            ('birds', b_keys, '/home/jlian/bird_emb_onnx.npz'),
            ('hardneg', hn_keys, '/home/jlian/hardneg_emb_onnx.npz'),
            ('imagenette', im_keys, '/home/jlian/imagenette_emb_onnx.npz'),
            ('nabirds', nb_keys, '/home/jlian/nabirds_emb_onnx.npz')]:
        ok = np.array([str(x) for x in np.load(other)['key']])
        same = bool(np.array_equal(ok, mine))
        allok = allok and same
        print('    ' + nm.ljust(13) + 'n=' + str(len(mine)).rjust(6) +
              '   exact key match: ' + str(same))
    # Also against the OLD a0.90 PyTorch caches, so the alpha comparison is
    # row-aligned too.
    print('')
    print('  CACHE ALIGNMENT CHECK, a060 fp32 vs OLD a0.90 PyTorch caches')
    for nm, mine, other in [
            ('birds', b_keys, '/home/jlian/bird_emb.npz'),
            ('hardneg', hn_keys, '/home/jlian/hardneg_emb.npz'),
            ('imagenette', im_keys, '/home/jlian/imagenette_emb.npz'),
            ('nabirds', nb_keys, '/home/jlian/nabirds_emb.npz')]:
        ok = np.array([str(x) for x in np.load(other)['key']])
        same = bool(np.array_equal(ok, mine))
        print('    ' + nm.ljust(13) + 'n=' + str(len(mine)).rjust(6) +
              '   exact key match: ' + str(same))
    print('')
    if not allok:
        raise SystemExit('ROW ORDER MISMATCH vs ONNX: not comparable')

    df = pd.read_parquet('calib_cands_tiny39_a060.parquet')
    n = len(df)
    torch.manual_seed(0)
    perm = torch.randperm(n).numpy()
    cut = int(n * 0.7)
    tr_pid = set(int(p) for p in df['photo_id'].values[perm[:cut]])
    va_pid = set(int(p) for p in df['photo_id'].values[perm[cut:]])
    b_tr_m = np.array([int(p) in tr_pid for p in b_key_all])
    b_va_m = np.array([int(p) in va_pid for p in b_key_all])
    b_tr, b_va = b_emb_all[b_tr_m], b_emb_all[b_va_m]
    b_tr_pid, b_va_pid = b_key_all[b_tr_m], b_key_all[b_va_m]
    log('birds fit ' + str(len(b_tr)) + '  val ' + str(len(b_va)))

    hh, ih = len(hn_emb) // 2, len(im_emb) // 2
    hn_tr, hn_te = hn_emb[:hh], hn_emb[hh:]
    im_tr, im_te = im_emb[:ih], im_emb[ih:]
    log('hardneg fit/test ' + str(len(hn_tr)) + '/' + str(len(hn_te)) +
        '  imagenette fit/test ' + str(len(im_tr)) + '/' + str(len(im_te)))

    from sklearn.linear_model import LogisticRegression

    def fitp(pos, negs):
        X = np.concatenate([pos] + negs).astype(np.float64)
        y = np.concatenate([np.ones(len(pos))] +
                           [np.zeros(len(q)) for q in negs])
        return LogisticRegression(max_iter=3000, C=1.0,
                                  class_weight='balanced',
                                  random_state=0).fit(X, y)

    log('fitting a060 fp32 probe on the FIT half only')
    clf = fitp(b_tr, [hn_tr, im_tr])

    def pb(e):
        return clf.predict_proba(e.astype(np.float64))[:, 1]

    p_btr, p_bva = pb(b_tr), pb(b_va)
    p_hn, p_im, p_nb = pb(hn_te), pb(im_te), pb(nb_emb)
    A = dict(vs_hardneg=auroc(p_bva, p_hn),
             vs_imagenette=auroc(p_bva, p_im),
             vs_both=auroc(p_bva, np.concatenate([p_hn, p_im])))
    print('')
    print('  a060 fp32 probe AUROC (val birds vs test-half negatives)')
    for kk in ['vs_hardneg', 'vs_imagenette', 'vs_both']:
        print('    ' + kk.ljust(16) + ('%.4f' % A[kk]))
    print('')

    log('fitting single-negative a060 probes')
    clf_hn = fitp(b_tr, [hn_tr])
    clf_im = fitp(b_tr, [im_tr])

    log('building text classifier')
    import emit_calib_candidates as E
    tfe, _ = E.build_text(args.taxonomy, device)
    tfe_np = tfe.cpu().numpy().astype(np.float32)

    def sims_of(emb):
        out = np.empty((len(emb), tfe_np.shape[0]), dtype=np.float32)
        B = 2048
        for i in range(0, len(emb), B):
            out[i:i + B] = emb[i:i + B] @ tfe_np.T
        return out

    d = np.load('/home/jlian/full_sims.npz')
    fs_pid = np.array([int(x) for x in d['photo_id']])
    meta = {}
    for i in range(len(fs_pid)):
        meta[fs_pid[i]] = (d['latitude'][i], d['longitude'][i],
                           d['month'][i], d['true_app_idx'][i])

    def geo(pids):
        return (np.array([meta[int(p)][0] for p in pids]),
                np.array([meta[int(p)][1] for p in pids]),
                np.array([meta[int(p)][2] for p in pids]),
                np.array([meta[int(p)][3] for p in pids]))

    tr_lat, tr_lon, tr_mon, tr_true = geo(b_tr_pid)
    va_lat, va_lon, va_mon, va_true = geo(b_va_pid)

    occ = Occ(args.occ)
    store = {}
    log('caching fit birds')
    C = cache_set(sims_of(b_tr), tr_lat, tr_lon, tr_mon, occ, FLOOR, 'btr')
    for kk, vv in C.items():
        store['btr_' + kk] = vv
    store['btr_true'] = tr_true.astype(np.int64)
    store['btr_pbird'] = p_btr

    log('caching val birds')
    C = cache_set(sims_of(b_va), va_lat, va_lon, va_mon, occ, FLOOR, 'bva')
    for kk, vv in C.items():
        store['bva_' + kk] = vv
    store['bva_true'] = va_true.astype(np.int64)
    store['bva_pbird'] = p_bva

    rng = np.random.default_rng(0)
    for nm, emb, pbv in [('hardneg', hn_te, p_hn),
                         ('imagenette', im_te, p_im)]:
        log('caching ' + nm + ' test half')
        pick = rng.integers(0, len(va_lat), size=len(emb))
        C = cache_set(sims_of(emb), va_lat[pick], va_lon[pick], va_mon[pick],
                      occ, FLOOR, nm)
        for kk, vv in C.items():
            store[nm + '_' + kk] = vv
        store[nm + '_pbird'] = pbv
    store['nabirds_pbird'] = p_nb

    np.savez_compressed(args.out, **store)
    np.savez(args.probe_out, coef=clf.coef_, intercept=clf.intercept_,
             coef_hn=clf_hn.coef_, intercept_hn=clf_hn.intercept_,
             coef_im=clf_im.coef_, intercept_im=clf_im.intercept_,
             auroc_hardneg=np.array([A['vs_hardneg']]),
             auroc_imagenette=np.array([A['vs_imagenette']]),
             auroc_both=np.array([A['vs_both']]))
    log('wrote ' + args.out + ' and ' + args.probe_out)
    print('=== PREP A060 DONE ===')


if __name__ == '__main__':
    main()
