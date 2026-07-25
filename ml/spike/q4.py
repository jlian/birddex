#!/usr/bin/env python3
"""4-bit quantize the BioCLIP-2 ViT-L ONNX encoder, measure size, and emit
q4 candidate fixtures so we can benchmark accuracy vs fp32/int8.
Uses onnxruntime matmul 4-bit weight quantization."""
import json, os, time
import numpy as np
import onnxruntime as ort
from PIL import Image
import torch, open_clip

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "onnx-export")
def sz(p): return os.path.getsize(p) / 1e6

fp32 = os.path.join(OUT, "bioclip2_visual_fp32.onnx")
q4 = os.path.join(OUT, "bioclip2_visual_q4.onnx")

# 4-bit block quantization of MatMul weights
from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer
import onnx
print("loading fp32 onnx...", flush=True)
model = onnx.load(fp32)
quant = MatMulNBitsQuantizer(model, block_size=32, is_symmetric=True, bits=4)
quant.process()
quant.model.save_model_to_file(q4, use_external_data_format=False)
print(f"q4 onnx: {sz(q4):.1f} MB (fp32 was {sz(fp32):.0f} MB, int8 was 307 MB)", flush=True)

# parity check vs torch
class V(torch.nn.Module):
    def __init__(s, m): super().__init__(); s.m = m
    def forward(s, x):
        f = s.m.encode_image(x); return f / f.norm(dim=-1, keepdim=True)
tmodel, _, preprocess = open_clip.create_model_and_transforms("hf-hub:imageomics/bioclip-2")
venc = V(tmodel).eval()
dummy = torch.randn(1, 3, 224, 224)
with torch.no_grad(): ref = venc(dummy).numpy()
sess = ort.InferenceSession(q4, providers=["CPUExecutionProvider"])
o = sess.run(None, {"image": dummy.numpy()})[0]
print(f"q4-vs-torch max abs diff: {np.abs(o - ref).max():.2e}", flush=True)

# emit q4 fixtures (top-50) using ONNX image encoder + torch text matrix
taxo = json.load(open(os.path.join(HERE, "taxonomy.json")))
commons = [r[0] for r in taxo]; scis = [r[1] for r in taxo]
tmodel = tmodel.to("cuda").eval()
tok = open_clip.get_tokenizer("hf-hub:imageomics/bioclip-2")
tf = []
with torch.no_grad():
    for i in range(0, len(commons), 512):
        b = [f"a photo of {commons[j]}, {scis[j]}, a species of bird." for j in range(i, min(i+512, len(commons)))]
        e = tmodel.encode_text(tok(b).to("cuda")); e = e / e.norm(dim=-1, keepdim=True)
        tf.append(e.float().cpu().numpy())
tf = np.concatenate(tf)  # (11167, 768)

CTX = json.load(open(os.path.join(HERE, "context.json")))
import glob, torch.nn.functional as F
outdir = os.path.join(HERE, "bioclip-q4-fixtures"); os.makedirs(outdir, exist_ok=True)
for path in sorted(glob.glob(os.path.join(HERE, "images", "*"))):
    fn = os.path.basename(path)
    x = preprocess(Image.open(path).convert("RGB")).unsqueeze(0).numpy()
    emb = sess.run(None, {"image": x})[0][0]  # (768,) already normalized
    sims = tf @ emb
    probs = torch.softmax(torch.tensor(sims) / 0.01, dim=0).numpy()
    order = np.argsort(-probs)[:8]
    cands = [{"commonName": commons[i], "scientificName": scis[i],
              "confidence": round(float(probs[i]), 4), "plumage": None} for i in order]
    fx = {"imageFile": fn, "context": CTX.get(fn, {}),
          "parsed": {"candidates": cands, "birdCenter": None, "birdSize": None, "multipleBirds": False},
          "model": "bioclip-2-q4"}
    json.dump(fx, open(os.path.join(outdir, fn.rsplit(".", 1)[0] + ".json"), "w"), indent=1)
print("wrote bioclip-q4-fixtures/", flush=True)

# timing
sess.run(None, {"image": np.random.randn(1,3,224,224).astype(np.float32)})
t0 = time.time()
for _ in range(5): sess.run(None, {"image": np.random.randn(1,3,224,224).astype(np.float32)})
print(f"q4 CPU inference: {(time.time()-t0)/5*1000:.0f} ms/image", flush=True)
print("DONE", flush=True)
