# Distillation: small (<25 MB) bird-only student from BioCLIP-2

Tracks issue [#260](https://github.com/jlian/wingdex/issues/260). Follow-up to the
spike in [`../README.md`](../README.md) and [`../BROWSER.md`](../BROWSER.md), which
established:

- BioCLIP-2 ViT-L/14 int8 (307 MB) + gated range pipeline = **87/96** (beats GPT 83/87).
- ViT-B/16 (86 MB) = 70/74, q4 ViT-L (254-280 MB) = 78/87. Both too weak.
- **Only distillation** can get "small AND accurate". This directory is that attempt.

## Definition of done (from the issue)

- [ ] iNat bird image corpus assembled + preprocessed
- [ ] Teacher soft-target generation pipeline
- [ ] Distilled student trained + quantized + ONNX/Core ML export
- [ ] Benchmarked vs GPT and ViT-L on the shared gated+range pipeline
- [ ] Go/no-go writeup: does a <25 MB (or <86 MB) student beat GPT?

## Phase plan

### Phase 1 - corpus (in progress)

Assemble an openly-licensed iNaturalist bird image corpus, keyed to WingDex's
own taxonomy (`src/lib/taxonomy.json`, 11,167 species) so student class indices
line up with the app.

Scripts:
- `select_species.py` - pick the target species set (start: N most-photographed
  / app-relevant; the long tail can be added later). Emits `species.json`
  (`[{idx, common, scientific, inat_taxon_id, photo_count}]`).
- `download_inat.py` - resumable, rate-limited iNat downloader. Research-grade,
  CC-licensed photos only. Writes `corpus/<taxon_id>/<photo_id>.jpg` + a
  `manifest.jsonl` row per image (license, observer, obs id, photo url) for the
  license audit.

Design constraints:
- **Respect iNat API limits**: <=60 req/min, target well under 10k req/day.
  `--sleep` between calls, resumable via on-disk manifest so we can run in
  chunks across days without re-fetching.
- **License audit ready**: every downloaded image records its license +
  attribution so the eventual open-weight release can be cleared.

### Phase 2 - teacher soft targets

Reuse the exact BioCLIP-2 teacher setup from `../scripts/spike-zeroshot.py`
(open_clip `hf-hub:imageomics/bioclip-2`). For each corpus image, cache the
ViT-L image embedding (768-d) and/or the softmax-over-target-species
distribution. Embedding caching = distill on the CLIP embedding (recommended:
model-agnostic, lets us swap the student head later).

### Phase 3 - student train + export

MobileNetV3 / EfficientNet-lite image encoder -> project to 768-d, cosine/KL
distill against cached teacher embeddings. Then int8 (maybe int4) + ONNX +
Core ML export. Target <25 MB encoder (stretch), <86 MB fallback.

### Phase 4 - benchmark + writeup

Run the student through the **same** gated+range pipeline
(`../scripts/pipeline-experiment.mjs`) on the 27-image set + a larger held-out
set. Compare top-1/top-5 vs GPT (83/87) and ViT-L (87/96). Go/no-go.

## Working location

Heavy work runs on **tomahawk** (RTX 3080) under the existing spike venv
`~/spikes/bioclip-birdid/.venv` (torch 2.6.0+cu124, open_clip 3.3.0). Scripts
live here in-repo; corpus/artifacts stay on tomahawk (too large to commit).
</content>
