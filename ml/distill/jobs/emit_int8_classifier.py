"""Emit the int8 per-row text classifier that G17 selected.

G17 measured all four options over 24,633 NABirds images:
  fp32 32.72 MiB 86.91, fp16 16.36 MiB 86.91,
  int8-global 8.18 MiB 86.88, int8-perrow 8.22 MiB 86.96

Per-row won because a single global scale has to cover 11,167 unrelated species
embeddings, while per-row costs 11,167 extra fp32 values, about 44 KB.

File layout, one file so the client does one fetch:
  [0, N*768)                int8 quantised matrix, row major
  [N*768, N*768 + N*4)      fp32 per-row scales

The client reconstructs row s as q[s] * scale[s].
"""
import os

import numpy as np

SRC = "ml/distill/onnx_tiny39/text_classifier.npy"
OUT = "public/models/text_classifier_int8.bin"

tf = np.load(SRC).astype(np.float32)
tf = tf / np.linalg.norm(tf, axis=1, keepdims=True)

scale = np.abs(tf).max(axis=1, keepdims=True) / 127.0
scale[scale == 0] = 1e-12
q = np.clip(np.round(tf / scale), -127, 127).astype(np.int8)

with open(OUT, "wb") as f:
    f.write(q.tobytes())
    f.write(scale.astype(np.float32).ravel().tobytes())

b = os.path.getsize(OUT)
print("shape %s, scales %s" % (q.shape, scale.shape))
print("int8 classifier %.2f MiB (fp16 was 16.36)" % (b / 1048576))

# Prove the round trip before shipping it.
back = q.astype(np.float32) * scale
cos = (back * tf).sum(axis=1) / (
    np.linalg.norm(back, axis=1) * np.linalg.norm(tf, axis=1))
print("row cosine after round trip: min %.6f mean %.6f" % (cos.min(), cos.mean()))
