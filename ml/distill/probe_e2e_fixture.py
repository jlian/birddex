#!/usr/bin/env python3
"""Emit the end-to-end fixture the TS test checks the shipped path against.

Picks real embeddings from both sides of the gate: birds that pass, hard
negatives and Imagenette images that are rejected, and a couple of NABirds.
P_raw and P_cal are computed in float64 with the QUANTIZED probe row read back
out of the shipped classifier file, so the TS side is compared against the
same weights it loads rather than against the pre-quantization fit.

PATHS. The classifier and the fixture are repo files, so both are derived
from shipped_model.REPO_ROOT and neither carries a /home dependency. The four
embedding caches are external corpus data that is not in the repo, so they get
--emb-dir plus per-split overrides, with the original location as the default
so the invocation that produced the committed fixture still works verbatim.

PROBE CONSTANTS. bias, plattA, plattB and threshold are READ OUT of
src/lib/bird-id-local-adapter.ts at runtime, not retyped here. This fixture is
the ground truth the TS test compares the client against, so a hand-copied
constant that drifts from BIRD_PROBE would make the test assert the fixture's
own mistake. That failure already happened twice on this branch: the v4 blob
recorded k = 1.0 while both rankers ran 0.3, and probe_quant.py used the raw
threshold 0.1047758473 when the shipped gate is 0.1032229138. Same fix shape
as read_client_k() in jobs/build_prior_blob_month.py.
"""
import argparse
import json
import os
import re
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shipped_model as SM  # noqa: E402  repo root, derived from __file__

DIM = 768
EPS = 1e-7

# Split name -> (default basename under --emb-dir, how many cases to sample).
# Order and counts are load-bearing: they fix the committed fixture's contents.
SPLITS = (('bird', 'bird_emb_onnx.npz', 4),
          ('hardneg', 'hardneg_emb_onnx.npz', 4),
          ('imagenette', 'imagenette_emb_onnx.npz', 4),
          ('nabirds', 'nabirds_emb_onnx.npz', 2))

# The four numbers this script must agree with, and their key in BIRD_PROBE.
PROBE_FIELDS = (('bias', 'bias'),
                ('platt_a', 'plattA'),
                ('platt_b', 'plattB'),
                ('threshold', 'threshold'))

MISSING_EMB = ('These caches are external corpus data and are not in the '
               'repo. Point --emb-dir at the directory holding them, or '
               'override this one split with --%s-emb. Regenerate them with '
               'emit_emb_onnx.py if you do not have them.')


def read_client_probe(path):
    """Return BIRD_PROBE from the web adapter: the probe the app applies.

    The fixture is ground truth for a test of the client, so its constants
    must come from the client code rather than from a copy of it.
    """
    with open(path, encoding='utf-8') as fh:
        src = fh.read()
    m = re.search(r'export const BIRD_PROBE\s*=\s*\{(.*?)\}', src, re.S)
    if not m:
        raise SystemExit('no BIRD_PROBE object in ' + path + '; pass --bias, '
                         '--platt-a, --platt-b and --threshold explicitly '
                         'if the adapter moved it')
    body = m.group(1)
    out = {}
    for _, key in PROBE_FIELDS:
        km = re.search(key + r'\s*:\s*([0-9.eE+-]+)', body)
        if not km:
            raise SystemExit('no ' + key + ' in BIRD_PROBE in ' + path)
        out[key] = float(km.group(1))
    return out


def load_emb(path, name):
    """Load one embedding cache, naming the missing file if it is absent."""
    if not os.path.exists(path):
        raise SystemExit('missing ' + name + ' embedding cache: ' + path
                         + '. ' + (MISSING_EMB % name))
    with np.load(path) as z:
        if 'emb' not in z:
            raise SystemExit('no emb array in ' + path)
        return z['emb'].astype(np.float64)


def sig(x):
    return 1.0 / (1.0 + np.exp(-x))


