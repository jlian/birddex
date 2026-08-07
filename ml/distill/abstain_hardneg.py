#!/usr/bin/env python3
"""H3 abstention sweep, ONE scorer ONE denominator for both arms.

Fixes the earlier score-mismatch bug: birds had been scored by
abstain_postrank.py (softmax over 25 candidates) while non-birds went
through neg_sweep.py (softmax over 11,167 species). Different denominators,
so the curves were never comparable. Here BOTH positives and negatives use
the IDENTICAL score:

    conf = (sims * 100).softmax(-1).max(-1)   over ALL 11,167 species
    sims = normalize(student(x)) @ clf.T
"""
import glob
import json
import os
import sys
import time

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

ML = "/home/jlian/wingdex/ml"
DISTILL = ML + "/distill"
sys.path.insert(0, DISTILL)

CKPT = DISTILL + "/runs/ft_tiny39_fresh/wise_a0.60.pt"
TAXO = DISTILL + "/taxonomy.json"
VAL_IDS = ML + "/val_ids_seed0.json"
HELDOUT = ML + "/heldout-orig"
HARDNEG = ML + "/hard-negatives"

from emit_calib_candidates import load_student, build_text  # noqa: E402


def log(m):
    print(str(m), flush=True)


dev = "cuda" if torch.cuda.is_available() else "cpu"
log("device: " + dev)

# build_text returns a (classifier, taxo) TUPLE
clf, taxo = build_text(TAXO, dev)
student, preprocess = load_student(CKPT, DISTILL, dev)
log("classifier: " + str(tuple(clf.shape)))


def score_files(files, label):
    confs = []
    buf = []
    t0 = time.time()
    missing = 0

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
            missing += 1
            continue
        buf.append(preprocess(im))
        if len(buf) >= 64:
            flush()
        if n and n % 2000 == 0:
            log("  " + label + " " + str(n) + "/" + str(len(files)) +
                "  (" + ("%.0f" % (n / (time.time() - t0))) + "/s)")
    flush()
    log("scored " + str(len(confs)) + " " + label + " in " +
        ("%.0f" % (time.time() - t0)) + "s (missing " + str(missing) + ")")
    return np.array(confs)


# --- POSITIVES: the 3,322 held-out bird photos ------------------------
vi = json.load(open(VAL_IDS))
ids = vi["ids"]
ext = vi["ext"]
pos_files = []
pos_missing = 0
for i in ids:
    k = str(i)
    e = ext.get(k)
    if e is None:
        pos_missing += 1
        continue
    p = os.path.join(HELDOUT, k + "." + e)
    if os.path.exists(p):
        pos_files.append(p)
    else:
        pos_missing += 1
log("positives resolved: " + str(len(pos_files)) + "/" + str(len(ids)) +
    " (missing " + str(pos_missing) + ")")

# --- NEGATIVES: hard-negatives/**/*.jp* -------------------------------
neg_files = []
for pat in ("*.jpg", "*.jpeg", "*.JPG", "*.JPEG"):
    neg_files += glob.glob(os.path.join(HARDNEG, "**", pat), recursive=True)
neg_files = sorted(set(neg_files))
log("hard-negative files: " + str(len(neg_files)))

birds = score_files(pos_files, "birds")
nonbirds = score_files(neg_files, "non-birds")

THRS = [0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.7, 0.9]

log("")
log("=== H3 abstention sweep: ONE scorer, softmax over " +
    str(clf.shape[0]) + " species, SAME denominator both arms ===")
log("positives: " + str(len(birds)) + " held-out birds   " +
    "negatives: " + str(len(nonbirds)) + " hard non-birds")
log("")
log("  %-10s %12s %16s" % ("threshold", "birds kept", "non-birds pass"))
for t in THRS:
    bk = float((birds >= t).mean()) * 100
    nb = float((nonbirds >= t).mean()) * 100
    log("  %-10.2f %11.1f%% %15.1f%%" % (t, bk, nb))
log("")

# --- MATCHED non-bird rejection: invert the negative curve ------------
# For a target non-bird REJECTION rate, find the threshold on the shared
# score that achieves it, then report birds kept at that same threshold.
# Because both arms share one scorer and one denominator, this is a true
# ROC point: 'to block R% of non-birds, you keep X% of birds'.
sn = np.sort(nonbirds)
log("=== birds kept at MATCHED non-bird rejection (shared threshold) ===")
log("  %-16s %12s %14s" % ("nonbird reject", "threshold", "birds kept"))
for R in [0.50, 0.75, 0.85, 0.90, 0.95, 0.99]:
    # threshold where (nonbirds >= t) == 1-R  => t = quantile at R
    t = float(np.quantile(nonbirds, R))
    nb_pass = float((nonbirds >= t).mean()) * 100
    bk = float((birds >= t).mean()) * 100
    log("  %-15.0f%% %12.4f %13.1f%%" % (R * 100, t, bk))
log("")
