#!/usr/bin/env python3
"""Answer the three open gate questions with measurements.

Q2 Are the two gates redundant? Runs the full pipeline on 400 labelled held-out
   birds plus 393 Imagenette non-birds and cross-tabulates the pre-rerank vision
   gate against the post-rerank confidence gate.

Q3 What should the displayed number be? Fits a display temperature so the shown
   value approximates P(top-1 correct), instead of reusing the ranking T that
   was never meant to be a probability.

Q4 Per-class non-bird pass rates at every threshold, dogs called out.
"""
import glob
import json
import os
from collections import defaultdict

import numpy as np
import torch
from huggingface_hub import hf_hub_download

from abstention_audit import WingCLIP, preprocess, T_FITTED

REPO = "johnlian/WingCLIP-0.3"
BETA = 0.5435083508491516
GRID_ORIGIN_X, GRID_ORIGIN_Y, GRID_CELL, GRID_COLS, GRID_ROWS = (
    -17226000, 8343000, 27000, 1276, 618)
OCC_FLOOR = np.log(1e-9)


def equal_earth(lon, lat):
    A1, A2, A3, A4 = 1.340264, -0.081106, 0.000893, 0.003796
    a, f = 6378137.0, 1 / 298.257223563
    b = a * (1 - f)
    e2 = 1 - (b * b) / (a * a)
    e = np.sqrt(e2)
    R = a * np.sqrt(0.5 * (1 + ((1 - e2) / (2 * e)) * np.log((1 + e) / (1 - e))))
    qp = 1 + ((1 - e2) / (2 * e)) * np.log((1 + e) / (1 - e))
    lam, phi = np.radians(lon), np.radians(lat)
    sp = np.sin(phi)
    q = (1 - e2) * (sp / (1 - e2 * sp * sp) - (1 / (2 * e)) * np.log((1 - e * sp) / (1 + e * sp)))
    beta = np.arcsin(q / qp)
    t = np.arcsin((np.sqrt(3) / 2) * np.sin(beta))
    t2 = t * t
    t6 = t2 * t2 * t2
    denom = 3 * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2))
    return (R * ((2 * np.sqrt(3) * lam * np.cos(t)) / denom),
            R * t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2)))


def load_prior():
    import gzip
    p = sorted(glob.glob("../../public/priors/occurrence.*.bin.gz"))[0]
    raw = np.frombuffer(gzip.decompress(open(p, "rb").read()), dtype=np.uint8)
    version, = raw[4:5]
    hash_len = 8 if version >= 2 else 0
    n_cells = int(np.frombuffer(raw[8 + hash_len:12 + hash_len], dtype="<u4")[0])
    idx_start = 12 + hash_len
    payload = idx_start + (n_cells + 1) * 8
    index = np.frombuffer(raw[idx_start:idx_start + (n_cells + 1) * 8], dtype="<u4")
    return raw, index.reshape(-1, 2), payload, int(version)


def cell_priors(raw, index, payload, version, lat, lon, month):
    x, y = equal_earth(lon, lat)
    col = int(np.floor((x - GRID_ORIGIN_X) / GRID_CELL))
    row = int(np.floor((GRID_ORIGIN_Y - y) / GRID_CELL))
    if not (0 <= row < GRID_ROWS and 0 <= col < GRID_COLS):
        return None
    if version >= 3:
        if month is None or not 1 <= month <= 12:
            return None
        want = ((row * GRID_COLS + col) << 4) | (month - 1)
    else:
        want = row * GRID_COLS + col
    keys = index[:-1, 0]
    i = np.searchsorted(keys, want)
    if i >= len(keys) or keys[i] != want:
        return None
    start, end = int(index[i, 1]), int(index[i + 1, 1])
    out = {}
    p = payload + start
    stop = payload + end
    cur = 0
    while p < stop:
        shift = v = 0
        while True:
            b = int(raw[p]); p += 1
            v |= (b & 0x7F) << shift
            shift += 7
            if not (b & 0x80):
                break
        cur += v
        out[cur] = -int(raw[p]) / 2.5
        p += 1
    return out


