import json

import numpy as np

d = json.load(open("abstention_signals.json"))

for key in ("vision", "shipped"):
    b = np.array(d[key]["birds"])
    n = np.array(d[key]["nonbirds"])
    print("=== %s ===" % key)
    print("birds    : min %.5f  p1 %.5f  p5 %.5f  median %.5f"
          % (b.min(), *np.percentile(b, [1, 5]), np.median(b)))
    print("non-birds: median %.5f  p90 %.5f  max %.5f"
          % (np.median(n), np.percentile(n, 90), n.max()))
    print("%10s %13s %16s" % ("threshold", "birds kept", "non-birds pass"))
    for t in (0.01, 0.02, 0.03, 0.05, 0.07, 0.1, 0.15, 0.2):
        print("%10.3f %12.1f%% %15.1f%%"
              % (t, 100 * (b >= t).mean(), 100 * (n >= t).mean()))
    print()

# Largest non-bird pass rate that still keeps every bird in the set.
for key in ("vision", "shipped"):
    b = np.array(d[key]["birds"])
    n = np.array(d[key]["nonbirds"])
    t = b.min()
    print("%s: at the lowest bird score (%.5f), non-birds passing = %.1f%%"
          % (key, t, 100 * (n >= t).mean()))
