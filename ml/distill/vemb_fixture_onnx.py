#!/usr/bin/env python3
"""Emit the Guatemala vulture shortlist fixture from the SHIPPED path.

WHY THIS EXISTS. src/__tests__/fixtures/vulture-shortlist.json was emitted by
vemb.py, which runs the fp32 PyTorch student. The browser runs the int8 ONNX
graph, so the fixture pinned similarities the shipped path never produces and
the test around it could stay green while the shipped encoder drifted.

BOTH SIDES OF THE DOT PRODUCT ARE NOW THE SHIPPED ONES. An earlier revision of
this file fixed only the image side: the embedding came from the ONNX session
but the TEXT side still came from build_text(), which rebuilds fp32 embeddings
from the taxonomy. The browser never sees those. It decodes
public/models/text_classifier_int8.bin (int8 rows plus fp32 per-row scales),
dequantises, and dots the result. So the text rows are read out of that file
here, exactly as src/lib/bird-id-local.ts decodeInt8Rows does it.

The dequantised rows are used AS DECODED, not re-normalised. They were
L2-normalised before quantisation, so their norms land near but not exactly at
1, and the browser does not renormalise either. Renormalising here would
reintroduce a difference from the shipped path in the opposite direction.

The LAST row of that file is the bird/not-bird probe, not a species, so only
the first taxonomy-length rows take part in the similarity.

The top-25 is recomputed rather than re-scored on the cached indices, because
quantisation can reorder the shortlist and copying the old index list would
hide exactly that.

Preprocessing is the timm transform off the pinned checkpoint. The checkpoint
supplies ONLY that transform; no weight used here comes from PyTorch.

EVERY INPUT THAT SHAPES THE OUTPUT IS SHIPPED OR IS A FLAG. --named used to be
required and defaulted to an untracked workstation file, so the committed
fixture could not be regenerated anywhere else. It is optional now: it drives a
printed delta report against the old fp32 shortlist and nothing that is written.
The photo lat/lon/month are plain flags carrying the EXIF values.
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
EMBED_DIM = 768


def decode_int8_rows(path, dim):
    """Decode the shipped classifier the way src/lib/bird-id-local.ts does.

    Layout is n*dim int8 bytes followed by n fp32 per-row scales, so
    n = len / (dim + 4) and row s is q[s] * scale[s]. Returns the FULL matrix,
    probe row included; the caller drops the last row.
    """
    buf = np.fromfile(path, dtype=np.uint8)
    n = len(buf) // (dim + 4)
    if n < 1 or n * (dim + 4) != len(buf):
        raise SystemExit('classifier is ' + str(len(buf)) + ' bytes, not a '
                         'whole number of ' + str(dim + 4) + '-byte rows')
    q = buf[:n * dim].view(np.int8).reshape(n, dim).astype(np.float64)
    scales = buf[n * dim:].view(np.float32).astype(np.float64)
    return q * scales[:, None]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--image', default='/home/jlian/vulture_crop.png')
    ap.add_argument('--checkpoint', default=SM.SHIPPED_CHECKPOINT,
                    help='supplies the timm preprocess transform only')
    ap.add_argument('--onnx', default=SM.SHIPPED_ONNX)
    ap.add_argument('--taxonomy', default=SM.SHIPPED_TAXONOMY)
    ap.add_argument('--classifier',
                    default=os.path.join(SM.REPO_ROOT, 'public', 'models',
                                         'text_classifier_int8.bin'),
                    help='the SHIPPED int8 text rows the browser decodes')
    ap.add_argument('--distill-root', default=HERE)
    # OPTIONAL. This is a workstation scratch file holding the OLD fp32
    # PyTorch shortlist. It contributes nothing to the emitted fixture except
    # a printed delta report, so requiring it made the committed fixture
    # unreproducible on any other checkout even with every shipped input
    # present. Absent, the comparison is skipped and everything else is
    # byte-identical.
    ap.add_argument('--named', default=None,
                    help='OPTIONAL previous PyTorch shortlist, for the delta '
                         'report only. Omit it and the report is skipped.')
    # The photo EXIF. These used to be read out of --named when it happened to
    # carry them, with these same literals as the fallback, so they are stated
    # as flags rather than hidden behind an untracked file.
    ap.add_argument('--lat', type=float, default=14.752512)
    ap.add_argument('--lon', type=float, default=-91.165575)
    ap.add_argument('--month', type=int, default=8)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    import onnxruntime as ort

    _st, pp = E.load_student(args.checkpoint, args.distill_root, 'cpu')
    del _st
    sess = ort.InferenceSession(args.onnx,
                                providers=['CPUExecutionProvider'])
    iname = sess.get_inputs()[0].name

    im = Image.open(args.image).convert('RGB')
    x = pp(im).unsqueeze(0).numpy().astype(np.float32)
    e = sess.run(None, {iname: x})[0].astype(np.float64)
    e = e / np.linalg.norm(e, axis=1, keepdims=True)

    # The SHIPPED text side. Not build_text(): that rebuilds fp32 embeddings
    # the browser never loads. The last row is the probe, so the species matrix
    # is everything before it, and it must be exactly taxonomy-length.
    rows = decode_int8_rows(args.classifier, EMBED_DIM)
    n_species = len(rows) - 1
    n_taxa = len(json.load(open(args.taxonomy)))
    if n_species != n_taxa:
        raise SystemExit('classifier has ' + str(n_species) + ' species rows '
                         'but the taxonomy has ' + str(n_taxa))
    tfn = rows[:n_species]
    print('text rows from ' + args.classifier)
    print('  ' + str(n_species) + ' species rows + 1 probe row')
    print('  dequantised row norm min/max ' +
          ('%.6f' % np.linalg.norm(tfn, axis=1).min()) + ' / ' +
          ('%.6f' % np.linalg.norm(tfn, axis=1).max()) +
          '  (used AS DECODED, the client does not renormalise)')
    sims = (e @ tfn.T)[0]

    order = np.argsort(-sims)[:TOPK]
    idx = [int(i) for i in order]
    sim = [float(sims[i]) for i in order]

    print('new (int8 ONNX) top-1 idx ' + str(idx[0]) +
          ' sim ' + ('%.6f' % sim[0]))
    if args.named:
        prev = json.load(open(args.named))
        pidx = [int(i) for i in prev['cand_idx']]
        psim = np.array(prev['cand_sim'], dtype=np.float64)
        print('previous (fp32 PyTorch) top-1 idx ' + str(pidx[0]) +
              ' sim ' + ('%.6f' % psim[0]))
        print('shortlist order identical: ' + str(pidx == idx))
        print('set identical: ' + str(set(pidx) == set(idx)))
        common = [i for i in idx if i in set(pidx)]
        print('overlap ' + str(len(common)) + '/' + str(TOPK))
        d = np.abs(np.array([sims[i] for i in pidx]) - psim).max()
        print('max |sim_onnx - sim_pytorch| on the OLD 25: ' + ('%.6f' % d))
    else:
        print('no --named baseline given, delta report skipped')

    out = {
        'note': ('Real 25-candidate shortlist for the Guatemala vulture, '
                 'emitted by ml/distill/vemb_fixture_onnx.py through the '
                 'SHIPPED path on BOTH sides of the dot product: the int8 '
                 'ONNX visual encoder '
                 '(public/models/wingclip_visual_int8.onnx) and the '
                 'dequantised int8 text rows the browser decodes out of '
                 'public/models/text_classifier_int8.bin. Earlier revisions '
                 'used the fp32 PyTorch student, and then the ONNX encoder '
                 'against fp32 build_text() rows, both of which pinned '
                 'similarities the browser never produces. lat/lon/month are '
                 'the photo EXIF.'),
        'lat': args.lat,
        'lon': args.lon,
        'month': args.month,
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
