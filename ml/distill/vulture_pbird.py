#!/usr/bin/env python3
"""Add the ONNX-space P_cal(bird) for the vulture crop to the fixture.

The displayed confidence is P_cal(bird) * P(species | bird). The fixture
already carries the shortlist that produces the species term; without pBird a
test can only assert the species term, which is not what the app shows.

The probe weight is the LAST row of the int8 text classifier, exactly as the
engine reads it, so this pins the shipped decode too.
"""
import argparse
import json
import os
import sys

import numpy as np

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import emit_calib_candidates as E  # noqa: E402
import shipped_model as SM  # noqa: E402

EMBED_DIM = 768
EPS = 1e-7


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


def logit(p):
    c = min(max(p, EPS), 1.0 - EPS)
    return float(np.log(c / (1.0 - c)))


def decode_last_row(path, dim):
    buf = np.fromfile(path, dtype=np.uint8)
    n = len(buf) // (dim + 4)
    assert n * (dim + 4) == len(buf), 'classifier length'
    q = buf[:n * dim].view(np.int8).reshape(n, dim)
    scales = buf[n * dim:].view(np.float32)
    return q[n - 1].astype(np.float64) * float(scales[n - 1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--image', default='/home/jlian/vulture_crop.png')
    ap.add_argument('--checkpoint', default=SM.SHIPPED_CHECKPOINT)
    ap.add_argument('--onnx', default=SM.SHIPPED_ONNX)
    ap.add_argument('--classifier',
                    default=os.path.join(SM.REPO_ROOT, 'public', 'models',
                                         'text_classifier_int8.bin'))
    ap.add_argument('--adapter',
                    default=os.path.join(SM.REPO_ROOT, 'src', 'lib',
                                         'bird-id-local-adapter.ts'),
                    help='BIRD_PROBE is the shipped source of truth')
    ap.add_argument('--fixture', required=True)
    args = ap.parse_args()

    import onnxruntime as ort

    _st, pp = E.load_student(args.checkpoint, HERE, 'cpu')
    del _st
    sess = ort.InferenceSession(args.onnx,
                                providers=['CPUExecutionProvider'])
    iname = sess.get_inputs()[0].name

    im = Image.open(args.image).convert('RGB')
    x = pp(im).unsqueeze(0).numpy().astype(np.float32)
    e = sess.run(None, {iname: x})[0].astype(np.float64)
    e = e / np.linalg.norm(e, axis=1, keepdims=True)
    e = e[0]

    w = decode_last_row(args.classifier, EMBED_DIM)
    # Parsed out of the shipped TS so this cannot drift from what the app
    # applies. bird_probe.json carries the fit, not the Platt pair.
    import re
    src = open(args.adapter).read()
    blk = re.search(r'export const BIRD_PROBE = \{(.*?)\}', src, re.S).group(1)
    def field(name):
        return float(re.search(name + r':\s*([0-9.eE+-]+)', blk).group(1))
    bias = field('bias')
    a = field('plattA')
    b = field('plattB')
    print('threshold ' + repr(field('threshold')))

    p_raw = float(sigmoid(float(w @ e) + bias))
    p_cal = float(sigmoid(a * logit(p_raw) + b))
    print('P_raw ' + ('%.10f' % p_raw))
    print('P_cal ' + ('%.10f' % p_cal))

    fx = json.load(open(args.fixture))
    fx['p_bird'] = p_cal
    fx['p_bird_note'] = (
        'Calibrated P(bird) for this crop, computed through the SAME int8 '
        'ONNX encoder and the same last-row probe decode the app uses. The '
        'displayed confidence is p_bird * P(species | bird).')
    with open(args.fixture, 'w') as f:
        json.dump(fx, f, indent=2)
        f.write(chr(10))
    print('updated ' + args.fixture)
    print('=== PBIRD DONE ===')


if __name__ == '__main__':
    main()
