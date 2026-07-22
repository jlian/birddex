#!/usr/bin/env python3
"""Emit BioCLIP candidates in WingDex fixture shape (parsed.candidates with
commonName/scientificName/confidence) so the real simulatePipeline() can run.
Confidence = softmax over cosine sims (temp 0.01), top-8 per image."""
import json, os, glob, torch, open_clip
from PIL import Image
import torch.nn.functional as F

HERE=os.path.dirname(os.path.abspath(__file__))
taxo=json.load(open(os.path.join(HERE,"taxonomy.json")))
commons=[r[0] for r in taxo]; scis=[r[1] for r in taxo]
device="cuda"
model,_,preprocess=open_clip.create_model_and_transforms("hf-hub:imageomics/bioclip-2")
tok=open_clip.get_tokenizer("hf-hub:imageomics/bioclip-2")
model=model.to(device).eval()
tf=[]
with torch.no_grad():
    for i in range(0,len(commons),512):
        b=[f"a photo of {commons[j]}, {scis[j]}, a species of bird." for j in range(i,min(i+512,len(commons)))]
        e=model.encode_text(tok(b).to(device)); e/=e.norm(dim=-1,keepdim=True)
        tf.append(e.float().cpu())
tf=torch.cat(tf).to(device)

# context (lat/lon/month) mirrors capture-llm-fixtures IMAGES array
CTX=json.load(open(os.path.join(HERE,"context.json")))
os.makedirs(os.path.join(HERE,"bioclip-fixtures-full"),exist_ok=True)
for path in sorted(glob.glob(os.path.join(HERE,"images","*"))):
    fn=os.path.basename(path)
    img=preprocess(Image.open(path).convert("RGB")).unsqueeze(0).to(device)
    with torch.no_grad():
        f=model.encode_image(img); f/=f.norm(dim=-1,keepdim=True); f=f.float()
        sims=(f@tf.T).squeeze(0)
    probs=F.softmax(sims/0.01,dim=0)
    top=torch.topk(probs,50)
    cands=[]
    for idx,p in zip(top.indices.tolist(),top.values.tolist()):
        cands.append({"commonName":commons[idx],"scientificName":scis[idx],
                      "confidence":round(float(p),4),"plumage":None})
    ctx=CTX.get(fn,{})
    fx={"imageFile":fn,"context":ctx,"parsed":{"candidates":cands,"birdCenter":None,
        "birdSize":None,"multipleBirds":False},"model":"bioclip-2"}
    out=os.path.join(HERE,"bioclip-fixtures-full",fn.rsplit(".",1)[0]+".json")
    json.dump(fx,open(out,"w"),indent=1)
print("wrote bioclip-fixtures-full/")
