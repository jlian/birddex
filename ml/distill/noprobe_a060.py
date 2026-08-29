#!/usr/bin/env python3
"""No-probe baseline (cosine-null arm) measured in a0.60 space.

The recommended no-probe config's headline numbers (bird ECE 0.0076, birds
mean 95.6%) were measured on the a0.90 arm. Comparing the a0.60 probe
against them across a model change is not like-for-like, so the baseline is
recomputed here in both a0.60 spaces.
"""
import json

import numpy as np
import torch

from refit_battery import Set, ece

T0 = 0.007435
B0 = 1.1634
K0 = 0.3


def main():
    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    out = {}
    print('  arm            method          bird_ECE(15)  mean_disp  frac<50%')
    for tag, cache in [('a060-fp32', '/home/jlian/refit_cache_a060.npz'),
                       ('a060-int8', '/home/jlian/refit_cache_onnx.npz'),
                       ('a090-fp32', '/home/jlian/refit_cache.npz')]:
        z = np.load(cache)
        V = Set(z, 'bva', dev)
        conf, top, corr = V.base(T0, B0, K0)
        c = corr.cpu().numpy()
        nc, pn = V.nullconf(T0, B0, K0)
        ncn = nc.cpu().numpy()
        e = ece(ncn, c)
        out[tag] = dict(ece=e, mean=float(ncn.mean()),
                        lt50=float((ncn < 0.5).mean()),
                        top1=float(corr.mean()))
        print('  ' + tag.ljust(15) + 'cosine null'.ljust(16) +
              ('%.4f' % e).rjust(9) + ('%.1f%%' % (100 * ncn.mean())).rjust(11) +
              ('%.2f%%' % (100 * (ncn < 0.5).mean())).rjust(10))
    json.dump(out, open('/home/jlian/noprobe_a060.json', 'w'), indent=1)
    print('')
    print('  species top-1 in each cache (no gate):')
    for tag in out:
        print('    ' + tag.ljust(13) + ('%.4f%%' % (100 * out[tag]['top1'])))
    print('=== NOPROBE DONE ===')


if __name__ == '__main__':
    main()
