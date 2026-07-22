# In-browser adaptive router demo

A working proof of the **adaptive router**: one shared bird-ID pipeline with a
swappable front-end (on-device BioCLIP-2 when available, GPT fallback
otherwise), so there's **no divergent per-platform pipeline**.

## What it demonstrates

- Loads **BioCLIP-2 ViT-L int8 (307 MB)** in the browser via onnxruntime-web +
  WebGPU (WASM fallback).
- **Background prefetch** with live download-speed + ETA measurement.
- **Persistent cache** (Cache API): first visit downloads, later visits are
  instant.
- **Adaptive routing:** if the model is ready -> on-device BioCLIP; if not ->
  GPT fallback (server), while prefetch continues for next time.
- **Confidence gate:** softmax_top1 < 0.6 flags ambiguous/multi-bird images for
  manual crop (replaces GPT's `multipleBirds`).
- The image encoder runs on-device; the 11k text-label embeddings are shipped
  once as an 8.6 MB int8 matrix, so inference is `encode(image)` + one matmul.

## Files

- `index.html` - UI
- `router.js` - the router: prefetch, speed measurement, cache, WebGPU
  inference, int8 text-matmul, softmax gate, GPT fallback stub
- `serve.mjs` - static server with COOP/COEP headers (required by ort-web)
- `models/` - not committed (307 MB); see "Assets" below

## Run it

```bash
# regenerate model + text assets (needs GPU box):
#   ml/scripts/export-onnx.py       -> bioclip2_visual_int8.onnx
#   ml/scripts/gen-demo-assets.py   -> text_embeds_int8.bin, _scale.bin, species.json
# place all four in ml/demo/models/, then:
node ml/demo/serve.mjs ml/demo 8770
# open http://localhost:8770 in Chrome/Edge (WebGPU), click "Start background prefetch"
```

## What's verified vs pending

**Verified** (via `validate_node.js`, onnxruntime same API as the browser):
- The exported int8 ONNX model loads and produces correct, faithful embeddings.
- Full inference path works: preprocess -> image encoder -> int8 text-matmul ->
  softmax -> candidates. Raw accuracy 74/83 pre-range (matches the PyTorch
  model, i.e. the export is faithful; the gated+range pipeline lifts this to
  87/96 as measured separately).
- CPU inference: **~335 ms/image** (onnxruntime-node, 8-core Ryzen).

**Pending** (needs a real WebGPU browser session; the tomahawk browser-node
proxy wasn't connected during this spike):
- Actual WebGPU inference latency in-browser (expected several x faster than
  the 335 ms CPU number; WASM fallback ~0.7-1.3 s).
- Real end-to-end download+cache timing in a browser tab.
- Cloudflare Pages preview deployment (would host `models/` on the CDN with
  range requests + brotli).

## Routing logic (the anti-divergence point)

The whole reason this isn't a divergent pipeline: BioCLIP and GPT both emit
`{species, confidence}[]`, and the **entire post-processing path is shared**
(taxonomy grounding -> range tiering -> confidence gate). The router only
swaps which model produces the candidate list:

```
model cached?          -> BioCLIP on-device (instant, free, offline)
not cached, fast/wifi   -> GPT now + background prefetch, switch when ready
not cached, slow/metered-> GPT; optionally offer "download ~300MB for offline"
```

`navigator.connection` is used as a hint where available (Chrome/Android) but
the router primarily **measures actual download speed** while streaming, since
Safari/Firefox don't expose it.

## Honest caveat

307 MB cold on mobile data is still a rude first-visit download; realistic UX
is "GPT by default, on-device once cached" (a hybrid), not pure on-device.
Knowledge distillation to a ~40-80 MB bird-only student would make this a
much easier sell, but that's a separate multi-day project (see BROWSER.md).
