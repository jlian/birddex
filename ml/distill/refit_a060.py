#!/usr/bin/env python3
"""a0.60 fp32 vs a0.60 int8: alpha held FIXED, so the delta is quantization.

Yesterday's PyTorch arm came from wise_a0.90.pt, the PREVIOUS model's best
alpha, while the ONNX arm is the int8 export of wise_a0.60.pt. Any
fp32-vs-int8 gap measured that way mixed two causes. This run rebuilds the
PyTorch arm at alpha 0.60 and reports both arms side by side on the identical
split, preprocessing and objective, so the remaining gap is quantization
only.

Reported here:
  probe AUROC in each space
  Platt (a,b) refit, mixture objective, pi_fit = 0.10
  bird-quantile gate table in each space
  CROSS-APPLICATION of thresholds between spaces (threshold transfer is the
    thing that failed before)
  species top-1, and the assertion that P_cal cannot reorder species
  bird ECE(15) and mean displayed confidence
"""
import argparse
import json
import sys

import numpy as np
import torch

from refit_battery import Set, ece, ece_w, logit, platt
from refit_battery2 import fit_mix

T0 = 0.007435
B0 = 1.1634
K0 = 0.3
EPS = 1e-7


def sig(x):
    return 1.0 / (1.0 + np.exp(-x))


def pct(v):
    return '%.2f%%' % (100 * v)


def load(path):
    d = np.load(path)
    e = d['emb'].astype(np.float64)
    return e / np.linalg.norm(e, axis=1, keepdims=True)


def auroc(sp, sn):
    from sklearn.metrics import roc_auc_score
    s = np.concatenate([sp, sn])
    y = np.concatenate([np.ones(len(sp)), np.zeros(len(sn))])
    return float(roc_auc_score(y, s))


