#!/usr/bin/env python3
"""True quantization cost of P_cal, with alpha HELD FIXED at 0.60.

The earlier parity number (max |dP_cal| 0.02088) compared a PyTorch arm
built from wise_a0.90.pt against the int8 export of wise_a0.60.pt, so it
measured ALPHA + QUANTIZATION together. This recomputes the same criterion
with both sides at alpha 0.60, so the residual is quantization only.

Three probes are applied, to separate "the embeddings moved" from "the
decision boundary moved":
  fp32-fitted probe on fp32 vs int8 embeddings
  int8-fitted probe on fp32 vs int8 embeddings
  fp32-fitted probe on a0.90 fp32 vs a0.60 fp32 embeddings (alpha only)
"""
import argparse
import json

import numpy as np

EPS = 1e-7


def sig(x):
    return 1.0 / (1.0 + np.exp(-x))


def logit(p):
    p = np.clip(p, EPS, 1 - EPS)
    return np.log(p / (1 - p))


def pct(v):
    return '%.2f%%' % (100 * v)


def load(path):
    d = np.load(path)
    e = d['emb'].astype(np.float64)
    return e / np.linalg.norm(e, axis=1, keepdims=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='/home/jlian/parity_a060.json')
    args = ap.parse_args()

    J = json.load(open('/home/jlian/refit_a060.json'))
    aF = J['platt']['a060-fp32']['a']
    bF = J['platt']['a060-fp32']['b']
    aQ = J['platt']['a060-int8']['a']
    bQ = J['platt']['a060-int8']['b']
    prF = np.load('/home/jlian/refit_probe_a060.npz')
    prQ = np.load('/home/jlian/refit_probe_onnx.npz')
    cF = prF['coef'].astype(np.float64).ravel()
    iF = float(prF['intercept'].ravel()[0])
    cQ = prQ['coef'].astype(np.float64).ravel()
    iQ = float(prQ['intercept'].ravel()[0])

    def pcal(e, c, i, a, b):
        return sig(a * logit(sig(e @ c + i)) + b)

    SETS = [('bird', 'bird_emb'), ('hardneg', 'hardneg_emb'),
            ('imagenette', 'imagenette_emb'), ('nabirds', 'nabirds_emb')]
    E = {}
    for nm, stem in SETS:
        E[nm] = dict(
            fp32=load('/home/jlian/' + stem + '_a060.npz'),
            int8=load('/home/jlian/' + stem + '_onnx.npz'),
            a090=load('/home/jlian/' + stem + '.npz'))

    res = {}
    for label, key, c, i, a, b, lhs, rhs in [
            ('QUANT only, fp32-fitted probe', 'quant_fp32probe',
             cF, iF, aF, bF, 'fp32', 'int8'),
            ('QUANT only, int8-fitted probe', 'quant_int8probe',
             cQ, iQ, aQ, bQ, 'fp32', 'int8'),
            ('ALPHA only (a0.90 vs a0.60 fp32), fp32-fitted probe',
             'alpha_fp32probe', cF, iF, aF, bF, 'a090', 'fp32')]:
        print('')
        print('  ' + label)
        print('  ' + 'set'.ljust(13) + 'n'.rjust(7) + 'max|dP_cal|'.rjust(14) +
              'mean|dP_cal|'.rjust(14) + 'mean dP_cal'.rjust(14) +
              'frac d>0'.rjust(11))
        rows = {}
        gmax = 0.0
        for nm, _ in SETS:
            x = pcal(E[nm][rhs], c, i, a, b)
            y = pcal(E[nm][lhs], c, i, a, b)
            d = x - y
            ad = np.abs(d)
            gmax = max(gmax, float(ad.max()))
            rows[nm] = dict(n=int(len(d)), max=float(ad.max()),
                            mean_abs=float(ad.mean()), mean=float(d.mean()),
                            frac_pos=float((d > 0).mean()))
            print('  ' + nm.ljust(13) + str(len(d)).rjust(7) +
                  ('%.5f' % ad.max()).rjust(14) +
                  ('%.5f' % ad.mean()).rjust(14) +
                  ('%+.5f' % d.mean()).rjust(14) +
                  pct((d > 0).mean()).rjust(11))
        print('  MAX |dP_cal| across all sets  ' + ('%.5f' % gmax) +
              '   GATE(<=0.01): ' + ('PASS' if gmax <= 0.01 else 'FAIL'))
        res[key] = dict(rows=rows, max=gmax, passed=bool(gmax <= 0.01))

    print('')
    print('  Reference: the earlier PyTorch-vs-ONNX parity number was')
    print('  0.02088, measured with the a0.90 PyTorch arm. Compare that to')
    print('  the QUANT-only and ALPHA-only rows above.')

    # Raw embedding-space distance, no probe, no Platt.
    print('')
    print('  RAW EMBEDDING COSINE, same image, two spaces (no probe)')
    print('  ' + 'set'.ljust(13) + 'quant mean cos'.rjust(16) +
          'quant min'.rjust(12) + 'alpha mean cos'.rjust(16) +
          'alpha min'.rjust(12))
    cos = {}
    for nm, _ in SETS:
        q = (E[nm]['fp32'] * E[nm]['int8']).sum(axis=1)
        al = (E[nm]['fp32'] * E[nm]['a090']).sum(axis=1)
        cos[nm] = dict(quant_mean=float(q.mean()), quant_min=float(q.min()),
                       alpha_mean=float(al.mean()), alpha_min=float(al.min()))
        print('  ' + nm.ljust(13) + ('%.5f' % q.mean()).rjust(16) +
              ('%.5f' % q.min()).rjust(12) +
              ('%.5f' % al.mean()).rjust(16) +
              ('%.5f' % al.min()).rjust(12))
    res['cosine'] = cos

    json.dump(res, open(args.out, 'w'), indent=1, default=float)
    print('')
    print('wrote ' + args.out)
    print('=== PARITY A060 DONE ===')


if __name__ == '__main__':
    main()
