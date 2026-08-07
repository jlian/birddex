#!/usr/bin/env python3
"""Inspect where the ViT-L ONNX weight bytes actually live, to see if 4-bit
can realistically get below int8. Also try int4 with larger block + quantizing
embeddings/gather if supported."""
import onnx, numpy as np, os
HERE = os.path.dirname(os.path.abspath(__file__))
m = onnx.load(os.path.join(HERE, "onnx-export", "bioclip2_visual_fp32.onnx"))
from collections import defaultdict
by_type = defaultdict(lambda: [0, 0])  # bytes, count
total = 0
for init in m.graph.initializer:
    n = int(np.prod(init.dims)) if init.dims else 1
    # dtype size
    dsize = {1:4, 10:2, 7:8, 6:4, 11:8}.get(init.data_type, 4)
    b = n * dsize
    total += b
    # classify by name
    nm = init.name.lower()
    if 'matmul' in nm or 'proj' in nm or 'fc' in nm or 'mlp' in nm or 'attn' in nm or 'weight' in nm and init.dims and len(init.dims) == 2:
        key = 'matmul-like (2D weight)'
    elif 'norm' in nm or 'ln' in nm or 'bias' in nm:
        key = 'norm/bias'
    elif 'embed' in nm or 'class' in nm or 'pos' in nm:
        key = 'embedding/pos'
    elif 'conv' in nm or 'patch' in nm:
        key = 'conv/patch'
    else:
        key = f'other ({len(init.dims)}D)'
    by_type[key][0] += b
    by_type[key][1] += 1
print(f"total initializer bytes: {total/1e6:.1f} MB")
for k, (b, c) in sorted(by_type.items(), key=lambda x: -x[1][0]):
    print(f"  {k:28} {b/1e6:7.1f} MB  ({c} tensors)")

# how much is 2D (matmul-quantizable) vs not?
twod = sum(int(np.prod(i.dims))*4 for i in m.graph.initializer if len(i.dims)==2)
print(f"\n2D-tensor weight (4-bit quantizable): {twod/1e6:.1f} MB -> ~{twod/8/1e6:.1f} MB at 4-bit")
print(f"non-2D (stays fp32): {(total-twod)/1e6:.1f} MB")
