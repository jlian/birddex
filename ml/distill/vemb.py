#!/usr/bin/env python3
"""Encode the Guatemala vulture crop into a 768-d student embedding.

Also re-derives the shortlist sims from that same embedding and checks them
against /home/jlian/vulture_named.json, so the discriminator's P(bird) and the
cosine null's species scores are provably about the SAME image.

SUPERSEDED RESULTS. Every number previously produced by this file was
measured with runs/ft_tiny39_fresh/wise_a0.90.pt, which is WingCLIP-0.1's
best alpha and NOT the model that ships. The default is now the pinned
shipped checkpoint (shipped_model.SHIPPED_CHECKPOINT, alpha 0.60). Treat
any earlier output of this script as describing a different model.
"""
import argparse
import json

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

import emit_calib_candidates as E
import shipped_model as SM  # noqa: E402  the pinned shipped checkpoint


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--image', default='/home/jlian/vulture_crop.png')
    ap.add_argument('--checkpoint',
                    default=SM.SHIPPED_CHECKPOINT,
                    help="pinned shipped checkpoint; see shipped_model.py")
    ap.add_argument('--taxonomy',
                    default='/home/jlian/wingdex/src/lib/taxonomy.json')
    ap.add_argument('--out', default='/home/jlian/vulture_emb.npz')
    args = ap.parse_args()

    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    st, preprocess = E.load_student(args.checkpoint,
                                    '/home/jlian/wingdex/ml/distill', device)
    im = Image.open(args.image).convert('RGB')
    x = preprocess(im).unsqueeze(0).to(device)
    with torch.no_grad():
        e = F.normalize(st(x), dim=-1)
    emb = e.cpu().numpy().astype(np.float16)
    print('embedding ' + str(emb.shape))

    tf, _ = E.build_text(args.taxonomy, device)
    sims = (e @ tf.T)[0].cpu().numpy().astype(np.float64)
    vj = json.load(open('/home/jlian/vulture_named.json'))
    idx = np.array(vj['cand_idx'])
    ref = np.array(vj['cand_sim'], dtype=np.float64)
    got = sims[idx]
    md = float(np.abs(got - ref).max())
    print('max |sim - cached sim| over the 25 shortlist candidates: ' +
          ('%.6f' % md))
    print('AGREES' if md < 5e-3 else 'MISMATCH -- embedding is a different image')
    np.savez_compressed(args.out, emb=emb, sim_maxdiff=np.array([md]))
    print('wrote ' + args.out)


if __name__ == '__main__':
    main()