def main():
    model = WingCLIP().eval()
    ckpt = torch.load(hf_hub_download(REPO, "wingclip-0.3.pt"), map_location="cpu",
                      weights_only=False)
    model.load_state_dict(ckpt["model"])
    classifier = np.load(hf_hub_download(REPO, "text_classifier_fp32.npy"))
    labels = json.load(open(hf_hub_download(REPO, "labels.json")))
    truth = json.load(open("../truth-tiny39.json"))
    raw, index, payload, version = load_prior()

    rows = []
    for path in sorted(glob.glob("../heldout-orig/*")):
        pid = "p" + os.path.basename(path).split(".")[0]
        if pid not in truth:
            continue
        ctx = {}
        fx = "../fixtures-tiny39-a060/%s.json" % pid
        if os.path.exists(fx):
            ctx = json.load(open(fx)).get("context", {})
        with torch.no_grad():
            emb = model(torch.from_numpy(preprocess(path))).numpy()[0]
        sims = emb @ classifier.T
        order = np.argsort(sims)[::-1][:25]

        v = sims * 100
        v = np.exp(v - v.max())
        vision = float(v.max() / v.sum())

        pri = None
        if ctx.get("lat") is not None:
            pri = cell_priors(raw, index, payload, version,
                              ctx["lat"], ctx["lon"], ctx.get("month"))
        scores = sims[order] / T_FITTED
        if pri is not None:
            scores = scores + BETA * np.array([pri.get(int(i), OCC_FLOOR) for i in order])
        rank = np.argsort(scores)[::-1]
        order = order[rank]
        scores = scores[rank]
        e = np.exp(scores - scores[0])
        shipped = float(e[0] / e.sum())
        rows.append(dict(kind="bird", vision=vision, shipped=shipped,
                         correct=labels[int(order[0])][0] == truth[pid],
                         scores=scores.tolist()))

    nb = defaultdict(list)
    for path in sorted(glob.glob("../imagenette/val/*/*.JPEG")):
        cls = os.path.basename(os.path.dirname(path))
        with torch.no_grad():
            emb = model(torch.from_numpy(preprocess(path))).numpy()[0]
        sims = emb @ classifier.T
        v = sims * 100
        v = np.exp(v - v.max())
        vision = float(v.max() / v.sum())
        top = np.sort(sims)[::-1][:25] / T_FITTED
        e = np.exp(top - top[0])
        shipped = float(e[0] / e.sum())
        nb[cls].append((vision, shipped))
        rows.append(dict(kind="nonbird", cls=cls, vision=vision, shipped=shipped,
                         correct=False, scores=None))

    json.dump(rows, open("gate_analysis.json", "w"))
    birds = [r for r in rows if r["kind"] == "bird"]
    print("labelled birds %d, top-1 accuracy %.2f%%" %
          (len(birds), 100 * np.mean([r["correct"] for r in birds])))

    # Q4 -- per class, every threshold.
    print("\n=== Q4: non-bird pass rate on the pre-rerank vision gate ===")
    ths = [0.1, 0.2, 0.3, 0.4, 0.5]
    print("%-26s %5s %s" % ("class", "n", "".join("%8.1f" % t for t in ths)))
    for cls in sorted(nb):
        vals = np.array([v for v, _ in nb[cls]])
        mark = "  <-- dog" if "spaniel" in cls else ""
        print("%-26s %5d %s%s" % (cls, len(vals),
              "".join("%7.1f%%" % (100 * (vals >= t).mean()) for t in ths), mark))
    allv = np.array([v for c in nb for v, _ in nb[c]])
    bv = np.array([r["vision"] for r in birds])
    print("%-26s %5d %s" % ("ALL non-birds", len(allv),
          "".join("%7.1f%%" % (100 * (allv >= t).mean()) for t in ths)))
    print("%-26s %5d %s" % ("birds (kept)", len(bv),
          "".join("%7.1f%%" % (100 * (bv >= t).mean()) for t in ths)))

    # Q2 -- do the two gates overlap?
    print("\n=== Q2: vision gate 0.3 vs post-rerank gate 0.7 ===")
    for name, sel in (("birds", birds),
                      ("dogs", [r for r in rows if r.get("cls", "").find("spaniel") >= 0]),
                      ("all non-birds", [r for r in rows if r["kind"] == "nonbird"])):
        v = np.array([r["vision"] for r in sel]) >= 0.3
        s = np.array([r["shipped"] for r in sel]) >= 0.7
        print("%-14s n=%4d  both pass %5.1f%%  vision-only catches %5.1f%%  "
              "shipped-only catches %5.1f%%  neither %5.1f%%"
              % (name, len(sel), 100 * (v & s).mean(), 100 * (~v & s).mean(),
                 100 * (v & ~s).mean(), 100 * (~v & ~s).mean()))

    # Q3 -- fit a display temperature against P(top-1 correct).
    print("\n=== Q3: display calibration ===")
    sc = [np.array(r["scores"]) for r in birds]
    y = np.array([r["correct"] for r in birds], dtype=float)
    best = None
    for tau in np.concatenate([np.linspace(0.5, 20, 40), np.linspace(20, 400, 40)]):
        p = np.array([float(np.exp((s - s[0]) / tau)[0] / np.exp((s - s[0]) / tau).sum())
                      for s in sc])
        nll = -np.mean(y * np.log(np.clip(p, 1e-9, 1)) + (1 - y) * np.log(np.clip(1 - p, 1e-9, 1)))
        ece = 0.0
        for lo in np.arange(0, 1, 0.1):
            m = (p >= lo) & (p < lo + 0.1)
            if m.sum():
                ece += m.mean() * abs(p[m].mean() - y[m].mean())
        if best is None or nll < best[1]:
            best = (tau, nll, ece, p)
    tau, nll, ece, p = best
    p_now = np.array([r["shipped"] for r in birds])
    ece_now = 0.0
    for lo in np.arange(0, 1, 0.1):
        m = (p_now >= lo) & (p_now < lo + 0.1)
        if m.sum():
            ece_now += m.mean() * abs(p_now[m].mean() - y[m].mean())
    print("current display (softmax over raw scores): mean %.3f vs accuracy %.3f, ECE %.3f"
          % (p_now.mean(), y.mean(), ece_now))
    print("best display temperature tau = %.2f: mean %.3f vs accuracy %.3f, ECE %.3f"
          % (tau, p.mean(), y.mean(), ece))
    print("\nreliability at tau=%.2f" % tau)
    for lo in np.arange(0, 1, 0.2):
        m = (p >= lo) & (p < lo + 0.2)
        if m.sum():
            print("  shown %.0f-%.0f%%  n=%3d  actually correct %5.1f%%"
                  % (100 * lo, 100 * (lo + 0.2), m.sum(), 100 * y[m].mean()))


if __name__ == "__main__":
    main()
