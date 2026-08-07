"""What fraction of NON-BIRDS passes a VISION-ONLY gate, swept low?

Every negatives number on record is at threshold 0.5 or above (2.4% pass, on
Imagenette), or post-rerank (18.6% pass at 0.5, 68.4% at 0.2). Neither answers
the question H3 actually turns on: a vision-only gate at 0.1 keeps 99.8% of
real birds, so what does it cost in non-birds waved through?

Same score as eval_nabirds.py: softmax(sims * 100).max() over raw
vision-to-text similarity, no prior, no month, no fitted T or beta.

Negatives are Imagenette val, which is EASY: tench, chainsaws, golf balls.
Nothing bird-shaped. So every number here is a FLOOR on the pass rate, not a
guarantee. Hard negatives (squirrels, planes, empty branches) will be worse.
"""
import glob
import os
import sys
import time

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

sys.path.insert(0, "/home/jlian/wingdex/ml/distill")

CKPT = "/home/jlian/wingdex/ml/distill/runs/ft_tiny39_fresh/wise_a0.60.pt"
IMAGENETTE = "/home/jlian/wingdex/ml/imagenette/val"
TAXO = "/home/jlian/wingdex/src/lib/taxonomy.json"
LIMIT = int(os.environ.get("LIMIT", "1200"))

from emit_calib_candidates import load_student, build_text as build_text_classifier  # noqa: E402
import json  # noqa: E402

dev = "cuda" if torch.cuda.is_available() else "cpu"
print("device: %s" % dev, flush=True)

taxo = json.load(open(TAXO))
student, preprocess = load_student(CKPT, "/home/jlian/wingdex/ml/distill", dev)
clf, _taxo = build_text_classifier(TAXO, dev)
print("classifier: %s" % (tuple(clf.shape),), flush=True)

files = sorted(glob.glob(os.path.join(IMAGENETTE, "*", "*.JPEG")))
if LIMIT:
    step = max(1, len(files) // LIMIT)
    files = files[::step][:LIMIT]
print("non-bird images: %d" % len(files), flush=True)

confs = []
buf = []
t0 = time.time()


def flush():
    if not buf:
        return
    x = torch.stack(buf).to(dev)
    with torch.no_grad():
        e = student(x)
        e = F.normalize(e, dim=-1)
        sims = e @ clf.T
        c = (sims * 100).softmax(-1).max(-1).values
    confs.extend(c.float().cpu().numpy().tolist())
    buf.clear()


for n, f in enumerate(files):
    try:
        im = Image.open(f).convert("RGB")
    except Exception:
        continue
    buf.append(preprocess(im))
    if len(buf) >= 64:
        flush()
    if n and n % 400 == 0:
        print("  %d/%d  (%.0f/s)" % (n, len(files), n / (time.time() - t0)), flush=True)
flush()

c = np.array(confs)
print("")
print("scored %d non-bird images in %.0fs" % (len(c), time.time() - t0))
print("")
print("VISION-ONLY gate, non-birds passing (lower is better):")
print("")
print("  %-10s %14s %16s" % ("threshold", "non-birds pass", "birds kept*"))
BIRDS = {0.0: 100.0, 0.05: 100.0, 0.1: 99.8, 0.15: 97.9, 0.2: 95.1,
         0.3: 87.9, 0.5: 71.4, 0.7: 52.1, 0.9: 22.1}
for thr in [0.0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.7, 0.9]:
    frac = float((c >= thr).mean()) * 100
    print("  %-10.2f %13.1f%% %15.1f%%" % (thr, frac, BIRDS[thr]))
print("")
print("* birds kept is the held-out split coverage already measured, shown")
print("  alongside so the trade is visible in one place.")
print("")
print("Imagenette is EASY negatives. Treat every pass rate as a FLOOR.")
