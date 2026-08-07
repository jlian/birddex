import json

import numpy as np

d = json.load(open("abstention_signals.json"))
b = np.array(d["vision"]["birds"])
n = np.array(d["vision"]["nonbirds"])

print("my sets: birds n=%d (ml/heldout-orig), non-birds n=%d (imagenette val)"
      % (len(b), len(n)))
print("%10s %14s %16s" % ("threshold", "birds kept", "non-birds pass"))
for t in (0.3, 0.5, 0.7, 0.9):
    print("%10.1f %13.1f%% %15.1f%%"
          % (t, 100 * (b >= t).mean(), 100 * (n >= t).mean()))
print()
print("ml/README claims at 0.5: 88.4%% birds kept, 2.4%% non-birds pass")
print("mine at 0.5:             %.1f%% birds kept, %.1f%% non-birds pass"
      % (100 * (b >= 0.5).mean(), 100 * (n >= 0.5).mean()))
