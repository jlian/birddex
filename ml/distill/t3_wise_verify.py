#!/usr/bin/env python3
"""T3.1 -- verify the WiSE-FT interpolation is arithmetically correct.

alpha=0.0 must reproduce BASE, alpha=1.0 must reproduce FINE-TUNED. If either
fails, the alpha sweep is meaningless and "WiSE-FT does not help here" is a
bug rather than a finding. Also reports how many tensors actually moved during
fine-tuning, which catches a head silently excluded from the merge.
"""
import argparse
import sys
import torch

NL = chr(10)


def load_sd(p):
    ck = torch.load(p, map_location="cpu", weights_only=False)
    for k in ("state_dict", "model", "model_state_dict"):
        if isinstance(ck, dict) and k in ck and isinstance(ck[k], dict):
            return ck[k]
    return ck


def compare(tag, path, ref, refname, shared):
    if not path:
        print(NL + "[" + tag + "] skipped")
        return None
    w = load_sd(path)
    worst = 0.0
    worst_k = None
    missing = 0
    for k in shared:
        if k not in w:
            missing += 1
            continue
        tw = w[k]
        tr = ref[k]
        if not (torch.is_tensor(tw) and torch.is_tensor(tr)):
            continue
        if tw.shape != tr.shape:
            continue
        d = (tw.float() - tr.float()).abs().max().item()
        if d > worst:
            worst = d
            worst_k = k
    ok = worst < 1e-6
    print(NL + "[" + tag + "] vs " + refname)
    print("  max abs diff :", format(worst, ".3e"), "MATCH" if ok else "MISMATCH")
    if worst_k:
        print("  worst tensor :", worst_k)
    if missing:
        print("  !!", missing, "shared keys missing from wise ckpt")
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--ft", required=True)
    ap.add_argument("--wise-a0")
    ap.add_argument("--wise-a1")
    ap.add_argument("--wise-a05")
    args = ap.parse_args()
    base = load_sd(args.base)
    ft = load_sd(args.ft)
    print("base tensors:", len(base))
    print("ft   tensors:", len(ft))
    bk = set(base)
    fk = set(ft)
    if bk - fk:
        print("!!", len(bk - fk), "keys ONLY in base:", sorted(bk - fk)[:5])
    if fk - bk:
        print("!!", len(fk - bk), "keys ONLY in ft:", sorted(fk - bk)[:5])
    shared = sorted(bk & fk)
    moved = []
    frozen = []
    mismatch = []
    for k in shared:
        tb = base[k]
        tf = ft[k]
        if not (torch.is_tensor(tb) and torch.is_tensor(tf)):
            continue
        if tb.shape != tf.shape:
            mismatch.append(k)
        elif torch.equal(tb.float(), tf.float()):
            frozen.append(k)
        else:
            moved.append(k)
    print(NL + "shared tensors:", len(shared))
    print("  moved during fine-tune :", len(moved))
    print("  identical (frozen)     :", len(frozen))
    print("  shape mismatch         :", len(mismatch))
    if mismatch:
        print("  !! mismatched:", mismatch[:5])
    if frozen:
        print("  frozen examples:", frozen[:5])
    r0 = compare("alpha=0.0", args.wise_a0, base, "BASE", shared)
    r1 = compare("alpha=1.0", args.wise_a1, ft, "FINE-TUNED", shared)
    if args.wise_a05:
        w = load_sd(args.wise_a05)
        worst = 0.0
        worst_k = None
        for k in moved:
            if k not in w:
                continue
            mid = 0.5 * base[k].float() + 0.5 * ft[k].float()
            d = (w[k].float() - mid).abs().max().item()
            if d > worst:
                worst = d
                worst_k = k
        print(NL + "[alpha=0.5] vs analytic midpoint")
        print("  max abs diff :", format(worst, ".3e"),
              "MATCH" if worst < 1e-6 else "MISMATCH")
        if worst_k:
            print("  worst tensor :", worst_k)
    print(NL + "=== VERDICT ===")
    if r0 is False or r1 is False:
        print("BROKEN: endpoints do not reproduce their sources.")
        sys.exit(2)
    if r0 and r1:
        print("SOUND: interpolation correct; flat sweep is a real finding.")
    print("Blend surface:", len(moved), "moved,", len(frozen), "unchanged.")
    print("=== T3 VERIFY DONE ===")


if __name__ == "__main__":
    main()
