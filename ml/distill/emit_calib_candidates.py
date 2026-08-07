#!/usr/bin/env python3
"""Emit raw top-K similarity candidates for the 11k calibration set.

Writes ONE parquet with, per image: the true taxon, lat/lon/month, and the
top-K (species_idx, cosine_sim) pairs. Deliberately stores RAW COSINE SIMS,
not softmax probabilities, because temperature is fitted downstream and we
must not bake in a temperature here.

This is the input to fit_calibration.py (temperature + range weights).
"""
import argparse
import json
import os
import sys
import time

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

TEACHER = "hf-hub:imageomics/bioclip-2"


def log(m):
    print("[" + time.strftime("%H:%M:%S") + "] " + str(m), flush=True)



# --- DCT scaled decode, opt-in via the CAP env var ---------------------
# libjpeg can decode at 1/1, 1/2, 1/4 or 1/8 scale straight from the DCT
# coefficients, so the full-size bitmap is never materialized. PIL exposes
# it as im.draft(). It only snaps to those fractions, so the result is the
# smallest power-of-two reduction that stays at or above the cap; the
# normal preprocess resize then finishes the job.
#
# CAP=500 answers the shipping-path question: is decoding straight to
# ~500px lossy next to a full decode followed by one resize?
_CAP = int(os.environ.get("CAP", "0"))


def _open_image(path):
    im = Image.open(path)
    if _CAP > 0:
        # draft() must run BEFORE load(), and no-ops for non-JPEG.
        im.draft("RGB", (_CAP, _CAP))
    return im.convert("RGB")

def load_student(checkpoint, distill_dir, device):
    sys.path.insert(0, distill_dir)
    from train_student import Student
    ckpt = torch.load(checkpoint, map_location="cpu")
    args = ckpt.get("args", {})
    st = Student(args.get("arch", "ViT-B-16"),
                 args.get("pretrained", "laion2b_s34b_b88k"))
    st.load_state_dict(ckpt["model"])
    return st.to(device).eval(), st.preprocess


def build_text(taxonomy, device, batch=512):
    import open_clip
    taxo = json.load(open(taxonomy))
    commons = [r[0] for r in taxo]
    scis = [r[1] for r in taxo]
    m, _, _ = open_clip.create_model_and_transforms(TEACHER)
    tok = open_clip.get_tokenizer(TEACHER)
    m = m.to(device).eval()
    feats = []
    with torch.no_grad():
        for i in range(0, len(commons), batch):
            j2 = min(i + batch, len(commons))
            b = ["a photo of " + commons[j] + ", " + scis[j] +
                 ", a species of bird." for j in range(i, j2)]
            e = m.encode_text(tok(b).to(device))
            e = e / e.norm(dim=-1, keepdim=True)
            feats.append(e.float().cpu())
    out = torch.cat(feats).to(device)
    log("text classifier " + str(tuple(out.shape)))
    del m
    torch.cuda.empty_cache()
    return out, taxo


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--taxonomy", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--distill-dir", default="/home/jlian/wingdex/ml/distill")
    ap.add_argument("--topk", type=int, default=25)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    import duckdb
    con = duckdb.connect()
    q = ("SELECT photo_id, extension, inat_taxon_id, app_idx, scientific, "
         "latitude, longitude, observed_on FROM read_parquet(" +
         chr(39) + args.manifest + chr(39) + ")")
    if args.limit:
        q += " LIMIT " + str(args.limit)
    rows = con.execute(q).fetchall()
    log(str(len(rows)) + " manifest rows")

    device = "cuda" if torch.cuda.is_available() else "cpu"
    tf, taxo = build_text(args.taxonomy, device)
    st, preprocess = load_student(args.checkpoint, args.distill_dir, device)

    out_rows = []
    buf, meta = [], []
    missing = 0

    def flush():
        if not buf:
            return
        x = torch.stack(buf).to(device)
        with torch.no_grad():
            e = st(x)
            e = F.normalize(e, dim=-1)
            sims = e @ tf.T
            top = sims.topk(args.topk, dim=-1)
        idx = top.indices.cpu().numpy()
        val = top.values.cpu().numpy()
        for k, m in enumerate(meta):
            out_rows.append({
                "photo_id": m[0], "true_app_idx": m[1],
                "latitude": m[2], "longitude": m[3], "month": m[4],
                "cand_idx": idx[k].astype(np.int32).tolist(),
                "cand_sim": val[k].astype(np.float32).tolist(),
            })
        buf.clear()
        meta.clear()

    t0 = time.time()
    for n, r in enumerate(rows):
        photo_id, ext, taxon_id, app_idx, sci, lat, lon, obs_on = r
        path = os.path.join(args.corpus, "corpus", str(taxon_id),
                            str(photo_id) + "." + ext)
        if not os.path.exists(path):
            missing += 1
            continue
        try:
            im = _open_image(path)
        except Exception:
            missing += 1
            continue
        month = 0
        if obs_on and len(str(obs_on)) >= 7:
            try:
                month = int(str(obs_on)[5:7])
            except Exception:
                month = 0
        buf.append(preprocess(im))
        meta.append((photo_id, app_idx, lat, lon, month))
        if len(buf) >= args.batch:
            flush()
        if n and n % 2000 == 0:
            el = time.time() - t0
            log(str(n) + "/" + str(len(rows)) + "  " +
                str(round(n / max(el, 1e-9), 1)) + " img/s")
    flush()

    log(str(len(out_rows)) + " scored, " + str(missing) + " missing/unreadable")
    import pandas as pd
    pd.DataFrame(out_rows).to_parquet(args.out, index=False)
    log("wrote " + args.out)
    print("=== EMIT CALIB DONE ===")


if __name__ == "__main__":
    main()
