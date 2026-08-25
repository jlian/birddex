#!/usr/bin/env python3
"""Stage A2 (a0.60 fp32): cache the FIT-half negatives so the Platt mixture
objective sees a realistic non-bird component. Mirrors refit_prep2_onnx.py,
but reads the a0.60 PyTorch embeddings and the a0.60-fitted probe.
"""
import argparse
import math
import time

import numpy as np
import pandas as pd
import torch

from occ4 import Occ
from refit_prep import cache_set


def log(m):
    print('[' + time.strftime('%H:%M:%S') + '] ' + str(m), flush=True)


def load(path):
    d = np.load(path)
    e = d['emb'].astype(np.float32)
    return e / np.linalg.norm(e, axis=1, keepdims=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--occ',
                    default='/home/jlian/v4build/occ_v4.4f5c1a15.bin.gz')
    ap.add_argument('--floor', type=float, default=3e-5)
    ap.add_argument('--taxonomy',
                    default='/home/jlian/wingdex/src/lib/taxonomy.json')
    ap.add_argument('--probe', default='/home/jlian/refit_probe_a060.npz')
    ap.add_argument('--out',
                    default='/home/jlian/refit_cache_fitneg_a060.npz')
    args = ap.parse_args()
    FLOOR = math.log(args.floor)
    device = 'cuda' if torch.cuda.is_available() else 'cpu'

    bd = np.load('/home/jlian/bird_emb_a060.npz')
    b_key_all = np.array([int(x) for x in bd['key']])
    hn_emb = load('/home/jlian/hardneg_emb_a060.npz')
    im_emb = load('/home/jlian/imagenette_emb_a060.npz')

    df = pd.read_parquet('calib_cands_tiny39_a060.parquet')
    n = len(df)
    torch.manual_seed(0)
    perm = torch.randperm(n).numpy()
    cut = int(n * 0.7)
    tr_pid = set(int(p) for p in df['photo_id'].values[perm[:cut]])
    b_tr_m = np.array([int(p) in tr_pid for p in b_key_all])
    b_tr_pid = b_key_all[b_tr_m]

    hh, ih = len(hn_emb) // 2, len(im_emb) // 2
    hn_tr, im_tr = hn_emb[:hh], im_emb[:ih]
    log('fit-half negatives hardneg ' + str(len(hn_tr)) + ' imagenette ' +
        str(len(im_tr)))

    pr = np.load(args.probe)
    coef, inter = pr['coef'], pr['intercept']

    def pb(e):
        zz = e.astype(np.float64) @ coef[0] + inter[0]
        return 1.0 / (1.0 + np.exp(-zz))

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
        meta[fs_pid[i]] = (d['latitude'][i], d['longitude'][i], d['month'][i])
    tr_lat = np.array([meta[int(p)][0] for p in b_tr_pid])
    tr_lon = np.array([meta[int(p)][1] for p in b_tr_pid])
    tr_mon = np.array([meta[int(p)][2] for p in b_tr_pid])

    occ = Occ(args.occ)
    store = {}
    rng = np.random.default_rng(1)
    for nm, emb in [('fhardneg', hn_tr), ('fimagenette', im_tr)]:
        log('caching ' + nm)
        pick = rng.integers(0, len(tr_lat), size=len(emb))
        C = cache_set(sims_of(emb), tr_lat[pick], tr_lon[pick], tr_mon[pick],
                      occ, FLOOR, nm)
        for kk, vv in C.items():
            store[nm + '_' + kk] = vv
        store[nm + '_pbird'] = pb(emb)

    np.savez_compressed(args.out, **store)
    log('wrote ' + args.out)
    print('=== PREP2 A060 DONE ===')


if __name__ == '__main__':
    main()
