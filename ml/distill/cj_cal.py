#!/usr/bin/env python3
"""Crop-jitter spread for the CALIBRATION-OBJECTIVE refit arm (F).

Arms: plain (no null), cosine null, C (Platt on arm-C params), F (this refit).
Parameters for F are read from refit_cal.json best_fit so nothing is
re-derived by hand.

SUPERSEDED RESULTS. Every number previously produced by this file was
measured with runs/ft_tiny39_fresh/wise_a0.90.pt, which is WingCLIP-0.1's
best alpha and NOT the model that ships. The default is now the pinned
shipped checkpoint (shipped_model.SHIPPED_CHECKPOINT, alpha 0.60). Treat
any earlier output of this script as describing a different model.
"""
import argparse
import io
import json
import math
import os
import tarfile

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

import emit_calib_candidates as E
from ee_port import lonlat_to_ee, xy_to_cell
from occ4 import Occ
from cj_refit import jitter_crops, lp_vec, top1
import shipped_model as SM  # noqa: E402  the pinned shipped checkpoint

EPS = 1e-7


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint",
                    default=SM.SHIPPED_CHECKPOINT,
                    help="pinned shipped checkpoint; see shipped_model.py")
    ap.add_argument("--taxonomy",
                    default="/home/jlian/wingdex/src/lib/taxonomy.json")
    ap.add_argument("--shards",
                    default="/mnt/nas/WingDex-Distill/datasets/calib-11k-500px")
    ap.add_argument("--occ",
                    default="/home/jlian/v4build/occ_v4.4f5c1a15.bin.gz")
    ap.add_argument("--params", default="/home/jlian/refit_cal.json")
    ap.add_argument("--cos", type=float, default=0.54)
    ap.add_argument("--images", type=int, default=200)
    ap.add_argument("--crops", type=int, default=8)
    ap.add_argument("--topk", type=int, default=25)
    ap.add_argument("--out", default="/home/jlian/cropjitter_cal.json")
    args = ap.parse_args()
    K = args.topk

    P = json.load(open(args.params))
    C = P["armC"]
    aC, bC, TC, BC, kC = C["a"], C["b"], C["T"], C["beta"], C["k"]
    FLC = math.log(C["floor"])
    R = P["best_fit"]
    aF, bF, TF, BF_, kF = R["a"], R["b"], R["T"], R["beta"], R["k"]
    FLF = math.log(R["floor"])
    print("arm C  T=" + ("%.6f" % TC) + " beta=" + ("%.4f" % BC) + " k=" +
          str(kC) + " floor=" + ("%.0e" % C["floor"]) + " a=" +
          ("%.4f" % aC) + " b=" + ("%.4f" % bC), flush=True)
    print("arm F  T=" + ("%.6f" % TF) + " beta=" + ("%.4f" % BF_) + " k=" +
          str(kF) + " floor=" + ("%.0e" % R["floor"]) + " a=" +
          ("%.4f" % aF) + " b=" + ("%.4f" % bF), flush=True)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    tf, _ = E.build_text(args.taxonomy, device)
    st, preprocess = E.load_student(args.checkpoint,
                                    "/home/jlian/wingdex/ml/distill", device)
    occ = Occ(args.occ)
    pr = np.load("/home/jlian/refit_probe.npz")
    coef, inter = pr["coef"][0], pr["intercept"][0]

    def pbird(emb):
        return 1.0 / (1.0 + np.exp(-(emb @ coef + inter)))

    def platt(p, a, b):
        pc = np.clip(p, EPS, 1 - EPS)
        return 1.0 / (1.0 + np.exp(-(a * np.log(pc / (1 - pc)) + b)))

    shards = sorted(f for f in os.listdir(args.shards) if f.endswith(".tar"))
    per_image = []
    skipped = 0
    for sh in shards:
        if len(per_image) >= args.images:
            break
        with tarfile.open(os.path.join(args.shards, sh)) as tar:
            meta = {}
            pending = {}
            for m in tar:
                stem = os.path.basename(m.name).rsplit(".", 1)[0]
                if m.name.endswith(".json"):
                    try:
                        meta[stem] = json.loads(tar.extractfile(m).read())
                    except Exception:
                        pass
                    continue
                if not (m.name.endswith(".jpg") or m.name.endswith(".jpeg")):
                    continue
                f = tar.extractfile(m)
                if f is None:
                    continue
                try:
                    pending[stem] = Image.open(
                        io.BytesIO(f.read())).convert("RGB")
                except Exception:
                    continue
            for stem, img in pending.items():
                if len(per_image) >= args.images:
                    break
                md = meta.get(stem)
                if not md:
                    skipped += 1
                    continue
                lat, lon = md.get("latitude"), md.get("longitude")
                obs = md.get("observed_on") or ""
                try:
                    month = int(str(obs)[5:7])
                except Exception:
                    month = 0
                if lat is None or lon is None or not (1 <= month <= 12):
                    skipped += 1
                    continue
                try:
                    rc = xy_to_cell(*lonlat_to_ee(float(lon), float(lat)))
                except Exception:
                    rc = None
                if rc is None:
                    skipped += 1
                    continue
                pri = occ.cell_priors(rc[0], rc[1], month)
                if not pri:
                    skipped += 1
                    continue
                pooled = occ.cell_pooled(rc[0], rc[1]) if occ.version >= 4 else None
                ncm = occ.total(rc[0], rc[1], month) if occ.version >= 4 else None
                ent = (pri, pooled, ncm)

                crops = jitter_crops(img, args.crops, seed=len(per_image))
                x = torch.stack([preprocess(c) for c in crops]).to(device)
                with torch.no_grad():
                    e = F.normalize(st(x), dim=-1)
                    s_all = (e @ tf.T).cpu().numpy().astype(np.float64)
                emb = e.cpu().numpy().astype(np.float64)
                pb = pbird(emb)
                pcC = platt(pb, aC, bC)
                pcF = platt(pb, aF, bF)

                nc = len(crops)
                c_plain = np.zeros(nc)
                c_null = np.zeros(nc)
                c_plainF = np.zeros(nc)
                for ci in range(nc):
                    c_plain[ci], c_null[ci] = top1(
                        s_all[ci], ent, TC, BC, kC, FLC, K, args.cos)
                    c_plainF[ci], _ = top1(
                        s_all[ci], ent, TF, BF_, kF, FLF, K, args.cos)
                per_image.append({
                    "maxsim": float(s_all.max(axis=1).mean()),
                    "plain_spread": float(c_plain.max() - c_plain.min()),
                    "null_spread": float(c_null.max() - c_null.min()),
                    "C_spread": float((pcC * c_plain).max() -
                                      (pcC * c_plain).min()),
                    "F_spread": float((pcF * c_plainF).max() -
                                      (pcF * c_plainF).min()),
                    "plain_conf": float(c_plain.mean()),
                    "null_conf": float(c_null.mean()),
                    "C_conf": float((pcC * c_plain).mean()),
                    "F_conf": float((pcF * c_plainF).mean()),
                })
                if len(per_image) % 50 == 0:
                    print("  " + str(len(per_image)) + " images", flush=True)

    NAMES = ["plain_spread", "null_spread", "C_spread", "F_spread", "maxsim"]
    arrs = {nm: np.array([r[nm] for r in per_image]) for nm in NAMES}
    print("")
    print("  " + str(len(per_image)) + " images x " + str(args.crops) +
          " crops   skipped " + str(skipped))
    print("")
    print("  TOP-1 DISPLAYED CONFIDENCE SPREAD ACROSS 8 CROPS (lower better)")
    print("           plain    cos-null   C:Platt    F:cal-refit")
    for nm, q in [("p50", 50), ("p90", 90), ("max", 100)]:
        row = "    " + nm.ljust(7)
        for key in NAMES[:-1]:
            row += ("%.1f%%" % (100 * np.percentile(arrs[key], q))).rjust(11)
        print(row)
    print("")
    print("  mean displayed conf   plain " +
          ("%.1f%%" % (100 * np.mean([r["plain_conf"] for r in per_image]))) +
          "   null " +
          ("%.1f%%" % (100 * np.mean([r["null_conf"] for r in per_image]))) +
          "   C " +
          ("%.1f%%" % (100 * np.mean([r["C_conf"] for r in per_image]))) +
          "   F " +
          ("%.1f%%" % (100 * np.mean([r["F_conf"] for r in per_image]))))
    cutv = np.percentile(arrs["maxsim"], 33.3)
    w = arrs["maxsim"] <= cutv
    print("")
    print("  WEAKEST THIRD BY MAX SIM  (n=" + str(int(w.sum())) + ")")
    for lbl, q in [("median", 50), ("p90", 90)]:
        row = "    " + lbl.ljust(9)
        for key in NAMES[:-1]:
            row += ("%.1f%%" % (100 * np.percentile(arrs[key][w], q))).rjust(11)
        print(row)
    json.dump(per_image, open(args.out, "w"))
    print("")
    print("  wrote " + args.out)
    print("=== CROPJIT CAL DONE ===")


if __name__ == "__main__":
    main()
