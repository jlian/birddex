"""Emit the int8 per-row text classifier that G17 selected.

G17 measured all four options over 24,633 NABirds images:
  fp32 32.72 MiB 86.91, fp16 16.36 MiB 86.91,
  int8-global 8.18 MiB 86.88, int8-perrow 8.22 MiB 86.96

Per-row won because a single global scale has to cover 11,167 unrelated species
embeddings, while per-row costs 11,167 extra fp32 values, about 44 KB.

The file also carries the bird/not-bird PROBE as one extra row past the
species. It is a 768-d logistic coefficient vector, so it fits this layout
with no format change for 772 bytes, and the client gets it in the fetch it
was already doing. Row N-1 is the probe; rows 0..N-2 are the species.

File layout, one file so the client does one fetch:
  [0, N*768)                int8 quantised matrix, row major
  [N*768, N*768 + N*4)      fp32 per-row scales

The client reconstructs row s as q[s] * scale[s].

WHY THE PROBE IS QUANTISED HERE AT ALL. Forcing it into int8 was measured
before it was chosen (ml/distill/probe_quant.py): worst movement in the bird
flag rate is +0.060 pp on 3,321 validation birds and 0.000 pp on 8,000
NABirds, against a 0.1 pp ship criterion. max |dP_cal| is 0.0162 and mean
|dP_cal| is 0.0029 across 44,965 rows. That is cheap enough to prefer over a
fifth asset.

The probe is NOT L2-normalised with the species rows. It is a logistic
coefficient vector whose magnitude is part of the decision boundary, and the
per-row scale format carries arbitrary magnitude, so it survives.
"""
import argparse
import json
import os

import numpy as np

SRC = "ml/distill/onnx_tiny39/text_classifier.npy"
PROBE = "ml/distill/jobs/bird_probe.json"
OUT = "public/models/text_classifier_int8.bin"

ap = argparse.ArgumentParser()
ap.add_argument("--src", default=SRC)
ap.add_argument("--probe", default=PROBE)
ap.add_argument("--out", default=OUT)
ap.add_argument("--keep-map", default="",
                help="scripts/taxonomy-keep-map.json. When given, keep ONLY "
                     "kept_old_indexes, in order. Species are keyed by ROW "
                     "INDEX, so a taxonomy row drop must select the same rows "
                     "here or every later species is mis-keyed.")
args = ap.parse_args()
SRC, PROBE, OUT = args.src, args.probe, args.out

tf = np.load(SRC).astype(np.float32)

if args.keep_map:
    with open(args.keep_map) as f:
        km = json.load(f)
    keep = np.asarray(km["kept_old_indexes"], dtype=np.int64)
    if tf.shape[0] < int(keep.max()) + 1:
        raise SystemExit(
            "keep-map indexes up to %d but the matrix has %d rows; the .npy "
            "predates the taxonomy it is being filtered against"
            % (int(keep.max()), tf.shape[0]))
    before = tf.shape[0]
    tf = tf[keep]
    print("keep-map: %d -> %d rows (dropped %d)"
          % (before, tf.shape[0], before - tf.shape[0]))

tf = tf / np.linalg.norm(tf, axis=1, keepdims=True)

scale = np.abs(tf).max(axis=1, keepdims=True) / 127.0
scale[scale == 0] = 1e-12
q = np.clip(np.round(tf / scale), -127, 127).astype(np.int8)

# Append the probe as the last row, quantised the same way. The bias, the
# Platt pair and the threshold are NOT here: they are four scalars inlined as
# BIRD_PROBE in src/lib/bird-id-local-adapter.ts, next to the temperature and
# beta they have to stay consistent with.
with open(PROBE) as f:
    probe = json.load(f)
pw = np.asarray(probe["coef"], dtype=np.float64)
if pw.shape != (tf.shape[1],):
    raise SystemExit("probe is %s, expected (%d,)" % (pw.shape, tf.shape[1]))
pscale = np.abs(pw).max() / 127.0
pq = np.clip(np.round(pw / pscale), -127, 127).astype(np.int8)

with open(OUT, "wb") as f:
    f.write(q.tobytes())
    f.write(pq.tobytes())
    f.write(scale.astype(np.float32).ravel().tobytes())
    f.write(np.float32(pscale).tobytes())

b = os.path.getsize(OUT)
print("shape %s, scales %s" % (q.shape, scale.shape))
print("%d species rows + 1 probe row = %d rows" % (q.shape[0], q.shape[0] + 1))
print("int8 classifier %.2f MiB (fp16 was 16.36)" % (b / 1048576))

# Prove the round trip before shipping it.
back = q.astype(np.float32) * scale
cos = (back * tf).sum(axis=1) / (
    np.linalg.norm(back, axis=1) * np.linalg.norm(tf, axis=1))
print("row cosine after round trip: min %.6f mean %.6f" % (cos.min(), cos.mean()))

pback = pq.astype(np.float64) * pscale
pcos = pback @ pw / (np.linalg.norm(pback) * np.linalg.norm(pw))
print("probe row cosine after round trip: %.8f" % pcos)

# The count check in the client keys off this: a file that is exactly the
# taxonomy length is the STALE one, and would hand a species row to the probe.
# Bump MODEL_VERSION in src/lib/bird-id-local-adapter.ts whenever these bytes
# change:
#   cat public/models/wingclip_visual_int8.onnx \
#       public/models/wingclip_visual_int8.data \
#       public/models/text_classifier_int8.bin | sha256sum
