#!/usr/bin/env python3
"""Rough latency for the fp16 mlpackage across compute units.

Measured on this Mac, not a phone, so treat it as an upper bound on relative
ordering rather than a shipping number.
"""
import glob
import time

import coremltools as ct
import numpy as np

x = np.fromfile(sorted(glob.glob("parity/js_*.f32.bin"))[0],
                dtype=np.float32).reshape(1, 3, 224, 224)

for name, units in [("CPU only", ct.ComputeUnit.CPU_ONLY),
                    ("CPU + GPU", ct.ComputeUnit.CPU_AND_GPU),
                    ("CPU + ANE", ct.ComputeUnit.CPU_AND_NE),
                    ("all", ct.ComputeUnit.ALL)]:
    m = ct.models.MLModel("WingCLIP.mlpackage", compute_units=units)
    for _ in range(3):
        m.predict({"image": x})
    ts = []
    for _ in range(15):
        t = time.perf_counter()
        m.predict({"image": x})
        ts.append((time.perf_counter() - t) * 1000)
    ts.sort()
    print("%-10s  median %6.1f ms   min %6.1f ms" % (name, ts[len(ts) // 2], ts[0]))
