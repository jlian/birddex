import time, torch, open_clip, torch.nn.functional as F
torch.backends.cuda.matmul.allow_tf32 = True
torch.backends.cudnn.allow_tf32 = True
m, _, _ = open_clip.create_model_and_transforms("MobileCLIP-S2", pretrained="datacompdr")
v = m.visual.cuda().train()
proj = torch.nn.Linear(512, 768).cuda()
opt = torch.optim.AdamW(list(v.parameters()) + list(proj.parameters()), lr=1e-4)
sc = torch.amp.GradScaler("cuda")
vc = torch.compile(v, mode="reduce-overhead")
print("torch.compile reduce-overhead, MobileCLIP-S2 train, batch 64, 8 steps:", flush=True)
for i in range(8):
    x = torch.randn(64, 3, 256, 256, device="cuda")
    tg = F.normalize(torch.randn(64, 768, device="cuda"), dim=-1)
    t0 = time.time()
    with torch.amp.autocast("cuda"):
        p = F.normalize(proj(vc(x)), dim=-1)
        loss = (1 - (p * tg).sum(-1)).mean()
    opt.zero_grad(set_to_none=True)
    sc.scale(loss).backward()
    sc.step(opt)
    sc.update()
    torch.cuda.synchronize()
    print(f"  step {i} {time.time()-t0:.2f}s (0-2 = compile warmup)", flush=True)
print("DONE", flush=True)
