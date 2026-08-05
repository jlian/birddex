"""ABSOLUTE top-1 on the val split only, comparable with the 88.29 ViT-B number.

Two corrections this makes over what we have quoted so far:

1. SPLIT. The 88.29 figure is the 30% validation split (seed 0, val-frac 0.3)
   of the same 11,070 photos, not a separate dataset. The JS harness scored all
   11,070, which includes the 70% the calibration was FITTED on, so that number
   is optimistically biased.

2. ABSOLUTE, not conditional. fit_occurrence.py masks to photos whose true
   species is inside the 25 candidates (`v = tg >= 0`). Absolute counts every
   photo, so a miss by the candidate generator counts as wrong.
"""
import json

import numpy as np
import pandas as pd
import torch

import sys

ARMS = {
    "tiny39": ("calib_cands_tiny39_a060.parquet", "calib_occ_counts_tiny39.npz",
               "calib_status_tiny39.jsonl", "calibration_occ_tiny39.json",
               "TinyCLIP-39M @a0.60"),
    "vitb": ("calib_cands_01_a090.parquet", "calib_occ_counts_vitb.npz",
             "calib_status_vitb.jsonl", "calibration_occ_01.json",
             "WingCLIP-0.1 ViT-B @a0.90"),
}
ARM = sys.argv[1] if len(sys.argv) > 1 else "tiny39"
CANDS, COUNTS, STATUS, FIT, LABEL = ARMS[ARM]

STATUSES = ["present", "near-range", "no-data", "out-of-range"]
SIDX = {s: i for i, s in enumerate(STATUSES)}

df = pd.read_parquet(CANDS)
N = len(df)
sims = torch.tensor(np.stack(df["cand_sim"].values), dtype=torch.float32)
idxs = np.stack(df["cand_idx"].values)
true = df["true_app_idx"].values
K = idxs.shape[1]

pos = np.full(N, -1, dtype=np.int64)
for i in range(N):
    hit = np.where(idxs[i] == true[i])[0]
    if len(hit):
        pos[i] = hit[0]
target = torch.tensor(pos)

st_by = {}
for line in open(STATUS):
    if line.strip():
        r = json.loads(line)
        st_by[int(r["photo_id"])] = r["status"]
pids = df["photo_id"].values
stat = np.zeros((N, K), dtype=np.int64)
for i in range(N):
    ss = st_by.get(int(pids[i]))
    if ss is None:
        stat[i, :] = SIDX["no-data"]
    else:
        for j in range(K):
            stat[i, j] = SIDX.get(ss[j] if j < len(ss) else "no-data", SIDX["no-data"])
status = torch.tensor(stat)

z = np.load(COUNTS)
counts = torch.tensor(z["counts"], dtype=torch.float32)
totals = torch.tensor(z["totals"], dtype=torch.float32)

fit = json.load(open(FIT))
T = float(fit["temperature"])
beta = float(fit["beta"])
alpha = float(fit["alpha"])
_w = fit["w"]
if isinstance(_w, dict):
    w = torch.tensor([float(_w[k]) for k in STATUSES], dtype=torch.float32)
else:
    w = torch.tensor([float(x) for x in _w], dtype=torch.float32)

# Same split as fit_occurrence.py: seed 0, val-frac 0.3.
# fit_occurrence.py uses perm[ncut:] for validation, i.e. the LAST 30%.
# Taking perm[:nval] scores the TRAINING portion, which is what the
# calibration was fitted on. Match the source exactly.
g = torch.Generator().manual_seed(0)
perm = torch.randperm(N, generator=g)
ncut = int(N * (1 - 0.3))
tr, va = perm[:ncut], perm[ncut:]

pri = torch.exp(w[status])
num = counts + alpha * pri
den = totals.unsqueeze(1) + alpha * pri.sum(dim=1, keepdim=True)
logp = torch.log(num.clamp(min=1e-12)) - torch.log(den.clamp(min=1e-12))
score = sims / T + beta * logp

sel = va
lg = score[sel]
tg = target[sel]
order = lg.argsort(dim=-1, descending=True)

in_cands = (tg >= 0)
ceiling = float(in_cands.float().mean())
abs_t1 = float(((order[:, 0] == tg) & in_cands).float().mean())
abs_t5 = float(((order[:, :5] == tg.unsqueeze(1)).any(dim=1) & in_cands).float().mean())
cond_t1 = float((order[:, 0] == tg)[in_cands].float().mean())

# Vision only, for the same row the old table reports.
vo = sims[sel].argsort(dim=-1, descending=True)
vo_t1 = float(((vo[:, 0] == tg) & in_cands).float().mean())

print("")
print("=== %s: val split, ABSOLUTE ===" % LABEL)
print("")
print("photos in val split:      %d" % len(sel))
print("recall ceiling:           %.2f" % (100 * ceiling))
print("")
print("%-34s %8s" % ("strategy", "ABS top-1"))
print("%-34s %8.2f" % ("raw argmax, vision only", 100 * vo_t1))
print("%-34s %8.2f" % ("I: log-sum + iNat occurrence", 100 * abs_t1))
print("")
print("ABS top-5:                %.2f" % (100 * abs_t5))
print("conditional top-1:        %.2f   (what fit_occurrence prints)" % (100 * cond_t1))
print("")
print("Headroom used: %.1f%% of the ceiling" % (100 * abs_t1 / ceiling))
