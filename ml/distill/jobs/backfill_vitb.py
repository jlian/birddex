import glob, os, torch
src = torch.load('runs/full7555_vitb/best.pt', map_location='cpu')
sa = src.get('args', {}) or {}
arch = sa.get('arch'); pre = sa.get('pretrained')
print('source:', arch, pre)
if not arch: raise SystemExit('no arch in source')
for p in sorted(glob.glob('runs/ft_clean_01/*.pt')) + sorted(glob.glob('runs/ft_clean_02/*.pt')) + sorted(glob.glob('runs/ft_full7555_gt/*.pt')):
    c = torch.load(p, map_location='cpu')
    if 'model' not in c: continue
    a = dict(c.get('args', {}) or {})
    if a.get('arch'): print('  ok already:', p); continue
    ks = list(c['model'].keys())
    if not any(k.startswith('visual.transformer.resblocks.') for k in ks):
        print('  SKIP not open_clip-style:', p); continue
    a['arch'] = arch
    if pre: a['pretrained'] = pre
    c['args'] = a
    torch.save(c, p)
    print('  stamped:', p)
print('done')
