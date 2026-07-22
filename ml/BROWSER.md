# Browser feasibility: BioCLIP-2 ONNX export sizes + timing

Measured 2026-07-20. Answers "how much does the browser download, and how fast
does it run?" for the in-browser (transformers.js / onnxruntime-web) path.

## ViT-B/16 vs ViT-L/14: the smaller model is too weak

We benchmarked the smaller original BioCLIP (ViT-B/16, ~86M params, ~86 MB
int8) against ViT-L/14 on the same 27 images, same gated pipeline:

| Model | Download (int8) | top-1 | top-5 |
|---|---|---|---|
| BioCLIP-2 ViT-L/14 + gated | ~307 MB | **87%** | **96%** |
| BioCLIP ViT-B/16 + gated | ~86 MB | 70% | 74% |
| gpt-5.4-mini (reference) | 0 (API) | 83% | 87% |

ViT-B loses 17 pts top-1 / 22 pts top-5 and falls **below GPT** on both. The
4x-smaller download costs the entire advantage: there is no point shipping an
on-device model that's worse than the GPT call we already have. **Only ViT-L is
worth shipping**, because it's the only variant that beats GPT.

## 4-bit quantization: doesn't help (tested)

Hoping to roughly halve the 307 MB int8 model, we tried ONNX 4-bit weight
quantization (`MatMulNBitsQuantizer`, block_size 32 and 128):

| Model | Download | top-1 | top-5 |
|---|---|---|---|
| ViT-L int8 | 307 MB | **87%** | **96%** |
| ViT-L q4 (bs32) | 280 MB | 78% | 87% |
| ViT-L q4 (bs128) | 254 MB | ~78% | ~87% |
| gpt-5.4-mini | 0 (API) | 83% | 87% |

Both outcomes are disqualifying:
1. **Size barely moves.** 254-280 MB vs int8's 307 MB (~10-17% smaller), nowhere
   near the ~151 MB the weight math implies (1212 MB of the 1216 MB total is 2D
   matmul weight). ONNX 4-bit MatMul carries per-block scale/zero-point overhead
   and doesn't convert every op in this ViT export.
2. **Accuracy drops to GPT's level (78/87).** 4-bit rounding erodes the
   fine-grained margins between similar species that are BioCLIP's whole edge.

So q4 is a slightly-smaller, meaningfully-worse model. **int8 (307 MB, 87/96)
remains the only variant worth shipping.**

## Conclusion: the accuracy is inseparable from ~307 MB

We chased both levers for a viable web download and both failed:
- **ViT-B/16 (86 MB):** 70/74, too weak.
- **ViT-L q4 (254-280 MB):** 78/87, barely smaller and too weak.
- **ViT-L int8 (307 MB):** 87/96, the only good one.

There is no free lunch here: the accuracy that beats GPT requires ~307 MB.
The only path to "small AND accurate" is **knowledge distillation** (train a
small student on bird data to mimic ViT-L), which is a multi-day training
project, not a spike. Flagged, not attempted.

**Final recommendation:**
- **iOS: ship ViT-L int8 via Core ML** (307 MB bundled is fine; strong play).
- **Web: keep GPT**, optionally add a background-prefetch + cached-int8 hybrid
  later (on-device when warm, GPT when cold). Not a spike-sized change and
  rough on cold mobile, so lower priority than iOS.

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

307 MB is the headline problem for the **web** app. But ViT-B (86 MB) is too
weak (70/74, below GPT), so the download can't simply be shrunk away. That
collapses the decision:

- **iOS: ship ViT-L via Core ML.** On-device, offline, free, beats GPT
  (87/96). 307 MB is a non-issue as a bundled app asset; the Neural Engine
  runs ViT-L fine. **This is the strong play.**
- **Web: keep GPT.** A 307 MB first-visit download is a bad experience, ViT-B
  is too weak to replace GPT, and a BioCLIP *server* has no advantage over the
  GPT call already wired (see below). So web stays as-is.
- **Cloudflare Workers AI: no.** Fixed catalog, only generic CLIP (the base
  model BioCLIP was retrained from) - weaker than GPT at fine-grained bird ID.
  No bring-your-own-weights for a 307 MB custom ONNX.

### Why not a BioCLIP inference server?

Moving BioCLIP to a server (Cloudflare Containers, Modal, Replicate, a VPS)
removes its entire reason to exist. On-device it's free/offline/private; on a
server it's just another hosted model competing with GPT - and GPT wins on
server deployment (zero infra, zero cold starts, already integrated, comparable
accuracy). Only build a server path if you specifically need identical
web+iOS results without a 300 MB web download, a niche GPT-on-web already
covers.

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
Export script: `ml/scripts/export-onnx.py`
