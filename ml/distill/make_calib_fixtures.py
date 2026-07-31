#!/usr/bin/env python3
"""Convert the 11k calibration parquet into pipeline-harness fixtures.

WHY THIS MATTERS: the 88.29 / 90.04 numbers came from fit_occurrence.py and
ablate_priors.py, which are PYTHON reimplementations of the log-sum. The
harness stratOccurrence is a SEPARATE JS implementation reading the actual
shipped blob. They have only ever been compared on the 27-image golden set
(n=23). Running the real JS pipeline over 11k photos is what would catch a
divergence between the reference math and the shipping code.

Emits one JSON per photo in the shape the harness expects:
  { imageFile, context: {lat, lon, month}, parsed: { candidates: [...] } }
plus a truth.json mapping basename -> correct common name.

Candidate confidence is softmax(sim/0.01) to match the fixture convention the
harness already assumes (it recovers sim as 0.01*log(p)).
"""
import argparse
import json
import math
import os

import numpy as np


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidates", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--taxonomy", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--truth", required=True)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    import pandas as pd
    df = pd.read_parquet(args.candidates)
    man = pd.read_parquet(args.manifest)[["photo_id", "observed_on"]]
    df = df.merge(man, on="photo_id", how="left")
    if args.limit:
        df = df.head(args.limit)
    taxo = json.load(open(args.taxonomy))
    print("photos:", len(df), " taxonomy:", len(taxo))

    os.makedirs(args.out, exist_ok=True)
    truth = {}
    n = 0
    for r in df.itertuples(index=False):
        sims = np.asarray(r.cand_sim, dtype=np.float64)
        idxs = np.asarray(r.cand_idx, dtype=np.int64)
        z = sims / 0.01
        z = z - z.max()
        p = np.exp(z)
        p = p / p.sum()
        cands = []
        for k in range(len(idxs)):
            row = taxo[int(idxs[k])]
            cands.append({"commonName": row[0], "scientificName": row[1],
                          "confidence": round(float(p[k]), 6),
                          "plumage": None})
        month = 0
        if isinstance(r.observed_on, str) and len(r.observed_on) >= 7:
            try:
                month = int(r.observed_on[5:7])
            except Exception:
                month = 0
        base = "p" + str(int(r.photo_id))
        ctx = {}
        if r.latitude is not None and not pd.isna(r.latitude):
            ctx = {"lat": float(r.latitude), "lon": float(r.longitude),
                   "month": month}
        fx = {"imageFile": base + ".jpg", "context": ctx,
              "parsed": {"candidates": cands, "birdCenter": None,
                         "birdSize": None, "multipleBirds": False}}
        json.dump(fx, open(os.path.join(args.out, base + ".json"), "w"))
        truth[base] = taxo[int(r.true_app_idx)][0]
        n += 1
        if n % 2000 == 0:
            print(" ", n, "written", flush=True)

    json.dump(truth, open(args.truth, "w"), indent=0)
    print("wrote", n, "fixtures ->", args.out)
    print("wrote truth ->", args.truth)
    print("=== FIXTURE EXPORT DONE ===")


if __name__ == "__main__":
    main()
