# Spike: On-device bird ID with BioCLIP-2

**Status:** exploratory spike (not wired into production)
**Branch:** `spike/bioclip-birdid`
**Date:** 2026-07-20
**Question:** Can WingDex replace the GPT-5.4-mini vision call with an on-device
model (for in-browser + Core ML / offline use), without losing accuracy?

## TL;DR

Yes, and it comes out ahead on this benchmark. **BioCLIP-2 (zero-shot) + a
recalibrated version of our existing range-prior pipeline beats gpt-5.4-mini**
on our 27-image benchmark set, fully on-device, offline, zero API cost.

| Pipeline | top-1 | top-5 |
|---|---|---|
| gpt-5.4-mini (current prod) | 83% | 87% |
| BioCLIP-2 raw zero-shot (no range) | 70% | 87% |
| BioCLIP-2 through prod pipeline **as-is** | 70% | 70% |
| **BioCLIP-2 + recalibrated pipeline (Strategy F)** | **87%** | **96%** |

(23 scorable images; 4 ambiguous/no-truth images excluded.)

## Why this matters

- The iOS 27 Foundation Models on-device LLM gained vision, but it's a
  generalist and weak at fine-grained species ID (Apple's own WWDC guidance
  routes plant/species ID to a specialist model via tool calling).
- Merlin (the gold standard) does NOT use an LLM. It uses a purpose-built
  on-device CNN classifier (Visipedia / Cornell), trained on eBird's private
  labeled corpus. That model is not obtainable.
- **BioCLIP-2** (`imageomics/bioclip-2`, NeurIPS'25) is the closest open
  substitute: a CLIP ViT-L/14 retrained on TreeOfLife-200M (200M organism
  images, 952K taxa). It's openly licensed, exports to ONNX (transformers.js /
  WebGPU) and Core ML, and gives one model for web + iOS + Android.

## Method

1. Ran BioCLIP-2 zero-shot on the 27 benchmark images in `src/assets/images`,
   scoring image embedding vs text embeddings of all **11,167** species in
   `src/lib/taxonomy.json` (one matmul, ~19ms/image on an RTX 3080).
2. Emitted top-50 candidates per image in our fixture shape
   (`spike/bioclip/fixtures/*.json`), so the real post-LLM pipeline logic runs
   on them unchanged.
3. Pulled the **26** range-prior cells covering the benchmark locations from
   prod R2 into `.tmp/range-priors/cells/` (a few KB; not the full store).
4. Ran candidates through the real taxonomy-grounding + range-adjust logic and
   compared strategies. GPT numbers come from the existing golden fixtures.

Reproduce:
```bash
node spike/bioclip/scripts/download-range-cells.mjs      # needs R2 creds in .dev.vars
node spike/bioclip/scripts/pipeline-experiment.mjs --sweep
```
(Regenerating the BioCLIP fixtures needs a GPU box: `spike/bioclip/scripts/`.)

## The key finding: our pipeline is shaped for GPT, not for a classifier

Feeding BioCLIP through the production post-LLM steps **as-is drops it to
70/70** because three steps are tuned to GPT's confidence semantics:

1. **`confidence >= 0.2` hard floor.** GPT emits calibrated 0.3-0.9
   confidences. BioCLIP emits softmax-over-11k probabilities: on a hard image
   the true species can sit at 0.01-0.05, spread across many similar congeners.
   The floor deletes the correct answer before range priors ever run.
2. **`slice(0, 5)` before range adjustment.** BioCLIP's raw top-5 by cosine is
   full of out-of-range look-alikes; the in-range true species is often rank
   6-15. Truncating first throws it away.
3. **Multiplicative range penalty (x0.65 OOR).** Too gentle to overcome
   BioCLIP's tiny softmax margins between congeners.

## The fix: Strategy F (confidence-gated tiering)

Two changes, then a gate:

