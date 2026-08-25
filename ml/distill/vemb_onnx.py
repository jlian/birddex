#!/usr/bin/env python3
"""Encode the Guatemala vulture crop through the SHIPPED int8 ONNX encoder.

Same preprocessed tensor as vemb.py, so the only difference is the encoder.

CHECKPOINT USE. The checkpoint here supplies ONLY the timm preprocess
transform; the weights that produce the embeddings come from the ONNX
InferenceSession. The transform is identical across every alpha in the
run because they share one backbone (verified: Resize 248, CenterCrop
224, same normalisation for 0.25 through 0.90), so the old a0.90 default
did not change any number. It is repointed at the pinned shipped
checkpoint for consistency.
"""
import argparse
import sys

import numpy as np
import torch

from PIL import Image

sys.path.insert(0, '/home/jlian/wingdex/ml/distill')
import emit_calib_candidates as E
import shipped_model as SM  # noqa: E402  the pinned shipped checkpoint


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--image', default='/home/jlian/vulture_crop.png')
    ap.add_argument('--checkpoint',
                    default=SM.SHIPPED_CHECKPOINT,
                    help="pinned shipped checkpoint; see shipped_model.py")
    ap.add_argument('--onnx',
                    default='/home/jlian/wingdex/public/models/'
                            'wingclip_visual_int8.onnx')
    ap.add_argument('--taxonomy',
                    default='/home/jlian/wingdex/src/lib/taxonomy.json')
    ap.add_argument('--out', default='/home/jlian/vulture_emb_onnx.npz')
    args = ap.parse_args()

    import onnxruntime as ort
    _st, pp = E.load_student(args.checkpoint,
                             '/home/jlian/wingdex/ml/distill', 'cpu')
    del _st
    sess = ort.InferenceSession(args.onnx, providers=['CPUExecutionProvider'])
    iname = sess.get_inputs()[0].name

    im = Image.open(args.image).convert('RGB')
    x = pp(im).unsqueeze(0).numpy().astype(np.float32)
    e = sess.run(None, {iname: x})[0].astype(np.float64)
    e = e / np.linalg.norm(e, axis=1, keepdims=True)
    print('embedding ' + str(e.shape))

    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    tf, _ = E.build_text(args.taxonomy, device)
    tfn = tf.cpu().numpy().astype(np.float64)
    sims = (e @ tfn.T)[0]
    import json
    vj = json.load(open('/home/jlian/vulture_named.json'))
    idx = np.array(vj['cand_idx'])
    ref = np.array(vj['cand_sim'], dtype=np.float64)
    got = sims[idx]
    md = float(np.abs(got - ref).max())
    print('max |sim_onnx - sim_pytorch_cached| over 25 shortlist: ' +
          ('%.6f' % md))
    print('(this is expected to be NONZERO: it is the quantisation shift)')
    np.savez_compressed(args.out, emb=e.astype(np.float16),
                        sim=sims[idx].astype(np.float64),
                        sim_maxdiff=np.array([md]))
    print('wrote ' + args.out)
    print('=== VEMB ONNX DONE ===')


if __name__ == '__main__':
    main()