def main():
    ap = argparse.ArgumentParser(description='Emit the probe end-to-end '
                                             'fixture for the TS test.')
    ap.add_argument('--bin',
                    default=os.path.join(SM.REPO_ROOT, 'public', 'models',
                                         'text_classifier_int8.bin'),
                    help='Shipped int8 text classifier. The probe row is read '
                         'back out of it so the fixture uses the QUANTIZED '
                         'weights the client loads.')
    ap.add_argument('--out',
                    default=os.path.join(SM.REPO_ROOT, 'src', '__tests__',
                                         'fixtures', 'probe-e2e.json'),
                    help='Fixture the TS test reads.')
    ap.add_argument('--adapter',
                    default=os.path.join(SM.REPO_ROOT, 'src', 'lib',
                                         'bird-id-local-adapter.ts'),
                    help='Single source of truth for the probe constants. '
                         'BIRD_PROBE there is what the app applies; read '
                         'rather than retyped so this fixture cannot assert '
                         'its own drifted copy.')
    ap.add_argument('--emb-dir', default=os.path.expanduser('~'),
                    help='Directory holding the *_emb_onnx.npz corpus caches. '
                         'External data, not repo files.')
    for name, base, _ in SPLITS:
        ap.add_argument('--' + name + '-emb', default=None,
                        help='Override the ' + name + ' cache. Defaults to '
                             + base + ' under --emb-dir.')
    for flag, key in PROBE_FIELDS:
        ap.add_argument('--' + flag.replace('_', '-'), type=float,
                        default=None,
                        help='Override BIRD_PROBE.' + key + '. Must agree '
                             'with the adapter; a disagreement is an error, '
                             'not a preference.')
    args = ap.parse_args()

    probe = read_client_probe(args.adapter)
    print('probe read from ' + args.adapter)
    for flag, key in PROBE_FIELDS:
        override = getattr(args, flag)
        if override is not None and override != probe[key]:
            # Silently preferring either side is how a fixture ends up
            # certifying a constant the client does not use.
            raise SystemExit(
                '--' + flag.replace('_', '-') + ' is ' + repr(override)
                + ' but BIRD_PROBE.' + key + ' in ' + args.adapter + ' is '
                + repr(probe[key]) + '. Fix one of them; this script will not '
                'choose between the shipped constant and a flag.')
        print('  ' + key + ' = ' + repr(probe[key]))
    bias = probe['bias']
    pa = probe['plattA']
    pb = probe['plattB']
    thr = probe['threshold']

    if not os.path.exists(args.bin):
        raise SystemExit('missing shipped classifier: ' + args.bin
                         + '; pass --bin')
    buf = np.fromfile(args.bin, dtype=np.uint8)
    n = len(buf) // (DIM + 4)
    q = buf[:n * DIM].view(np.int8).reshape(n, DIM)
    sc = buf[n * DIM:].view(np.float32)
    w = q[n - 1].astype(np.float64) * float(sc[n - 1])

    cases = []
    for name, base, k in SPLITS:
        path = getattr(args, name + '_emb')
        if path is None:
            path = os.path.join(args.emb_dir, base)
        e = load_emb(path, name)
        e = e / np.linalg.norm(e, axis=1, keepdims=True)
        raw = sig(e @ w + bias)
        c = np.clip(raw, EPS, 1 - EPS)
        cal = sig(pa * np.log(c / (1 - c)) + pb)
        # Spread across the score range rather than taking the first k, so the
        # fixture straddles the threshold instead of sampling one mode.
        order = np.argsort(cal)
        pick = order[np.linspace(0, len(order) - 1, k).astype(int)]
        for i in pick:
            cases.append(dict(set=name,
                              emb=[float(x) for x in e[i]],
                              pRaw=float(raw[i]),
                              pCal=float(cal[i]),
                              flagged=bool(cal[i] < thr)))

    nf = sum(1 for x in cases if x['flagged'])
    if nf == 0 or nf == len(cases):
        raise SystemExit('fixture does not straddle the threshold')
    with open(args.out, 'w') as f:
        json.dump(dict(cases=cases), f)
    print('wrote %d cases, %d flagged -> %s' % (len(cases), nf, args.out))


main()