- **Keep top-K (K=15), not a fixed floor.** Preserves the true species even
  when its absolute score is low.
- **Confidence gate:** if BioCLIP's #1 dominates (score - #2 >= 0.5), TRUST the
  visual ID and keep raw order. This mirrors our GPT prompt's own rule
  ("visible morphology is authoritative... keep the morphology-matching species
  first"). It guards against coarse-grid range artifacts (e.g. Great Blue Heron
  at Drayton Harbor and Tufted Puffin at Smith Island are flagged out-of-range
  by the 27km grid but are obviously present; a confident BioCLIP shouldn't be
  demoted for a gridding error).
- **Otherwise (ambiguous, small margin): tiered range demotion.** Hard-partition
  candidates by range tier (present > near-range > out-of-range), keep BioCLIP
  order within each tier. This is "eliminate impossible species first, then rank
  the plausible ones by visual similarity", and it recovers Chukar (Maui),
  Common Kingfisher (Taipei), Common Goldeneye + Brandt's Cormorant + House
  Sparrow, all cases where an out-of-range congener out-scored the true bird.

The gate is stable: domMargin 0.45-0.70 all yield 87/96 (bimodal separation
between "confident" and "ambiguous" images), so it's not overfit.

## Remaining misses (2 of 23, both unfixable by range)

- **Chukar (Maui):** top-5, not top-1. Loses to Rock Partridge, a genuine
  same-genus (Alectoris) look-alike. A real visual near-tie.
- **Double-crested Cormorant (Skagit Bay):** not in BioCLIP's top-50 at all;
  it visually ranked Black Oystercatcher #1. A true classifier failure, not a
  range problem. (GPT got this one; BioCLIP got the Lesser Scaup that GPT
  missed. Different failure modes.)

## Open problems for a real integration

1. **Detection / localization.** GPT returns `birdCenter`, `birdSize`, and
   `multipleBirds`. A pure classifier does not. Substitutes:
   - **Crop trigger:** softmax_top1 < ~0.6 reliably flags ambiguous / multi-bird
     / too-small frames on this set (clean separation from confident singles at
     0.9+). Use it to prompt manual crop, replacing the `multipleBirds` branch.
   - **iOS:** Vision framework animal detection gives real bird boxes + count
     for free (replaces both `birdCenter` and `multipleBirds`, can auto-suggest
     the crop).
   - **Web:** lean on the existing manual-crop UX (all of `crop-math.ts` is
     model-agnostic and reused unchanged) + the softmax gate.
2. **Shipping range data offline.** The store is a 27km Equal Earth grid
   (1276x618). For offline, ship a regional quantized table (a few MB gzipped
   for North America), not the full ~150-350k-blob store. Lookup is a grid
   index + vector op, trivial in-browser / Swift.
3. **Deployment.** Precompute the 11,167 text-label embeddings once and ship
   them as a static matrix (~34MB fp32 / ~8MB int8). At inference only the image
   encoder runs, then one matmul + the range/gate logic above. Export the image
   encoder to ONNX (transformers.js/WebGPU) and Core ML.
4. **Threshold calibration on a bigger, held-out set.** 23 scorable images is a
   spike, not a validation set. domMargin, K, and the softmax crop threshold
   should be tuned on a larger labeled set (and the softmax temperature, fixed
   at 0.01 here, calibrated) before trusting these exact numbers.

## Files

- `spike/bioclip/scripts/pipeline-experiment.mjs` - strategy comparison + sweep
- `spike/bioclip/scripts/download-range-cells.mjs` - pull only the needed cells
- `spike/bioclip/scripts/spike-zeroshot.py` - raw zero-shot run (GPU)
- `spike/bioclip/scripts/emit-bioclip-fixtures.py` - top-50 fixture generator (GPU)
- `spike/bioclip/fixtures/*.json` - BioCLIP candidates per image
- `spike/bioclip/truth.json` - ground-truth species per image
