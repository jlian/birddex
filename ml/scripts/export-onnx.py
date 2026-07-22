#!/usr/bin/env python3
"""Export BioCLIP-2 image encoder to ONNX, measure sizes (fp32/fp16/int8),
and verify parity vs the PyTorch model. Also precompute the 11k text-embedding
matrix and measure its quantized size. This tells us the real browser download."""
import json, os, time
import torch, open_clip, numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "onnx-export")
os.makedirs(OUT, exist_ok=True)

def sz(p): return f"{os.path.getsize(p)/1e6:.1f} MB"

print("loading BioCLIP-2 (ViT-L/14)...", flush=True)
model, _, preprocess = open_clip.create_model_and_transforms("hf-hub:imageomics/bioclip-2")
tokenizer = open_clip.get_tokenizer("hf-hub:imageomics/bioclip-2")
model = model.eval()

# ---- Image encoder wrapper (visual only) ----
class VisualEncoder(torch.nn.Module):
    def __init__(self, m): super().__init__(); self.m = m
    def forward(self, x):
        f = self.m.encode_image(x)
        return f / f.norm(dim=-1, keepdim=True)

venc = VisualEncoder(model).eval()
dummy = torch.randn(1, 3, 224, 224)
with torch.no_grad():
    ref = venc(dummy).numpy()

onnx_fp32 = os.path.join(OUT, "bioclip2_visual_fp32.onnx")
print("exporting ONNX (fp32)...", flush=True)
torch.onnx.export(venc, dummy, onnx_fp32,
    input_names=["image"], output_names=["embedding"],
    dynamic_axes={"image": {0: "batch"}, "embedding": {0: "batch"}},
    opset_version=17)
print(f"  fp32 onnx: {sz(onnx_fp32)}", flush=True)

# ---- verify ONNX parity ----
import onnxruntime as ort
sess = ort.InferenceSession(onnx_fp32, providers=["CPUExecutionProvider"])
onnx_out = sess.run(None, {"image": dummy.numpy()})[0]
diff = np.abs(onnx_out - ref).max()
print(f"  onnx-vs-torch max abs diff: {diff:.2e}", flush=True)

# ---- fp16 ----
try:
    from onnxconverter_common import float16
    import onnx
    m32 = onnx.load(onnx_fp32)
    m16 = float16.convert_float_to_float16(m32, keep_io_types=True)
    onnx_fp16 = os.path.join(OUT, "bioclip2_visual_fp16.onnx")
    onnx.save(m16, onnx_fp16)
    print(f"  fp16 onnx: {sz(onnx_fp16)}", flush=True)
except Exception as e:
    print(f"  fp16 skipped: {e}", flush=True)

# ---- int8 dynamic quant ----
try:
    from onnxruntime.quantization import quantize_dynamic, QuantType
    onnx_int8 = os.path.join(OUT, "bioclip2_visual_int8.onnx")
    quantize_dynamic(onnx_fp32, onnx_int8, weight_type=QuantType.QInt8)
    print(f"  int8 onnx: {sz(onnx_int8)}", flush=True)
    s8 = ort.InferenceSession(onnx_int8, providers=["CPUExecutionProvider"])
    o8 = s8.run(None, {"image": dummy.numpy()})[0]
    print(f"  int8-vs-torch max abs diff: {np.abs(o8-ref).max():.2e}", flush=True)
except Exception as e:
    print(f"  int8 skipped: {e}", flush=True)

# ---- text embedding matrix size (11k species) ----
taxo = json.load(open(os.path.join(HERE, "taxonomy.json")))
commons = [r[0] for r in taxo]; scis = [r[1] for r in taxo]
print(f"encoding {len(commons)} text labels...", flush=True)
tf = []
with torch.no_grad():
    for i in range(0, len(commons), 512):
        b = [f"a photo of {commons[j]}, {scis[j]}, a species of bird." for j in range(i, min(i+512, len(commons)))]
        e = model.encode_text(tokenizer(b)); e = e / e.norm(dim=-1, keepdim=True)
        tf.append(e.float().numpy())
tf = np.concatenate(tf).astype(np.float32)
np.save(os.path.join(OUT, "text_embeds_fp32.npy"), tf)
# int8 quantize the matrix (per-row scale)
scale = np.abs(tf).max(axis=1, keepdims=True) / 127.0
q = np.round(tf / scale).astype(np.int8)
np.save(os.path.join(OUT, "text_embeds_int8.npy"), q)
np.save(os.path.join(OUT, "text_embeds_scale.npy"), scale.astype(np.float32))
print(f"  text fp32: {tf.nbytes/1e6:.1f} MB, int8: {(q.nbytes+scale.nbytes)/1e6:.1f} MB, shape {tf.shape}", flush=True)

# ---- inference timing (CPU, single image) ----
img_paths = [os.path.join(HERE, "images", f) for f in os.listdir(os.path.join(HERE,"images"))][:5]
t0 = time.time()
for p in img_paths:
    x = preprocess(Image.open(p).convert("RGB")).unsqueeze(0).numpy()
    sess.run(None, {"image": x})
dt = (time.time()-t0)/len(img_paths)*1000
print(f"  ONNX CPU inference (fp32): {dt:.0f} ms/image (Ryzen; browser WASM will be slower, WebGPU faster)", flush=True)
print("DONE", flush=True)
