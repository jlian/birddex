#!/usr/bin/env python3
"""Text-matrix size + ONNX inference timing (GPU for text encode)."""
import json, os, time
import torch, open_clip, numpy as np
from PIL import Image
import onnxruntime as ort

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "onnx-export")
dev = "cuda"
model, _, preprocess = open_clip.create_model_and_transforms("hf-hub:imageomics/bioclip-2")
tok = open_clip.get_tokenizer("hf-hub:imageomics/bioclip-2")
model = model.to(dev).eval()

taxo = json.load(open(os.path.join(HERE, "taxonomy.json")))
commons = [r[0] for r in taxo]; scis = [r[1] for r in taxo]
tf = []
with torch.no_grad():
    for i in range(0, len(commons), 512):
        b = [f"a photo of {commons[j]}, {scis[j]}, a species of bird." for j in range(i, min(i+512, len(commons)))]
        e = model.encode_text(tok(b).to(dev)); e = e / e.norm(dim=-1, keepdim=True)
        tf.append(e.float().cpu().numpy())
tf = np.concatenate(tf).astype(np.float32)
scale = np.abs(tf).max(axis=1, keepdims=True) / 127.0
q = np.round(tf / scale).astype(np.int8)
print(f"text matrix: fp32 {tf.nbytes/1e6:.1f} MB | int8 {(q.nbytes+scale.nbytes)/1e6:.1f} MB | shape {tf.shape}", flush=True)
# gzip estimate
import gzip
gz = len(gzip.compress(q.tobytes()))
print(f"text int8 gzipped: {gz/1e6:.1f} MB", flush=True)

# ONNX CPU timing (proxy; browser WASM ~2-4x slower, WebGPU ~3-10x faster)
for tag, f in [("fp32", "bioclip2_visual_fp32.onnx"), ("int8", "bioclip2_visual_int8.onnx")]:
    p = os.path.join(OUT, f)
    if not os.path.exists(p): continue
    sess = ort.InferenceSession(p, providers=["CPUExecutionProvider"])
    imgs = [os.path.join(HERE, "images", x) for x in os.listdir(os.path.join(HERE, "images"))][:5]
    xs = [preprocess(Image.open(p2).convert("RGB")).unsqueeze(0).numpy() for p2 in imgs]
    sess.run(None, {"image": xs[0]})  # warmup
    t0 = time.time()
    for x in xs: sess.run(None, {"image": x})
    print(f"ONNX {tag} CPU: {(time.time()-t0)/len(xs)*1000:.0f} ms/image (8-core Ryzen)", flush=True)
print("DONE", flush=True)
