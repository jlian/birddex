#!/usr/bin/env python3
"""Produce the int8 package from a converted fp16 package."""
import sys

import coremltools as ct
import coremltools.optimize.coreml as cto

src, dst = sys.argv[1], sys.argv[2]
cfg = cto.OptimizationConfig(
    global_config=cto.OpLinearQuantizerConfig(
        mode="linear_symmetric", dtype="int8", granularity="per_channel"))
cto.linear_quantize_weights(ct.models.MLModel(src), config=cfg).save(dst)
print("wrote " + dst)
