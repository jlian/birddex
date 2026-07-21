#!/usr/bin/env python3
"""Retry 4-bit: force quantization of ALL MatMul nodes, verify size ~150MB,
re-emit fixtures + re-benchmark. Also try block_size=128 (smaller overhead)."""
import json, os, glob, time
import numpy as np, onnx, torch, open_clip
from PIL import Image
import onnxruntime as ort
from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "onnx-export")
def sz(p): return os.path.getsize(p)/1e6
fp32 = os.path.join(OUT, "bioclip2_visual_fp32.onnx")

for bs in [32, 128]:
    outp = os.path.join(OUT, f"bioclip2_visual_q4_bs{bs}.onnx")
    m = onnx.load(fp32)
    # nodes_to_exclude default empty; quant_axes / accuracy: force all
    q = MatMulNBitsQuantizer(m, block_size=bs, is_symmetric=True, bits=4, nodes_to_exclude=[])
    q.process()
    q.model.save_model_to_file(outp, use_external_data_format=False)
    print(f"block_size={bs}: {sz(outp):.1f} MB", flush=True)

# pick bs=32 for accuracy; verify + benchmark
q4 = os.path.join(OUT, "bioclip2_visual_q4_bs32.onnx")
sess = ort.InferenceSession(q4, providers=["CPUExecutionProvider"])
tmodel, _, preprocess = open_clip.create_model_and_transforms("hf-hub:imageomics/bioclip-2")
tmodel = tmodel.to("cuda").eval()
tok = open_clip.get_tokenizer("hf-hub:imageomics/bioclip-2")
taxo = json.load(open(os.path.join(HERE, "taxonomy.json")))
commons = [r[0] for r in taxo]; scis = [r[1] for r in taxo]
tf = []
with torch.no_grad():
    for i in range(0, len(commons), 512):
        b = [f"a photo of {commons[j]}, {scis[j]}, a species of bird." for j in range(i, min(i+512, len(commons)))]
        e = tmodel.encode_text(tok(b).to("cuda")); e = e/e.norm(dim=-1, keepdim=True)
        tf.append(e.float().cpu().numpy())
tf = np.concatenate(tf)
CTX = json.load(open(os.path.join(HERE, "context.json")))
outdir = os.path.join(HERE, "bioclip-q4b-fixtures"); os.makedirs(outdir, exist_ok=True)
for path in sorted(glob.glob(os.path.join(HERE, "images", "*"))):
    fn = os.path.basename(path)
    x = preprocess(Image.open(path).convert("RGB")).unsqueeze(0).numpy()
    emb = sess.run(None, {"image": x})[0][0]
    emb = emb/np.linalg.norm(emb)
    sims = tf @ emb
    probs = torch.softmax(torch.tensor(sims)/0.01, dim=0).numpy()
    order = np.argsort(-probs)[:8]
    cands = [{"commonName": commons[i], "scientificName": scis[i], "confidence": round(float(probs[i]),4), "plumage": None} for i in order]
    json.dump({"imageFile": fn, "context": CTX.get(fn, {}), "parsed": {"candidates": cands, "birdCenter": None, "birdSize": None, "multipleBirds": False}, "model": "bioclip-2-q4-bs32"},
              open(os.path.join(outdir, fn.rsplit(".",1)[0]+".json"), "w"), indent=1)
print("wrote bioclip-q4b-fixtures/", flush=True)
print("DONE", flush=True)
