#!/usr/bin/env python3
"""Generate the shipped artifacts for the in-browser demo:
- text_embeds_int8.bin  (11167 x 768 int8, row-major)
- text_embeds_scale.bin (11167 float32 per-row scales)
- species.json          (common names + ebird codes, index-aligned)
So the browser only runs the image encoder + one int8 matmul."""
import json, os, numpy as np, torch, open_clip
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "demo-assets"); os.makedirs(OUT, exist_ok=True)
taxo = json.load(open(os.path.join(HERE, "taxonomy.json")))
commons = [r[0] for r in taxo]; scis = [r[1] for r in taxo]; codes = [r[2] for r in taxo]
m, _, _ = open_clip.create_model_and_transforms("hf-hub:imageomics/bioclip-2")
tok = open_clip.get_tokenizer("hf-hub:imageomics/bioclip-2")
m = m.to("cuda").eval()
tf = []
with torch.no_grad():
    for i in range(0, len(commons), 512):
        b = [f"a photo of {commons[j]}, {scis[j]}, a species of bird." for j in range(i, min(i+512, len(commons)))]
        e = m.encode_text(tok(b).to("cuda")); e = e / e.norm(dim=-1, keepdim=True)
        tf.append(e.float().cpu().numpy())
tf = np.concatenate(tf).astype(np.float32)  # (11167,768) normalized
scale = (np.abs(tf).max(axis=1, keepdims=True) / 127.0).astype(np.float32)
q = np.round(tf / scale).astype(np.int8)
q.tofile(os.path.join(OUT, "text_embeds_int8.bin"))
scale.astype(np.float32).tofile(os.path.join(OUT, "text_embeds_scale.bin"))
json.dump([{"c": commons[i], "e": codes[i]} for i in range(len(commons))],
          open(os.path.join(OUT, "species.json"), "w"))
print(f"wrote demo-assets: int8 {q.nbytes/1e6:.1f}MB, scale {scale.nbytes/1e6:.2f}MB, species.json {len(commons)}")
print(f"embed dim {tf.shape[1]}")
