"""Write the CORRECT seed-0 validation photo id list.

The earlier version applied torch.randperm to the row ordering of
calib_untouched.parquet. jobs/val_absolute.py applies it to the ordering of
calib_cands_tiny39_a060.parquet, which is different, so only 1,024 of 3,322
ids matched. Everything downstream then compared two different photo sets.

Derive the ids from the SAME parquet the scorer uses.
"""
import json, os
import numpy as np
import pandas as pd
import torch

D = "/home/jlian/wingdex/ml/distill"
ML = "/home/jlian/wingdex/ml"

a = pd.read_parquet(os.path.join(D, "calib_cands_tiny39_a060.parquet"))
N = len(a)
g = torch.Generator().manual_seed(0)
perm = torch.randperm(N, generator=g)
ncut = int(N * 0.7)
va = perm[ncut:].numpy()

pids = [int(x) for x in a["photo_id"].values[va]]
print("val split: %d photos" % len(pids))

man = pd.read_parquet(os.path.join(D, "calib_untouched.parquet"))
ext_of = {int(r.photo_id): r.extension for r in man.itertuples()}

out = {"count": len(pids), "ids": pids,
       "ext": {str(p): ext_of.get(p, "jpg") for p in pids}}
dst = os.path.join(ML, "val_ids_seed0.json")
json.dump(out, open(dst, "w"))
print("wrote %s" % dst)

have = set()
src = os.path.join(ML, "heldout-orig")
for f in os.listdir(src):
    s = f.rsplit(".", 1)[0]
    try:
        have.add(int(s))
    except ValueError:
        pass
need = [p for p in pids if p not in have]
print("already downloaded: %d" % (len(pids) - len(need)))
print("still to fetch:     %d" % len(need))
