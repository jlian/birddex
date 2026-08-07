#!/usr/bin/env python3
"""T1: is the fine-tune's NABirds gain RECOGNITION or COVERAGE?

The ground-truth fine-tune trained on 5,908 classes, but only 3,850 of those were
ever distilled. The other 2,058 came in through a sampler bug (they failed the
corpus's >=50-photo floor; median 24 photos worldwide). So part of the +7.6pt
NABirds gain (81.83 -> 89.45) may be ADDED COVERAGE rather than better
recognition of species we already had.

This splits the NABirds test set by whether each species was in
train_manifest.parquet (i.e. actually distilled) and reports the delta for each
group, for both the distilled base and the fine-tuned/blended model.

If the gain is concentrated in the never-distilled group, the honest framing is
"the fine-tune expanded coverage". If it is uniform (or concentrated in the
distilled group), the fine-tune genuinely learned to recognise birds better and
"beat the teacher" stands as stated.
"""
import argparse
import json
import os
import time

import duckdb
import numpy as np
import open_clip
import torch
import torch.nn.functional as F
from PIL import Image
from torch.utils.data import DataLoader, Dataset

from train_student import Student

TEACHER = "hf-hub:imageomics/bioclip-2"


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


class NB(Dataset):
    def __init__(self, items, pp):
        self.items, self.pp = items, pp

    def __len__(self):
        return len(self.items)

    def __getitem__(self, i):
        path, lab = self.items[i]
        try:
            return self.pp(Image.open(path).convert("RGB")), lab
        except Exception:
            return None


def collate(b):
    b = [x for x in b if x is not None]
    if not b:
        return None, None
    xs, ys = zip(*b)
    return torch.stack(xs), torch.tensor(ys)


