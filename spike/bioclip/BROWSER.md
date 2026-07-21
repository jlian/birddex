# Browser feasibility: BioCLIP-2 ONNX export sizes + timing

Measured 2026-07-20. Answers "how much does the browser download, and how fast
does it run?" for the in-browser (transformers.js / onnxruntime-web) path.

## Model download size (image encoder only)

BioCLIP-2 is a CLIP **ViT-L/14** (~300M params). Exported image encoder:

| Format | Size | Notes |
|---|---|---|
| fp32 ONNX | 1217 MB | reference; too big to ship |
| fp16 ONNX | 609 MB | still very heavy |
| **int8 ONNX** | **307 MB** | dynamic quant; max abs diff vs torch 1.8e-2 |

Plus the precomputed text-label matrix (11,167 species x 768 dims), shipped
once so the browser never runs the text encoder:

| Format | Size |
|---|---|
| fp32 `.npy` | 34.3 MB |
| int8 (+per-row scale) | 8.6 MB |
| **int8 gzipped** | **7.9 MB** |

**Total realistic download (int8 encoder + int8 text matrix): ~315 MB**,
cached after first load (Cache Storage / IndexedDB). That's a big first-visit
hit for a web app.

## Inference speed (proxy)

ONNX CPU on an 8-core Ryzen (browser numbers will differ):

| Format | ms/image |
|---|---|
| fp32 | 508 |
| int8 | 325 |

- Browser **WASM** (onnxruntime-web CPU) is typically ~2-4x slower than native
  CPU here, so expect ~0.7-1.3s/image int8 on WASM.
- Browser **WebGPU** is typically several x faster and is the intended path;
  realistically a few hundred ms/image once the model is resident. (Not yet
  measured in an actual browser; needs the demo page.)
- Text side is free at inference (one cached matrix multiply: image embed x
  11,167x768). The range/gate logic is negligible.

## Verdict / options

307 MB is the headline problem for the web app. Options, roughly:

1. **Ship ViT-L int8 (307 MB), cache aggressively.** Best accuracy (the 87/96
   we measured). Painful first load; fine for a returning-user PWA, rough for
   first impressions. Consider lazy-loading only when the user first hits the
   ID flow, with a clear progress UI.
2. **Use the smaller original BioCLIP (ViT-B/16, ~86M).** ~86 MB int8, ~4x
   smaller download and faster, but lower accuracy (needs its own benchmark
   run; ViT-B was not tested here). Likely the pragmatic web default.
3. **Distill / prune** a smaller student from ViT-L on bird data. Best of both,
   but real work.
4. **Web stays on GPT; on-device is iOS-only (Core ML).** The 307 MB is a
   non-issue as a bundled app asset on iOS (Neural Engine runs ViT-L fine).
   Web keeps the current GPT path. This sidesteps the download problem
   entirely and may be the cleanest split.

## Next steps

- **Demo page** (Cloudflare Pages preview): load int8 ONNX via onnxruntime-web
  + WebGPU, run the 27 benchmark images in-browser, show real load time +
  per-image latency + the ID with range/gate applied. This is the "see it work
  for kind-of real" milestone and gives true browser numbers.
- **Benchmark ViT-B/16** on our set to quantify the accuracy cost of the
  smaller (86 MB) model, since that decides whether the web path is viable at
  all or should stay on GPT.
- **Core ML export** for the iOS path (ViT-L is fine bundled on-device).

## Artifacts (on tomahawk, not committed - too large)

`~/spikes/bioclip-birdid/onnx-export/`:
- `bioclip2_visual_{fp32,fp16,int8}.onnx`
- `text_embeds_{fp32,int8}.npy`, `text_embeds_scale.npy`
Export script: `spike/bioclip/scripts/export-onnx.py`
