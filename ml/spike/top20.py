#!/usr/bin/env python3
"""Dump BioCLIP top-20 candidates + scores per image, plus softmax stats,
for hand-labeled range reweighting (option 3)."""
import json, os, glob, torch, open_clip
from PIL import Image
import torch.nn.functional as F

HERE = os.path.dirname(os.path.abspath(__file__))
taxo = json.load(open(os.path.join(HERE,"taxonomy.json")))
commons=[r[0] for r in taxo]
truth=json.load(open(os.path.join(HERE,"truth.json")))
device="cuda"
model,_,preprocess=open_clip.create_model_and_transforms("hf-hub:imageomics/bioclip-2")
tok=open_clip.get_tokenizer("hf-hub:imageomics/bioclip-2")
model=model.to(device).eval()
tf=[]
with torch.no_grad():
    for i in range(0,len(commons),512):
        b=[f"a photo of {commons[j]}, {taxo[j][1]}, a species of bird." for j in range(i,min(i+512,len(commons)))]
        e=model.encode_text(tok(b).to(device)); e/=e.norm(dim=-1,keepdim=True)
        tf.append(e.float().cpu())
tf=torch.cat(tf).to(device)

out={}
for path in sorted(glob.glob(os.path.join(HERE,"images","*"))):
    fn=os.path.basename(path)
    img=preprocess(Image.open(path).convert("RGB")).unsqueeze(0).to(device)
    with torch.no_grad():
        f=model.encode_image(img); f/=f.norm(dim=-1,keepdim=True); f=f.float()
        sims=(f@tf.T).squeeze(0)
    top=torch.topk(sims,20)
    # softmax stats (temp=0.01 typical for CLIP cosine)
    probs=F.softmax(sims/0.01,dim=0)
    ptop=torch.topk(probs,5)
    out[fn]={
        "truth":truth.get(fn),
        "top20":[[commons[i],round(float(sims[i]),4)] for i in top.indices.tolist()],
        "top1_sim":round(float(top.values[0]),4),
        "margin_1_2":round(float(top.values[0]-top.values[1]),4),
        "softmax_top1":round(float(ptop.values[0]),3),
        "softmax_entropy":round(float(-(probs*torch.log(probs+1e-12)).sum()),3),
    }
json.dump(out,open(os.path.join(HERE,"top20.json"),"w"),indent=1)
print("wrote top20.json")