def build_text(taxo, dev, batch=512):
    commons = [r[0] for r in taxo]
    scis = [r[1] for r in taxo]
    m, _, _ = open_clip.create_model_and_transforms(TEACHER)
    m = m.to(dev).eval()
    tok = open_clip.get_tokenizer(TEACHER)
    feats = []
    with torch.no_grad():
        for i in range(0, len(commons), batch):
            b = [f"a photo of {commons[j]}, {scis[j]}, a species of bird."
                 for j in range(i, min(i + batch, len(commons)))]
            tf = m.encode_text(tok(b).to(dev))
            feats.append(F.normalize(tf, dim=-1).float().cpu())
    del m
    torch.cuda.empty_cache()
    return torch.cat(feats).to(dev)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoints", nargs="+", required=True,
                    help="label=path pairs, e.g. base=runs/x/best.pt ft=runs/y/w.pt")
    ap.add_argument("--nabirds", default="nabirds")
    ap.add_argument("--nb-map", default="nabirds_to_taxo.json")
    ap.add_argument("--taxonomy", default="taxonomy.json")
    ap.add_argument("--train-manifest", default="train_manifest.parquet")
    ap.add_argument("--target-taxa", default="target_taxa.csv")
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--out", default="t1_coverage_split.json")
    a = ap.parse_args()

    dev = "cuda"
    taxo = json.load(open(a.taxonomy))
    nb_to_taxo = json.load(open(a.nb_map))

    # which taxonomy indices correspond to species the distillation actually saw
    con = duckdb.connect()
    distilled_taxa = {r[0] for r in con.execute(
        f"SELECT DISTINCT inat_taxon_id FROM read_parquet('{a.train_manifest}')").fetchall()}
    idx_to_taxon = {}
    for tid, idx in con.execute(
        f"SELECT TRY_CAST(inat_taxon_id AS BIGINT), TRY_CAST(app_idx AS BIGINT) "
        f"FROM read_csv('{a.target_taxa}', header=true, all_varchar=true)").fetchall():
        if tid is not None and idx is not None:
            idx_to_taxon[int(idx)] = int(tid)
    log(f"{len(distilled_taxa):,} distilled species; "
        f"{len(idx_to_taxon):,} app_idx->taxon entries")

    # NABirds test items -> taxonomy index
    img_dir = os.path.join(a.nabirds, "images")
    labels = {}
    with open(os.path.join(a.nabirds, "image_class_labels.txt")) as f:
        for line in f:
            iid, cls = line.split()
            labels[iid] = cls
    paths = {}
    with open(os.path.join(a.nabirds, "images.txt")) as f:
        for line in f:
            iid, rel = line.split()
            paths[iid] = os.path.join(img_dir, rel)
    is_test = {}
    with open(os.path.join(a.nabirds, "train_test_split.txt")) as f:
        for line in f:
            iid, tr = line.split()
            is_test[iid] = (tr == "0")

    items, groups = [], []
    for iid, cls in labels.items():
        if not is_test.get(iid):
            continue
        ti = nb_to_taxo.get(cls)
        if ti is None:
            continue
        p = paths.get(iid)
        if not p or not os.path.exists(p):
            continue
        items.append((p, int(ti)))
        groups.append(idx_to_taxon.get(int(ti)) in distilled_taxa)
    groups = np.array(groups)
    log(f"NABirds test: {len(items):,} imgs | distilled-species {groups.sum():,} "
        f"| never-distilled {(~groups).sum():,}")

    text_feats = build_text(taxo, dev)
    log(f"text classifier {tuple(text_feats.shape)}")

    results = {}
    for spec in a.checkpoints:
        label, path = spec.split("=", 1)
        ck = torch.load(path, map_location="cpu")
        sd_args = ck.get("args", {}) or {}
        st = Student(sd_args.get("arch", "ViT-B-16"),
                     sd_args.get("pretrained", "laion2b_s34b_b88k")).to(dev)
        st.load_state_dict(ck["model"])
        st.eval()
        dl = DataLoader(NB(items, st.preprocess), batch_size=a.batch, shuffle=False,
                        num_workers=8, collate_fn=collate, pin_memory=True)
        correct, seen = [], 0
        with torch.no_grad():
            for xs, ys in dl:
                if xs is None:
                    continue
                with torch.cuda.amp.autocast():
                    e = st(xs.to(dev))
                    pred = (e @ text_feats.T).argmax(-1).cpu()
                correct.append((pred == ys).numpy())
                seen += len(ys)
        c = np.concatenate(correct)
        g = groups[:len(c)]
        results[label] = {
            "overall": float(100 * c.mean()),
            "distilled_species": float(100 * c[g].mean()) if g.any() else None,
            "never_distilled": float(100 * c[~g].mean()) if (~g).any() else None,
            "n_overall": int(len(c)),
            "n_distilled": int(g.sum()),
            "n_never": int((~g).sum()),
        }
        def _f(v):
            return "n/a" if v is None else f"{v:.2f}"
        log(f"{label}: overall {_f(results[label]['overall'])}  "
            f"distilled {_f(results[label]['distilled_species'])}  "
            f"never-distilled {_f(results[label]['never_distilled'])}")
        del st
        torch.cuda.empty_cache()

    labels_ = list(results)
    if len(labels_) >= 2:
        b, f_ = results[labels_[0]], results[labels_[-1]]
        log("")
        log(f"DELTA ({labels_[-1]} - {labels_[0]}):")
        def _d(k):
            if b.get(k) is None or f_.get(k) is None:
                return "n/a (no test images in this group)"
            return f"{f_[k] - b[k]:+.2f} pts"
        log(f"  overall          {_d('overall')}")
        log(f"  distilled sp.    {_d('distilled_species')}")
        log(f"  never-distilled  {_d('never_distilled')}")
        log("")
        log("If the two group deltas are similar -> the gain is RECOGNITION (real).")
        log("If it is concentrated in never-distilled -> the gain is COVERAGE.")

    json.dump(results, open(a.out, "w"), indent=2)
    log(f"wrote {a.out}")


if __name__ == "__main__":
    main()
