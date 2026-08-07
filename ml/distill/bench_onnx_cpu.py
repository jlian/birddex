#!/usr/bin/env python3
"""Latency of the exported graphs on CPU, at realistic client thread counts."""
import time

import numpy as np
import onnxruntime as ort

x = np.random.randn(1, 3, 224, 224).astype(np.float32)
models = [("fp32", "export/wingclip_visual_fp32.onnx"),
          ("int8", "export/wingclip_visual_int8.onnx")]
print("threads   model   ms/image")
for th in [1, 2, 4]:
    for tag, p in models:
        try:
            so = ort.SessionOptions()
            so.intra_op_num_threads = th
            s = ort.InferenceSession(p, so, providers=["CPUExecutionProvider"])
            n = s.get_inputs()[0].name
            for _ in range(3):
                s.run(None, {n: x})
            t = time.time()
            R = 10
            for _ in range(R):
                s.run(None, {n: x})
            ms = (time.time() - t) / R * 1000
            print("  " + str(th).ljust(8) + tag.ljust(7) +
                  "{:8.1f}".format(ms))
        except Exception as e:
            print("  " + str(th).ljust(8) + tag.ljust(7) + " ERR " + str(e)[:60])
print("=== BENCH DONE ===")
