#!/usr/bin/env python3
"""Emit the Guatemala vulture shortlist fixture from the SHIPPED int8 ONNX.

WHY THIS EXISTS. src/__tests__/fixtures/vulture-shortlist.json was emitted by
vemb.py, which runs the fp32 PyTorch student. The browser runs the int8 ONNX
graph, so the fixture pinned similarities the shipped path never produces and
the test around it could stay green while the shipped encoder drifted.

The top-25 is recomputed here rather than re-scored on the cached indices,
because quantisation can reorder the shortlist and copying the PyTorch index
list would hide exactly that.

Preprocessing is the SAME timm transform as the PyTorch path, so this isolates
the encoder. The checkpoint supplies ONLY that transform; every weight used to
produce the embedding comes from the ONNX InferenceSession.
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
import shipped_model as SM  # noqa: E402  the pinned shipped checkpoint

TOPK = 25


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--image', default='/home/jlian/vulture_crop.png')
    ap.add_argument('--checkpoint', default=SM.SHIPPED_CHECKPOINT,
                    help='supplies the timm preprocess transform only')
    ap.add_argument('--onnx', default=SM.SHIPPED_ONNX)
    ap.add_argument('--taxonomy', default=SM.SHIPPED_TAXONOMY)
    ap.add_argument('--distill-root', default=HERE)
    ap.add_argument('--named', default='/home/jlian/vulture_named.json',
                    help='previous PyTorch shortlist, for the delta report')
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    import onnxruntime as ort
    import torch

    _st, pp = E.load_student(args.checkpoint, args.distill_root, 'cpu')
    del _st
    sess = ort.InferenceSession(args.onnx,
                                providers=['CPUExecutionProvider'])
    iname = sess.get_inputs()[0].name

    im = Image.open(args.image).convert('RGB')
    x = pp(im).unsqueeze(0).numpy().astype(np.float32)
    e = sess.run(None, {iname: x})[0].astype(np.float64)
    e = e / np.linalg.norm(e, axis=1, keepdims=True)

    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    tf, _ = E.build_text(args.taxonomy, device)
    tfn = tf.cpu().numpy().astype(np.float64)
    sims = (e @ tfn.T)[0]

    order = np.argsort(-sims)[:TOPK]
    idx = [int(i) for i in order]
    sim = [float(sims[i]) for i in order]

    prev = json.load(open(args.named))
    pidx = [int(i) for i in prev['cand_idx']]
    psim = np.array(prev['cand_sim'], dtype=np.float64)
    print('previous (fp32 PyTorch) top-1 idx ' + str(pidx[0]) +
          ' sim ' + ('%.6f' % psim[0]))
    print('new      (int8 ONNX)    top-1 idx ' + str(idx[0]) +
          ' sim ' + ('%.6f' % sim[0]))
    print('shortlist order identical: ' + str(pidx == idx))
    print('set identical: ' + str(set(pidx) == set(idx)))
    common = [i for i in idx if i in set(pidx)]
    print('overlap ' + str(len(common)) + '/' + str(TOPK))
    d = np.abs(np.array([sims[i] for i in pidx]) - psim).max()
    print('max |sim_onnx - sim_pytorch| on the OLD 25: ' + ('%.6f' % d))

    out = {
        'note': ('Real 25-candidate shortlist for the Guatemala vulture, '
                 'emitted by ml/distill/vemb_fixture_onnx.py through the '
                 'SHIPPED int8 ONNX visual encoder '
                 '(public/models/wingclip_visual_int8.onnx), which is what '
                 'the browser runs. An earlier revision of this file came '
                 'from the fp32 PyTorch student via vemb.py and therefore '
                 'pinned similarities the shipped path never produces. '
                 'lat/lon/month are the photo EXIF.'),
        'lat': prev['lat'] if 'lat' in prev else 14.752512,
        'lon': prev['lon'] if 'lon' in prev else -91.165575,
        'month': prev['month'] if 'month' in prev else 8,
        'cand_idx': idx,
        'cand_sim': sim,
    }
    with open(args.out, 'w') as f:
        json.dump(out, f, indent=2)
        f.write(chr(10))
    print('wrote ' + args.out)
    print('=== VULTURE FIXTURE ONNX DONE ===')


if __name__ == '__main__':
    main()
