#!/usr/bin/env python3
"""Encode corpora through the SHIPPED int8 ONNX visual encoder.

Every discriminator number so far came from the PyTorch fp32 student. The app
runs the int8 ONNX graph, and an embedding-parity check showed the two differ
enough to move P_cal by 0.021. This produces the ONNX-side embeddings so the
probe can be refitted in the space the app actually computes in.

Iteration order mirrors emit_embeddings.py exactly (shards sorted, tar member
order, image suffixes only) so the row order of the resulting .npz matches the
PyTorch caches and the existing first-half/second-half negative splits stay
comparable.

Preprocessing uses the SAME timm transform as the PyTorch path, so this
isolates the quantisation difference and does not conflate it with a resize
difference. That mirrors what parity_emb.py measured.

CHECKPOINT USE. The checkpoint here supplies ONLY the timm preprocess
transform; the weights that produce the embeddings come from the ONNX
InferenceSession. The transform is identical across every alpha in the
run because they share one backbone (verified: Resize 248, CenterCrop
224, same normalisation for 0.25 through 0.90), so the old a0.90 default
did not change any number. It is repointed at the pinned shipped
checkpoint for consistency.
"""
import argparse
import io
import multiprocessing as mp
import os
import sys
import tarfile
import time

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shipped_model as SM  # noqa: E402

ONNX = '/home/jlian/wingdex/public/models/wingclip_visual_int8.onnx'
CKPT = SM.SHIPPED_CHECKPOINT

_G = {}


def log(m):
    print('[' + time.strftime('%H:%M:%S') + '] ' + str(m), flush=True)


def init_worker():
    import onnxruntime as ort
    import torch
    torch.set_num_threads(1)
    sys.path.insert(0, '/home/jlian/wingdex/ml/distill')
    import emit_calib_candidates as E
    _st, pp = E.load_student(CKPT, '/home/jlian/wingdex/ml/distill', 'cpu')
    del _st
    so = ort.SessionOptions()
    so.intra_op_num_threads = 1
    so.inter_op_num_threads = 1
    sess = ort.InferenceSession(ONNX, so,
                                providers=['CPUExecutionProvider'])
    _G['pp'] = pp
    _G['sess'] = sess
    _G['iname'] = sess.get_inputs()[0].name


def run_batch(job):
    import torch
    keys, blobs = job
    xs = []
    ok = []
    for k, b in zip(keys, blobs):
        try:
            im = Image.open(io.BytesIO(b)).convert('RGB')
        except Exception:
            continue
        xs.append(_G['pp'](im))
        ok.append(k)
    if not xs:
        return [], np.zeros((0, 768), dtype=np.float32)
    x = torch.stack(xs).numpy().astype(np.float32)
    e = _G['sess'].run(None, {_G['iname']: x})[0].astype(np.float32)
    e = e / np.linalg.norm(e, axis=1, keepdims=True)
    return ok, e


def iter_jobs(dirs, batch, limit=0):
    keys = []
    blobs = []
    seen = 0
    for d in dirs:
        for sh in sorted(f for f in os.listdir(d) if f.endswith('.tar')):
            with tarfile.open(os.path.join(d, sh)) as tf:
                for m in tf:
                    if not m.isfile():
                        continue
                    low = m.name.lower()
                    if not low.endswith(('.jpg', '.jpeg', '.png')):
                        continue
                    key = os.path.basename(m.name)
                    key = key[:key.rindex('.')]
                    f = tf.extractfile(m)
                    if f is None:
                        continue
                    keys.append(key)
                    blobs.append(f.read())
                    seen += 1
                    if len(keys) >= batch:
                        yield (keys, blobs)
                        keys = []
                        blobs = []
                    if limit and seen >= limit:
                        if keys:
                            yield (keys, blobs)
                        return
    if keys:
        yield (keys, blobs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dirs', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--tag', required=True)
    ap.add_argument('--procs', type=int, default=14)
    ap.add_argument('--batch', type=int, default=16)
    ap.add_argument('--limit', type=int, default=0)
    args = ap.parse_args()

    dirs = args.dirs.split(',')
    t0 = time.time()
    allk = []
    alle = []
    with mp.Pool(args.procs, initializer=init_worker) as pool:
        for ok, e in pool.imap(run_batch,
                               iter_jobs(dirs, args.batch, args.limit),
                               chunksize=1):
            if len(ok) == 0:
                continue
            allk.extend(ok)
            alle.append(e)
            n = len(allk)
            if n % 1024 < args.batch:
                r = n / max(1e-9, time.time() - t0)
                log('  ' + str(n) + '  ' + ('%.1f' % r) + ' img/s')
    emb = np.concatenate(alle).astype(np.float16)
    el = time.time() - t0
    np.savez_compressed(args.out, emb=emb, key=np.array(allk),
                        source=np.array([args.tag] * len(allk)))
    log('wrote ' + args.out + '  ' + str(emb.shape) + '  in ' +
        ('%.1f' % el) + 's  ' + ('%.1f' % (len(allk) / max(1e-9, el))) +
        ' img/s')
    print('=== ONNX EMIT DONE ===')


if __name__ == '__main__':
    main()
