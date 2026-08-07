#!/usr/bin/env python3
"""BioCLIP-2 zero-shot bird ID spike vs WingDex GPT golden fixtures."""
import json, os, sys, time, glob
import torch
import open_clip
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
IMG_DIR = os.path.join(HERE, "images")
TAXO = os.path.join(HERE, "taxonomy.json")
TRUTH = os.path.join(HERE, "truth.json")
FIX_DIR = os.path.join(HERE, "fixtures")  # copied golden fixtures

device = "cuda" if torch.cuda.is_available() else "cpu"
print(f"device={device}", flush=True)

# --- Load taxonomy: [common, scientific, ebird, wiki_common, thumb, wiki_id] ---
taxo = json.load(open(TAXO))
commons = [row[0] for row in taxo]
scis = [row[1] for row in taxo]
print(f"taxonomy: {len(commons)} species", flush=True)

truth = json.load(open(TRUTH))

# --- Load BioCLIP-2 ---
print("loading BioCLIP-2...", flush=True)
t0 = time.time()
model, _, preprocess = open_clip.create_model_and_transforms("hf-hub:imageomics/bioclip-2")
tokenizer = open_clip.get_tokenizer("hf-hub:imageomics/bioclip-2")
model = model.to(device).eval()
print(f"model loaded in {time.time()-t0:.1f}s", flush=True)

# --- Build text embeddings for all species (BioCLIP taxonomic prompt style) ---
# BioCLIP is trained on "a photo of <sci name>." style and taxonomic strings.
def make_prompts(common, sci):
    return f"a photo of {common}, {sci}, a species of bird."

print("encoding text labels (this is the big step)...", flush=True)
t0 = time.time()
text_feats = []
bs = 512
with torch.no_grad():
    for i in range(0, len(commons), bs):
        batch = [make_prompts(commons[j], scis[j]) for j in range(i, min(i+bs, len(commons)))]
        toks = tokenizer(batch).to(device)
        tf = model.encode_text(toks)
        tf = tf / tf.norm(dim=-1, keepdim=True)
        text_feats.append(tf.float().cpu())
        if i % 2048 == 0:
            print(f"  {i}/{len(commons)}", flush=True)
text_feats = torch.cat(text_feats).to(device)
print(f"text encoded in {time.time()-t0:.1f}s, shape={tuple(text_feats.shape)}", flush=True)

def gpt_top(fixture_name):
    """Read GPT golden fixture top candidate(s)."""
    p = os.path.join(FIX_DIR, fixture_name.rsplit('.',1)[0] + ".json")
    if not os.path.exists(p):
        return None
    d = json.load(open(p))
    cands = d.get("parsed", {}).get("candidates", [])
    names = []
    for c in cands:
        s = c.get("species", "")
        # strip scientific paren
        common = s.split(" (")[0].strip()
        names.append(common)
    return names

# --- Run each image ---
results = []
imgs = sorted(glob.glob(os.path.join(IMG_DIR, "*")))
for path in imgs:
    fn = os.path.basename(path)
    gt = truth.get(fn)
    try:
        img = preprocess(Image.open(path).convert("RGB")).unsqueeze(0).to(device)
    except Exception as e:
        print(f"SKIP {fn}: {e}", flush=True)
        continue
    t0 = time.time()
    with torch.no_grad():
        f = model.encode_image(img)
        f = f / f.norm(dim=-1, keepdim=True)
        f = f.float()
        sims = (f @ text_feats.T).squeeze(0)
        top = torch.topk(sims, 5)
    dt = (time.time()-t0)*1000
    top_idx = top.indices.tolist()
    top_names = [commons[i] for i in top_idx]
    top_scores = [round(float(s),3) for s in top.values.tolist()]
    gpt = gpt_top(fn)
    results.append({
        "image": fn, "truth": gt,
        "bioclip_top5": top_names, "bioclip_scores": top_scores,
        "gpt_candidates": gpt, "ms": round(dt)
    })
    print(f"\n{fn}", flush=True)
    print(f"  truth:   {gt}", flush=True)
    print(f"  bioclip: {list(zip(top_names, top_scores))}", flush=True)
    print(f"  gpt:     {gpt}", flush=True)

# --- Score ---
def hit1(r):
    return r["truth"] and r["bioclip_top5"] and r["truth"].lower() == r["bioclip_top5"][0].lower()
def hit5(r):
    return r["truth"] and any(r["truth"].lower()==n.lower() for n in r["bioclip_top5"])
def gpt_hit1(r):
    return r["truth"] and r["gpt_candidates"] and r["truth"].lower()==r["gpt_candidates"][0].lower()
def gpt_hit5(r):
    return r["truth"] and r["gpt_candidates"] and any(r["truth"].lower()==n.lower() for n in r["gpt_candidates"])

scored = [r for r in results if r["truth"]]
n = len(scored)
print("\n" + "="*60, flush=True)
print(f"SCORED IMAGES (excluding ambiguous/multi-bird): {n}", flush=True)
print(f"BioCLIP-2  top-1: {sum(hit1(r) for r in scored)}/{n} = {sum(hit1(r) for r in scored)/n*100:.0f}%", flush=True)
print(f"BioCLIP-2  top-5: {sum(hit5(r) for r in scored)}/{n} = {sum(hit5(r) for r in scored)/n*100:.0f}%", flush=True)
print(f"GPT-5.4mini top-1: {sum(gpt_hit1(r) for r in scored)}/{n} = {sum(gpt_hit1(r) for r in scored)/n*100:.0f}%", flush=True)
print(f"GPT-5.4mini top-5: {sum(gpt_hit5(r) for r in scored)}/{n} = {sum(gpt_hit5(r) for r in scored)/n*100:.0f}%", flush=True)
avg_ms = sum(r["ms"] for r in results)/len(results)
print(f"avg image inference: {avg_ms:.0f}ms (GPU)", flush=True)

json.dump(results, open(os.path.join(HERE,"spike_results.json"),"w"), indent=2)
print("\nwrote spike_results.json", flush=True)
