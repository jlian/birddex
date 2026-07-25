import time, torch, open_clip, torch.nn.functional as F
torch.backends.cuda.matmul.allow_tf32 = True
torch.backends.cudnn.allow_tf32 = True
torch.backends.cudnn.benchmark = True
m, _, _ = open_clip.create_model_and_transforms("MobileCLIP-S2", pretrained="datacompdr")
v = m.visual.cuda().train().to(memory_format=torch.channels_last)
proj = torch.nn.Linear(512, 768).cuda()
opt = torch.optim.AdamW(list(v.parameters()) + list(proj.parameters()), lr=1e-4)
sc = torch.amp.GradScaler("cuda")
print("channels_last MobileCLIP-S2 train fwd+bwd, batch 64:", flush=True)
for i in range(6):
    x = torch.randn(64, 3, 256, 256, device="cuda").to(memory_format=torch.channels_last)
    tg = F.normalize(torch.randn(64, 768, device="cuda"), dim=-1)
    t0 = time.time()
    with torch.amp.autocast("cuda"):
        p = F.normalize(proj(v(x)), dim=-1)
        loss = (1 - (p * tg).sum(-1)).mean()
    opt.zero_grad(set_to_none=True)
    sc.scale(loss).backward()
    sc.step(opt)
    sc.update()
    torch.cuda.synchronize()
    print(f"  step {i} {time.time()-t0:.2f}s", flush=True)
print("DONE", flush=True)
