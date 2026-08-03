"""Summarise phase 2: fine-tune + WiSE-FT alpha sweep vs the ship bar."""
import json
import os
import glob

FT = "runs/ft_tiny39"
BIOCLIP2 = 86.41   # the ship bar
VITB_ALPHA = 89.93 # WingCLIP-0.1 full chain, 86.6M
VITB_DISTILL = 81.83

rows = []
for p in sorted(glob.glob(os.path.join(FT, "nbeval_a*.json"))):
    a = os.path.basename(p).replace("nbeval_a", "").replace(".json", "")
    try:
        d = json.load(open(p))
    except Exception as e:
        print("  %s unreadable: %s" % (p, e))
        continue
    # tolerate either schema: explicit student block or flat keys
    top1 = None
    for k in ("student_top1", "top1", "student"):
        v = d.get(k)
        if isinstance(v, dict):
            top1 = v.get("top1")
        elif isinstance(v, (int, float)):
            top1 = v
        if top1 is not None:
            break
    if top1 is None:
        for v in d.values():
            if isinstance(v, dict) and "top1" in v:
                top1 = v["top1"]
                break
    rows.append((a, top1, d))

print("")
print("=== PHASE 2: TinyCLIP-39M fine-tune + WiSE-FT ===")
print("")
if not rows:
    print("NO RESULTS FOUND in %s" % FT)
else:
    print("  alpha   NABirds top1   vs bar (86.41)")
    best = (None, -1.0)
    for a, t, _ in rows:
        if t is None:
            print("  %-6s  (unparsed)" % a)
            continue
        d = t - BIOCLIP2
        mark = "PASS" if d >= 0 else "miss"
        print("  %-6s  %8.2f     %+6.2f  %s" % (a, t, d, mark))
        if t > best[1]:
            best = (a, t)
    print("")
    if best[0] is not None:
        t = best[1]
        print("BEST: alpha %s -> %.2f" % (best[0], t))
        print("")
        print("SHIP BAR (beat BioCLIP-2 %.2f): %s" % (
              BIOCLIP2, "PASS" if t >= BIOCLIP2 else "MISSED"))
        print("reference: WingCLIP-0.1 full chain %.2f at 86.6M params;" % VITB_ALPHA)
        print("           its distill-only stage was %.2f" % VITB_DISTILL)
        if best[0] in ("1.00", "0.25"):
            print("NOTE: optimum is at a sweep ENDPOINT -- the true optimum may lie",
                  "outside the swept range; widen it before concluding.")
print("")
