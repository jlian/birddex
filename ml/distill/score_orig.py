"""Score the HIGH-RES rerun against the same reference numbers.

Reuses jobs/val_absolute.py logic exactly. Only two things differ:

1. The candidates parquet holds only the 3,322 val photos, not all 11,070, so
   there is no split step: every row IS the validation set.
2. counts/totals/status in the npz are ROW-ALIGNED to the original 11,070
   parquet, so they get reindexed by photo_id. Aligning by position would
   silently score each photo against another photo's occurrence prior.
"""
import json, os, sys
import numpy as np
import pandas as pd
import torch

CANDS_REF = "calib_cands_tiny39_a060.parquet"
CANDS_NEW = sys.argv[1] if len(sys.argv) > 1 else "calib_cands_tiny39_a060_ORIG.parquet"
LABEL = sys.argv[2] if len(sys.argv) > 2 else "ORIGINAL-SIZE"
COUNTS = os.environ.get("COUNTS", "calib_occ_counts_tiny39.npz")
STATUS = sys.argv[3] if len(sys.argv) > 3 else "calib_status_tiny39.jsonl"
FIT = "calibration_occ_tiny39.json"

STATUSES = ["present", "near-range", "no-data", "out-of-range"]
SIDX = {s: i for i, s in enumerate(STATUSES)}

ref = pd.read_parquet(CANDS_REF)
row_of = {int(p): i for i, p in enumerate(ref["photo_id"].values)}

df = pd.read_parquet(CANDS_NEW)
N = len(df)
sims = torch.tensor(np.stack(df["cand_sim"].values), dtype=torch.float32)
idxs = np.stack(df["cand_idx"].values)
true = df["true_app_idx"].values
pids = df["photo_id"].values
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

# Status is per (photo, candidate). The candidate ORDER can differ between the
# two runs, so rebuild it against THIS run's candidate list rather than reusing
# the reference ordering.
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
counts_all = torch.tensor(z["counts"], dtype=torch.float32)
totals_all = torch.tensor(z["totals"], dtype=torch.float32)

if counts_all.shape[0] == N:
    keep = list(range(N))
    src = list(range(N))
else:
    keep = [i for i in range(N) if int(pids[i]) in row_of]
    src = [row_of[int(pids[i])] for i in keep]
if len(keep) != N:
    print("WARNING: %d of %d rows had no reference row" % (N - len(keep), N))
counts = counts_all[src]
totals = totals_all[src]
sims = sims[keep]
target = target[keep]
status = status[keep]
N = len(keep)

fit = json.load(open(FIT))
T = float(fit["temperature"])
beta = float(fit["beta"])
alpha = float(fit["alpha"])
_w = fit["w"]
if isinstance(_w, dict):
    w = torch.tensor([float(_w[k]) for k in STATUSES], dtype=torch.float32)
else:
    w = torch.tensor([float(x) for x in _w], dtype=torch.float32)

pri = torch.exp(w[status])
num = counts + alpha * pri
den = totals.unsqueeze(1) + alpha * pri.sum(dim=1, keepdim=True)
logp = torch.log(num.clamp(min=1e-12)) - torch.log(den.clamp(min=1e-12))

ceiling = (target >= 0).float().mean().item()
vision = (sims.argmax(dim=1) == target).float().mean().item()
score = sims / T + beta * logp
occ = (score.argmax(dim=1) == target).float().mean().item()

print("")
print("=== %s: val split, ABSOLUTE ===" % LABEL)
print("")
print("photos scored:            %d" % N)
print("recall ceiling:           %.2f" % (100 * ceiling))
print("")
print("strategy                           ABS top-1")
print("raw argmax, vision only               %.2f" % (100 * vision))
print("I: log-sum + iNat occurrence          %.2f" % (100 * occ))
print("")
print("REFERENCE (500px medium, same split):")
print("  ceiling 97.14   vision 81.10   occurrence 93.80   +month 95.00")
