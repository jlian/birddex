#!/usr/bin/env python3
"""Emit 768-d normalized fp32-student embeddings from the SHIPPED a0.60 ckpt.

Yesterday's PyTorch caches (/home/jlian/*_emb.npz) were produced from
wise_a0.90.pt, the PREVIOUS model's best alpha. The shipped checkpoint is
wise_a0.60.pt (shipped_model.SHIPPED_CHECKPOINT). This regenerates the
PyTorch arm at the correct alpha so the fp32-vs-int8 comparison holds alpha
fixed and measures quantization only.

Iteration order mirrors emit_embeddings.py and emit_emb_onnx.py exactly
(shards sorted, tar member order, image suffixes only) so row order matches
the existing ONNX caches and every split stays comparable.

Preprocessing is the timm transform carried by the checkpoint. Verified
identical across alphas 0.25..0.90 (Resize 248, CenterCrop 224, same
normalisation) because they share one backbone, so the transform is not a
confound here.
"""
import argparse
import io
import os
import sys
import tarfile
import time

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import emit_calib_candidates as E  # noqa: E402
import shipped_model as SM  # noqa: E402

# ml/distill, resolved from THIS FILE. load_student() reads its model sources
# relative to this directory, so an author-specific absolute path made a
# default invocation fail on every other checkout even with valid corpus args.
# Same fix, same shape, as parity_emb.py and parity_gate.py.
HERE = os.path.dirname(os.path.abspath(__file__))


def log(m):
    print('[' + time.strftime('%H:%M:%S') + '] ' + str(m), flush=True)


def iter_images(d):
    """Yield (key, PIL image). Identical order to emit_embeddings.py."""
    shards = sorted(f for f in os.listdir(d) if f.endswith('.tar'))
    for sh in shards:
        with tarfile.open(os.path.join(d, sh)) as tf:
            for m in tf:
                if not m.isfile():
                    continue
                low = m.name.lower()
                if not low.endswith(('.jpg', '.jpeg', '.png')):
                    continue
                key = os.path.basename(m.name)
                key = key[:key.rindex('.')]
                try:
                    b = tf.extractfile(m).read()
                    im = Image.open(io.BytesIO(b)).convert('RGB')
                except Exception:
                    continue
                yield key, im


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--checkpoint', default=SM.SHIPPED_CHECKPOINT)
    ap.add_argument('--dirs', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--tag', required=True)
    ap.add_argument('--batch', type=int, default=64)
    ap.add_argument('--distill-root', '--distill-dir', dest='distill_root',
                    default=HERE,
                    help='ml/distill, passed to E.load_student for its '
                         'relative model sources.')
    args = ap.parse_args()

    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    log('checkpoint ' + args.checkpoint)
    st, preprocess = E.load_student(args.checkpoint, args.distill_root, device)
    log('preprocess ' + str(preprocess).replace('\n', ' '))

    embs = []
    keys = []
    buf = []
    meta = []
    t0 = time.time()

    def flush():
        if not buf:
            return
        x = torch.stack(buf).to(device)
        with torch.no_grad():
            e = F.normalize(st(x), dim=-1)
        e = e.cpu().numpy().astype(np.float16)
        for i in range(len(buf)):
            embs.append(e[i])
            keys.append(meta[i])
        buf.clear()
        meta.clear()

    for d in args.dirs.split(','):
        for key, im in iter_images(d):
            buf.append(preprocess(im))
            meta.append(key)
            if len(buf) >= args.batch:
                flush()
                if len(embs) % 2048 < args.batch:
                    r = len(embs) / max(1e-9, time.time() - t0)
                    log('  ' + str(len(embs)) + '  ' + ('%.1f' % r) + ' img/s')
        flush()

    arr = np.stack(embs).astype(np.float16)
    el = time.time() - t0
    np.savez_compressed(args.out, emb=arr, key=np.array(keys),
                        source=np.array([args.tag] * len(keys)))
    log('wrote ' + args.out + '  ' + str(arr.shape) + '  in ' +
        ('%.1f' % el) + 's  ' + ('%.1f' % (len(embs) / max(1e-9, el))) +
        ' img/s')
    print('=== EMIT A060 DONE ===')


if __name__ == '__main__':
    main()
