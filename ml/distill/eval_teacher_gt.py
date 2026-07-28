"""Score the TEACHER (BioCLIP-2 ViT-L) on the same ground-truth val split.

The student's 54.47% is uninterpretable on its own: this is 5,908 fine-grained
species on raw iNat photos, not NABirds' curated 500. The only meaningful
reference is the teacher on the IDENTICAL split with the IDENTICAL classifier.

Reuses the exact val split (seed 42, val_frac 0.1) and the exact prompt template
from eval_nabirds.py, so the number is directly comparable to the student's.
"""
import json
import os
import sys
import time

import duckdb
import numpy as np
import open_clip
import torch
import torch.nn.functional as F
from PIL import Image
from torch.utils.data import DataLoader, Dataset

sys.path.insert(0, "/home/jlian/wingdex/ml/distill")
TEACHER = "hf-hub:imageomics/bioclip-2"
D = "/home/jlian/wingdex/ml/distill"
CORPUS = "/home/jlian/wingdex/ml/groundtruth/corpus"


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


class DS(Dataset):
    def __init__(self, rows, pp, cls):
        self.rows, self.pp, self.cls = rows, pp, cls

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        pid, tid, ext = self.rows[i]
        try:
            x = self.pp(Image.open(os.path.join(CORPUS, str(tid), f"{pid}.{ext}")).convert("RGB"))
        except Exception:
            return None
        return x, self.cls[tid]


def collate(b):
    b = [x for x in b if x is not None]
    if not b:
        return None, None
    xs, ys = zip(*b)
    return torch.stack(xs), torch.tensor(ys)


dev = "cuda"
taxo_raw = json.load(open(f"{D}/taxonomy.json"))
bridge = duckdb.connect().execute(
    f"SELECT DISTINCT TRY_CAST(inat_taxon_id AS BIGINT), TRY_CAST(app_idx AS BIGINT) "
    f"FROM read_csv('{D}/target_taxa.csv', header=true, all_varchar=true)").fetchall()
by_taxon = {int(t): taxo_raw[int(i)] for t, i in bridge
            if t is not None and i is not None and 0 <= int(i) < len(taxo_raw)}

rows = duckdb.connect().execute(
    f"SELECT photo_id, inat_taxon_id, extension FROM read_parquet('{D}/groundtruth_heldout.parquet')"
).fetchall()
rows = [(int(p), int(t), (e or "jpg")) for p, t, e in rows if int(t) in by_taxon]
present = sorted({r[1] for r in rows})
cls = {t: i for i, t in enumerate(present)}
sub_taxo = [by_taxon[t] for t in present]
log(f"{len(rows):,} photos / {len(present):,} species")

# IDENTICAL split to the fine-tune (seed 42, val_frac 0.1)
g = torch.Generator().manual_seed(42)
perm = torch.randperm(len(rows), generator=g).tolist()
n_val = max(1, int(len(rows) * 0.1))
val_rows = [rows[i] for i in perm[:n_val]]
log(f"val: {len(val_rows):,} (same split as the fine-tune)")

model, _, pp = open_clip.create_model_and_transforms(TEACHER)
model = model.to(dev).eval()
tok = open_clip.get_tokenizer(TEACHER)

commons = [r[0] for r in sub_taxo]
scis = [r[1] for r in sub_taxo]
feats = []
with torch.no_grad():
    for i in range(0, len(commons), 512):
        b = [f"a photo of {commons[j]}, {scis[j]}, a species of bird."
             for j in range(i, min(i + 512, len(commons)))]
        tf = model.encode_text(tok(b).to(dev))
        feats.append(F.normalize(tf, dim=-1).float().cpu())
text_feats = torch.cat(feats).to(dev)
log(f"text classifier {tuple(text_feats.shape)}")

dl = DataLoader(DS(val_rows, pp, cls), batch_size=64, shuffle=False,
                num_workers=8, collate_fn=collate, pin_memory=True)
ok1 = ok5 = tot = 0
with torch.no_grad():
    for xs, ys in dl:
        if xs is None:
            continue
        with torch.cuda.amp.autocast():
            e = F.normalize(model.encode_image(xs.to(dev)), dim=-1).float()
            sims = e @ text_feats.T
        top5 = sims.topk(5, dim=-1).indices.cpu()
        ys = ys.view(-1, 1)
        ok1 += (top5[:, :1] == ys).any(1).sum().item()
        ok5 += (top5 == ys).any(1).sum().item()
        tot += len(ys)
        if tot % 3200 == 0:
            log(f"  {tot:,}/{len(val_rows):,} top1={100*ok1/tot:.2f}%")

print()
log(f"TEACHER on ground-truth val: top1={100*ok1/tot:.2f}%  top5={100*ok5/tot:.2f}%  (n={tot:,})")
log(f"STUDENT (distilled, pre-finetune) was: top1=54.47%")
log(f"=> retention = {100*54.47/(100*ok1/tot):.1f}%")