class Arm(object):
    """One embedding space: cached battery inputs plus the fitted probe."""

    def __init__(self, name, cache, fitneg, probe, dev, pi_fit):
        self.name = name
        z = np.load(cache)
        zf = np.load(fitneg)
        self.z = z
        self.FIT = Set(z, 'btr', dev)
        self.VAL = Set(z, 'bva', dev)
        self.HN = Set(z, 'hardneg', dev)
        self.IM = Set(z, 'imagenette', dev)
        self.NF = [Set(zf, 'fhardneg', dev), Set(zf, 'fimagenette', dev)]
        pr = np.load(probe)
        self.pr = pr
        self.auroc = dict(hardneg=float(pr['auroc_hardneg'][0]),
                          imagenette=float(pr['auroc_imagenette'][0]),
                          both=float(pr['auroc_both'][0]))
        a, b, _, _, l = fit_mix(self.FIT, self.NF, K0, pi_fit, False, T0, B0)
        self.a, self.b, self.loss = a, b, l
        at = torch.tensor(a, dtype=torch.float64, device=dev)
        bt = torch.tensor(b, dtype=torch.float64, device=dev)
        self.cal = {'val': platt(self.VAL.zl, at, bt).cpu().numpy(),
                    'hardneg': platt(self.HN.zl, at, bt).cpu().numpy(),
                    'imagenette': platt(self.IM.zl, at, bt).cpu().numpy()}
        self.raw = {'val': self.VAL.pbird.cpu().numpy(),
                    'hardneg': self.HN.pbird.cpu().numpy(),
                    'imagenette': self.IM.pbird.cpu().numpy()}
        self.raw_fit = z['btr_pbird']
        self.raw_nb = z['nabirds_pbird']
        conf, top, corr = self.VAL.base(T0, B0, K0)
        self.base = conf.cpu().numpy()
        self.corr = corr.cpu().numpy()
        self.top1 = float(corr.mean())
        self.shown = self.cal['val'] * self.base
        self.ece = ece(self.shown, self.corr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pi-fit', type=float, default=0.10)
    ap.add_argument('--pis', default='0.02,0.05,0.10,0.25')
    ap.add_argument('--quantiles', default='0.001,0.005,0.01,0.02')
    ap.add_argument('--out', default='/home/jlian/refit_a060.json')
    args = ap.parse_args()
    pis = [float(p) for p in args.pis.split(',')]
    qs = [float(q) for q in args.quantiles.split(',')]
    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    res = {}

    print('=' * 78)
    print('STEP 1  BUILD BOTH ARMS, alpha 0.60 held fixed')
    print('=' * 78)
    A = Arm('a060-fp32', '/home/jlian/refit_cache_a060.npz',
            '/home/jlian/refit_cache_fitneg_a060.npz',
            '/home/jlian/refit_probe_a060.npz', dev, args.pi_fit)
    print('  fp32 arm built: fit birds ' + str(A.FIT.n) + '  val birds ' +
          str(A.VAL.n) + '  hardneg ' + str(A.HN.n) + '  imagenette ' +
          str(A.IM.n), flush=True)
    Q = Arm('a060-int8', '/home/jlian/refit_cache_onnx.npz',
            '/home/jlian/refit_cache_fitneg_onnx.npz',
            '/home/jlian/refit_probe_onnx.npz', dev, args.pi_fit)
    print('  int8 arm built: fit birds ' + str(Q.FIT.n) + '  val birds ' +
          str(Q.VAL.n) + '  hardneg ' + str(Q.HN.n) + '  imagenette ' +
          str(Q.IM.n), flush=True)

    print('')
    print('=' * 78)
    print('STEP 2  PROBE AUROC, val birds vs test-half negatives')
    print('=' * 78)
    print('  arm            vs_hardneg   vs_imagenette   vs_both')
    for arm in [A, Q]:
        print('  ' + arm.name.ljust(15) +
              ('%.4f' % arm.auroc['hardneg']).rjust(10) +
              ('%.4f' % arm.auroc['imagenette']).rjust(16) +
              ('%.4f' % arm.auroc['both']).rjust(10))
    print('  a090-fp32 (old, DIFFERENT MODEL) vs_both was 0.993')
    res['auroc'] = {A.name: A.auroc, Q.name: Q.auroc}

    print('')
    print('=' * 78)
    print('STEP 3  PLATT REFIT, mixture objective, pi_fit=' +
          ('%.2f' % args.pi_fit))
    print('=' * 78)
    print('  arm                    a          b      fit loss')
    for arm in [A, Q]:
        print('  ' + arm.name.ljust(16) + ('%.4f' % arm.a).rjust(9) +
              ('%.4f' % arm.b).rjust(11) + ('%.4f' % arm.loss).rjust(12))
    print('  a090-fp32 (old, DIFFERENT MODEL)   a = 1.3595   b = 2.5815')
    res['platt'] = {A.name: dict(a=A.a, b=A.b, loss=A.loss),
                    Q.name: dict(a=Q.a, b=Q.b, loss=Q.loss)}

    print('')
    print('  mean P(bird) raw -> P_cal')
    print('  set             fp32 raw   fp32 cal   int8 raw   int8 cal')
    mr = {}
    for nm in ['val', 'hardneg', 'imagenette']:
        print('  ' + nm.ljust(15) + ('%.4f' % A.raw[nm].mean()).rjust(9) +
              ('%.4f' % A.cal[nm].mean()).rjust(11) +
              ('%.4f' % Q.raw[nm].mean()).rjust(11) +
              ('%.4f' % Q.cal[nm].mean()).rjust(11))
        mr[nm] = dict(fp32_raw=float(A.raw[nm].mean()),
                      fp32_cal=float(A.cal[nm].mean()),
                      int8_raw=float(Q.raw[nm].mean()),
                      int8_cal=float(Q.cal[nm].mean()))
    nbA = sig(A.a * logit(A.raw_nb) + A.b)
    nbQ = sig(Q.a * logit(Q.raw_nb) + Q.b)
    print('  ' + 'nabirds'.ljust(15) + ('%.4f' % A.raw_nb.mean()).rjust(9) +
          ('%.4f' % nbA.mean()).rjust(11) +
          ('%.4f' % Q.raw_nb.mean()).rjust(11) +
          ('%.4f' % nbQ.mean()).rjust(11) + '   (unseen real birds)')
    mr['nabirds'] = dict(fp32_raw=float(A.raw_nb.mean()),
                         fp32_cal=float(nbA.mean()),
                         int8_raw=float(Q.raw_nb.mean()),
                         int8_cal=float(nbQ.mean()))
    res['mean_pbird'] = mr

    print('')
    print('=' * 78)
    print('STEP 4  BIRD-QUANTILE GATE, threshold from the FIT-half birds')
    print('=' * 78)
    print('  Threshold is a quantile of FIT-half bird P(bird). Rejection is')
    print('  measured on the FULL negative sets and on all 8000 NABirds.')
    hn_full = {'fp32': None, 'int8': None}
    im_full = {'fp32': None, 'int8': None}
    pcA = A.pr['coef'].astype(np.float64).ravel()
    piA = float(A.pr['intercept'].ravel()[0])
    pcQ = Q.pr['coef'].astype(np.float64).ravel()
    piQ = float(Q.pr['intercept'].ravel()[0])
    hn_full['fp32'] = sig(load('/home/jlian/hardneg_emb_a060.npz') @ pcA + piA)
    im_full['fp32'] = sig(
        load('/home/jlian/imagenette_emb_a060.npz') @ pcA + piA)
    hn_full['int8'] = sig(load('/home/jlian/hardneg_emb_onnx.npz') @ pcQ + piQ)
    im_full['int8'] = sig(
        load('/home/jlian/imagenette_emb_onnx.npz') @ pcQ + piQ)

    grows = []
    for tag, arm, hf, imf in [('a060-fp32', A, hn_full['fp32'],
                               im_full['fp32']),
                              ('a060-int8', Q, hn_full['int8'],
                               im_full['int8'])]:
        print('')
        print('  ' + tag)
        print('  bird_q   thr        val_bird_flag  hardneg_rej  '
              'imagenette_rej  nabirds_rej  eff_top1')
        for q in qs:
            th = float(np.quantile(arm.raw_fit, q))
            fl = arm.raw['val'] < th
            rh = float((hf < th).mean())
            ri = float((imf < th).mean())
            rn = float((arm.raw_nb < th).mean())
            ev = float((arm.corr * (~fl)).mean())
            grows.append(dict(arm=tag, q=q, thr=th, flag=float(fl.mean()),
                              hn_rej=rh, im_rej=ri, nb_rej=rn, eff=ev))
            print('  ' + ('%.1f%%' % (100 * q)).ljust(9) +
                  ('%.5f' % th).ljust(11) + pct(fl.mean()).rjust(12) +
                  pct(rh).rjust(13) + pct(ri).rjust(15) +
                  pct(rn).rjust(13) + ('%.2f%%' % (100 * ev)).rjust(11))
            sys.stdout.flush()
    res['gate'] = grows

    print('')
    print('=' * 78)
    print('STEP 5  CROSS-APPLICATION OF THRESHOLDS BETWEEN SPACES')
    print('=' * 78)
    print('  Threshold derived from FIT birds in the SOURCE space, applied')
    print('  unchanged to scores in the TARGET space. Both spaces score the')
    print('  same images with their own probe. This is the transfer that')
    print('  failed before.')
    print('')
    print('  src -> tgt        bird_q   val_bird_flag  hardneg_rej  '
          'imagenette_rej  nabirds_rej')
    xrows = []
    for sname, src, tname, tgt, thf, tif in [
            ('fp32', A, 'int8', Q, hn_full['int8'], im_full['int8']),
            ('int8', Q, 'fp32', A, hn_full['fp32'], im_full['fp32'])]:
        for q in qs:
            th = float(np.quantile(src.raw_fit, q))
            fl = float((tgt.raw['val'] < th).mean())
            rh = float((thf < th).mean())
            ri = float((tif < th).mean())
            rn = float((tgt.raw_nb < th).mean())
            xrows.append(dict(src=sname, tgt=tname, q=q, thr=th, flag=fl,
                              hn_rej=rh, im_rej=ri, nb_rej=rn))
            print('  ' + (sname + ' -> ' + tname).ljust(18) +
                  ('%.1f%%' % (100 * q)).ljust(9) + pct(fl).rjust(12) +
                  pct(rh).rjust(13) + pct(ri).rjust(15) + pct(rn).rjust(13))
            sys.stdout.flush()
    res['cross'] = xrows

    print('')
    print('  DRIFT vs the matched in-space row (target flag - source flag):')
    print('  src -> tgt        bird_q   in-space flag   transferred flag'
          '   delta_pp')
    for r in xrows:
        base = [g for g in grows
                if g['arm'] == ('a060-' + r['tgt']) and g['q'] == r['q']][0]
        d = 100 * (r['flag'] - base['flag'])
        print('  ' + (r['src'] + ' -> ' + r['tgt']).ljust(18) +
              ('%.1f%%' % (100 * r['q'])).ljust(9) +
              pct(base['flag']).rjust(13) + pct(r['flag']).rjust(19) +
              ('%+.2f pp' % d).rjust(11))

    print('')
    print('=' * 78)
    print('STEP 6  SPECIES TOP-1 AND ORDER VIOLATIONS')
    print('=' * 78)
    print('  arm            species_top1')
    for arm in [A, Q]:
        print('  ' + arm.name.ljust(15) + ('%.4f%%' % (100 * arm.top1)))
    print('  a090-fp32 (old, DIFFERENT MODEL) was 95.6640%')
    res['species_top1'] = {A.name: A.top1, Q.name: Q.top1}

    # P_cal is one positive scalar per row. Multiplying every species score in
    # a row by the same positive number cannot change their ORDER. Asserted
    # numerically here rather than assumed: recompute the argmax with and
    # without the multiplier and count disagreements.
    print('')
    print('  ORDER-VIOLATION ASSERTION (measured, not assumed)')
    for arm in [A, Q]:
        sc = arm.VAL.score(T0, B0, K0)
        p = torch.softmax(sc, dim=1)
        am_plain = p.argmax(dim=1)
        mult = torch.tensor(arm.cal['val'], dtype=torch.float64,
                            device=p.device).unsqueeze(1)
        am_mult = (p * mult).argmax(dim=1)
        bad = int((am_plain != am_mult).sum())
        rank_plain = torch.argsort(p, dim=1, descending=True)
        rank_mult = torch.argsort(p * mult, dim=1, descending=True)
        badrank = int((rank_plain != rank_mult).any(dim=1).sum())
        pmin = float(mult.min())
        print('    ' + arm.name.ljust(13) + 'argmax changes ' + str(bad) +
              '   full-ranking changes ' + str(badrank) +
              '   min P_cal ' + ('%.6f' % pmin) +
              '   all P_cal > 0: ' + str(bool(pmin > 0)))
        res.setdefault('order', {})[arm.name] = dict(
            argmax_changes=bad, rank_changes=badrank, min_pcal=pmin)

    print('')
    print('=' * 78)
    print('STEP 7  ECE AND DISPLAYED CONFIDENCE')
    print('=' * 78)
    print('  arm            bird_ECE(15)   mean_displayed   frac<50%')
    for arm in [A, Q]:
        print('  ' + arm.name.ljust(15) + ('%.4f' % arm.ece).rjust(9) +
              ('%.1f%%' % (100 * arm.shown.mean())).rjust(17) +
              pct((arm.shown < 0.5).mean()).rjust(11))
    print('  recommended NO-PROBE config: bird ECE 0.0076, birds mean 95.6%')
    res['birds'] = {arm.name: dict(ece=arm.ece,
                                   mean=float(arm.shown.mean()),
                                   lt50=float((arm.shown < 0.5).mean()))
                    for arm in [A, Q]}

    print('')
    print('  NEGATIVES: displayed confidence')
    print('  arm            set            mean     <50%')
    nrows = []
    for arm in [A, Q]:
        for nm, S in [('hardneg', arm.HN), ('imagenette', arm.IM)]:
            bc = S.base(T0, B0, K0)[0].cpu().numpy()
            v = arm.cal[nm] * bc
            nrows.append(dict(arm=arm.name, set=nm, mean=float(v.mean()),
                              lt50=float((v < 0.5).mean())))
            print('  ' + arm.name.ljust(15) + nm.ljust(15) +
                  ('%.1f%%' % (100 * v.mean())).rjust(7) +
                  pct((v < 0.5).mean()).rjust(9))
    res['negatives'] = nrows

    print('')
    print('  UNION ECE, non-bird correct = 0')
    uni = []
    for arm in [A, Q]:
        print('  ' + arm.name)
        print('    negatives      ' +
              '  '.join([('pi=' + ('%.2f' % p)).rjust(8) for p in pis]))
        for nm, S in [('hardneg', arm.HN), ('imagenette', arm.IM)]:
            bc = S.base(T0, B0, K0)[0].cpu().numpy()
            ns = arm.cal[nm] * bc
            allc = np.concatenate([arm.shown, ns])
            allcorr = np.concatenate([arm.corr, np.zeros(len(ns))])
            cells = []
            for pi in pis:
                w = np.concatenate([
                    np.full(len(arm.shown), (1 - pi) / len(arm.shown)),
                    np.full(len(ns), pi / len(ns))])
                v = ece_w(allc, allcorr, w)
                cells.append(v)
                uni.append(dict(arm=arm.name, neg=nm, pi=pi, ece=v))
            print('    ' + nm.ljust(15) +
                  '  '.join([('%.4f' % x).rjust(8) for x in cells]))
    res['union_ece'] = uni

    json.dump(res, open(args.out, 'w'), indent=1, default=float)
    print('')
    print('wrote ' + args.out)
    print('=== A060 REFIT DONE ===')


if __name__ == '__main__':
    main()
