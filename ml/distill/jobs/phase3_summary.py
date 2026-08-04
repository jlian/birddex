"""Summarise phase 3: the fresh-photo fine-tune, against phase 2 and the bar."""
import json
import os
import glob
import time

FRESH = "runs/ft_tiny39_fresh"
REUSED = "runs/ft_tiny39"
BIOCLIP2 = 86.41
DISTILL = 84.98
TEACHER = 89.93


def top1(path):
    try:
        d = json.load(open(path))
    except Exception:
        return None
    s = d.get("student")
    if isinstance(s, dict):
        return s.get("top1")
    return d.get("student_top1")


def collect(dirname):
    out = []
    ck = os.path.join(dirname, "best.pt")
    floor = os.path.getmtime(ck) if os.path.exists(ck) else 0.0
    for p in sorted(glob.glob(os.path.join(dirname, "nbeval_a*.json"))):
        if floor and os.path.getmtime(p) < floor:
            continue
        a = os.path.basename(p).replace("nbeval_a", "").replace(".json", "")
        out.append((a, top1(p)))
    return out


fresh = collect(FRESH)
reused = collect(REUSED)

print("")
print("=== PHASE 3: fresh-photo fine-tune (D7) ===")
print("")
print("Tests whether reusing the teacher's own ground-truth set suppressed the")
print("fine-tune gain. Same baseline, same recipe, only the photos differ.")
print("")

if not fresh:
    print("NO FRESH RESULTS in %s -- report as a FAILURE, not a missed bar." % FRESH)
else:
    rmap = dict(reused)
    print("  alpha    fresh    phase2    delta")
    best = (None, -1.0)
    for a, t in fresh:
        if t is None:
            print("  %-6s   (unparsed)" % a)
            continue
        r = rmap.get(a)
        rs = ("%6.2f" % r) if isinstance(r, float) else "     -"
        ds = ("%+6.2f" % (t - r)) if isinstance(r, float) else "     -"
        print("  %-6s  %6.2f   %s   %s" % (a, t, rs, ds))
        if t > best[1]:
            best = (a, t)
    print("")
    if best[0] is not None:
        t = best[1]
        print("BEST fresh: alpha %s -> %.2f" % (best[0], t))
        print("  distill-only baseline   %.2f  (gain %+.2f)" % (DISTILL, t - DISTILL))
        print("  phase 2 best            86.08")
        print("  SHIP BAR (BioCLIP-2)    %.2f  -> %s" % (
              BIOCLIP2, "PASS" if t >= BIOCLIP2 else "MISSED by %.2f" % (BIOCLIP2 - t)))
        print("  WingCLIP-0.1 teacher    %.2f" % TEACHER)
        print("")
        if best[0] in ("0.25", "0.90"):
            print("NOTE: the optimum is at a sweep ENDPOINT. The true optimum can lie")
            print("      outside the swept range. Widen it before concluding.")
        if len(fresh) < 6:
            print("NOTE: only %d/6 alphas produced results. INCOMPLETE sweep." % len(fresh))
print("")
