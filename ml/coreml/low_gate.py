import json

import numpy as np

d = json.load(open("abstention_signals.json"))
b = np.array(d["shipped"]["birds"])
n = np.array(d["shipped"]["nonbirds"])

print("birds n=%d  non-birds n=%d" % (len(b), len(n)))
print("birds    : min %.4f  p1 %.4f  p5 %.4f  p10 %.4f  median %.4f"
      % (b.min(), *np.percentile(b, [1, 5, 10]), np.median(b)))
print("non-birds: p10 %.4f  median %.4f  p90 %.4f  max %.4f"
      % (np.percentile(n, 10), np.median(n), np.percentile(n, 90), n.max()))
print()
print("%10s %14s %16s %14s" % ("threshold", "birds kept", "non-birds pass", "birds lost"))
for t in [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.8]:
    keep = float((b >= t).mean())
    leak = float((n >= t).mean())
    print("%10.2f %13.1f%% %15.1f%% %13.1f%%"
          % (t, 100 * keep, 100 * leak, 100 * (1 - keep)))
