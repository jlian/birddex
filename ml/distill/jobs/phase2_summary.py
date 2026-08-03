"""Summarise phase 2: fine-tune + WiSE-FT alpha sweep vs the ship bar."""
import json
import os
import glob
import time

FT = "runs/ft_tiny39"
BIOCLIP2 = 86.41   # the ship bar
VITB_ALPHA = 89.93 # WingCLIP-0.1 full chain, 86.6M
VITB_DISTILL = 81.83

# Stale eval JSONs look EXACTLY like real ones. On 2026-08-02 a leftover file
# reading 28.42 was nearly reported as a result. Anything older than the
# fine-tune checkpoint cannot belong to this run, so refuse to report it.
ftck = os.path.join(FT, "best.pt")
floor = os.path.getmtime(ftck) if os.path.exists(ftck) else 0.0

rows = []
stale = []
for p in sorted(glob.glob(os.path.join(FT, "nbeval_a*.json"))):
    a = os.path.basename(p).replace("nbeval_a", "").replace(".json", "")
    if floor and os.path.getmtime(p) < floor:
        stale.append((a, p))
        continue
    try:
        d = json.load(open(p))
    except Exception as e:
        print("  %s unreadable: %s" % (p, e))
        continue
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

if stale:
    print("IGNORED %d STALE eval file(s) older than the fine-tune:" % len(stale))
    for a, p in stale:
        print("   alpha %s  %s" % (a, time.strftime("%m-%d %H:%M",
              time.localtime(os.path.getmtime(p)))))
    print("   (these are from an earlier attempt, NOT this run)")
    print("")

if not rows:
    print("NO FRESH RESULTS FOUND in %s -- report this as a FAILURE," % FT)
    print("not as a missing bar.")
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
        print("SHIP BAR (beat BioCLIP-2 %.2f): %s" % (
              BIOCLIP2, "PASS" if t >= BIOCLIP2 else "MISSED"))
        print("ref: WingCLIP-0.1 full chain %.2f at 86.6M; its distill-only "
              "stage was %.2f" % (VITB_ALPHA, VITB_DISTILL))
        if best[0] in ("1.00", "0.25"):
            print("NOTE: optimum is at a sweep ENDPOINT -- the true optimum may")
            print("      lie outside the swept range; widen it before concluding.")
        if len(rows) < 5:
            print("NOTE: only %d/5 alphas produced results -- INCOMPLETE sweep."
                  % len(rows))
print("")
