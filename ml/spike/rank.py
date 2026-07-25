#!/usr/bin/env python3
"""Where does the TRUE species rank in BioCLIP's full 11k distribution?
If misses are just out-of-range congeners ranked above an in-range true
species, then range filtering the FULL distribution recovers them."""
import json, os, glob, torch, open_clip
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
taxo = json.load(open(os.path.join(HERE,"taxonomy.json")))
commons = [r[0] for r in taxo]
truth = json.load(open(os.path.join(HERE,"truth.json")))
device = "cuda"

model,_,preprocess = open_clip.create_model_and_transforms("hf-hub:imageomics/bioclip-2")
tok = open_clip.get_tokenizer("hf-hub:imageomics/bioclip-2")
model = model.to(device).eval()

tf=[]
with torch.no_grad():
    for i in range(0,len(commons),512):
        b=[f"a photo of {commons[j]}, {taxo[j][1]}, a species of bird." for j in range(i,min(i+512,len(commons)))]
        e=model.encode_text(tok(b).to(device)); e/=e.norm(dim=-1,keepdim=True)
        tf.append(e.float().cpu())
tf=torch.cat(tf).to(device)
name2idx={c.lower():i for i,c in enumerate(commons)}

print(f"{'image':52} {'true rank':9} {'top-1 (raw)'}")
print("-"*90)
for path in sorted(glob.glob(os.path.join(HERE,"images","*"))):
    fn=os.path.basename(path); gt=truth.get(fn)
    if not gt: continue
    img=preprocess(Image.open(path).convert("RGB")).unsqueeze(0).to(device)
    with torch.no_grad():
        f=model.encode_image(img); f/=f.norm(dim=-1,keepdim=True); f=f.float()
        sims=(f@tf.T).squeeze(0)
    order=torch.argsort(sims,descending=True).tolist()
    gi=name2idx.get(gt.lower())
    rank=order.index(gi)+1 if gi is not None else -1
    top1=commons[order[0]]
    flag = "  <-- top1 correct" if rank==1 else ("  MISS" if rank>5 else "")
    print(f"{fn[:52]:52} {rank:<9} {top1[:28]:28}{flag}")
