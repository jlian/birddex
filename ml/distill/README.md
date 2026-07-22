# Distillation: small (<25 MB) bird-only student from BioCLIP-2

Tracks issue [#260](https://github.com/jlian/wingdex/issues/260). Follow-up to the
spike in [`../README.md`](../README.md) and [`../BROWSER.md`](../BROWSER.md), which
established:

- BioCLIP-2 ViT-L/14 int8 (307 MB) + gated range pipeline = **87/96** (beats GPT 83/87).
- ViT-B/16 (86 MB) = 70/74, q4 ViT-L (254-280 MB) = 78/87. Both too weak.
- **Only distillation** can get "small AND accurate". This directory is that attempt.

## Definition of done (from the issue)

- [x] iNat bird image corpus assembled + preprocessed
- [x] Teacher soft-target generation pipeline (cached 768-d embeddings)
- [ ] Distilled student trained + quantized + ONNX/Core ML export
- [ ] Benchmarked vs GPT and ViT-L on the shared gated+range pipeline
- [ ] Go/no-go writeup: does a <25 MB (or <86 MB) student beat GPT?

## Phase plan

### Phase 1 - corpus (done)

Assemble an openly-licensed iNaturalist bird image corpus, keyed to WingDex's
own taxonomy (`src/lib/taxonomy.json`, 11,167 species) so student class indices
line up with the app.

**Approach (pivoted 2026-07-21): iNaturalist AWS Open Data, not the rate-limited
iNat API.** The public S3 bucket (`inaturalist-open-data`) ships taxa /
observations / photos as `csv.gz` metadata dumps plus static photo objects, so
we join in DuckDB and pull images over plain parallel HTTPS (no 60 req/min API
cap). This is why the corpus landed in hours, not days.

Pipeline scripts (run in order, all live here + on tomahawk):
- `fetch_metadata.py` - resumable HTTPS pull of the iNat Open Data
  taxa/observations/photos `csv.gz` dumps.
- `build_manifest.py` - DuckDB join (photos -> observations -> taxa), filter to
  target bird taxa + open licenses, apply per-species floor/cap, emit
  `manifest.parquet` + `target_taxa.csv` + `manifest_stats.txt`.
- `pull_images.py` - parallel S3 image fetch (32 workers, resumable: skips
  files already on disk, re-run to retry gaps). Writes
  `corpus/<inat_taxon_id>/<photo_id>.<ext>` + `download_manifest.jsonl`
  (license/observer/GPS per image, for the license audit) + `failures.log`.
- `build_cooccurrence.py` - grid-cell species co-occurrence from corpus GPS,
  for training-time hard-example weighting on confusable+co-occurring pairs.
- `prep_training_set.py` - emit `train_manifest.parquet` (ShareAlike EXCLUDED by
  default for the MIT weight release; `--keep-sharealike` for a research
  variant) + `ATTRIBUTIONS.md` + `attributions.csv` (CC-BY attribution).
- `select_species.py`, `download_inat.py`, `lic_query.py` - earlier
  API-era / license-exploration helpers, kept for reference.

Final corpus (2026-07-22): floor=50 / cap=500 -> 7,555 species, 2,646,057
manifest rows, ~2.645M images on disk (~262 GB); the ~272 misses are
iNat-deleted 404s. 2,503,107 images kept after ShareAlike exclusion.

Design constraints:
- **Resumable everywhere**: every stage skips completed work via on-disk state,
  safe to re-run to fill gaps.
- **License audit ready**: every image records its license + attribution so the
  open-weight release can be cleared.

### Phase 2 - teacher soft targets (done)

Reuse the exact BioCLIP-2 teacher setup from `../scripts/spike-zeroshot.py`
(open_clip `hf-hub:imageomics/bioclip-2`). For each corpus image, cache the
ViT-L image embedding (768-d). Embedding caching = distill on the CLIP embedding
(model-agnostic, lets us swap the student head later).

Scripts:
- `precompute_embeddings.py` - batched GPU forward of the frozen teacher over
  on-disk corpus images, writes `embeddings/shard_*.npz` (keys: `photo_ids`
  int64, `embeddings` float16 [N,768], L2-normalized). Catch-up mode: skips
  already-embedded ids, so it overlaps the download.
- `embed_loop.sh` - self-relaunching bash loop that runs `precompute_embeddings`
  back-to-back so the GPU stays busy catching up with the pull; self-exits once
  the pull is done AND a pass adds no new embeddings.

Done 2026-07-22: 366 shards, ~2.644M embeddings, full corpus coverage.

### Phase 3 - student train + export (in progress)

**Student arch = MobileCLIP** (Apple, open_clip `MobileCLIP-S2`/`datacompdr`),
CoreML-ready for iOS and ONNX/WebGPU-ready for browser from one set of weights.
The MobileCLIP visual tower -> linear projection into the teacher's 768-d space,
trained with **cosine loss** against the cached teacher embeddings (feature
distillation, DataCompDR-style). Because the student is trained INTO the teacher
embedding space, the existing BioCLIP-2 text classifier works on it unchanged.
Then int8 (maybe int4) + ONNX + Core ML export. Target <25 MB encoder (stretch),
<86 MB fallback.

Script:
- `train_student.py` - the distillation trainer. Loads teacher embeddings by
  `photo_id`, streams corpus images through the MobileCLIP student, cosine loss,
  AdamW + cosine LR schedule, AMP. **Pilot-first**: `--pilot-species 500`
  trains on the top-N most-photographed species (fail fast) before the full
  7,555 (`--pilot-species 0`). `--smoke` runs a 3-species / 2-step end-to-end
  self-test. Checkpoints to `--out` (`last.pt`).

Two proven add-ons planned once the baseline works: (A) MobileCLIP arch for
deploy-readiness [in], (B) range/co-occurrence hard-example loss weighting via
`build_cooccurrence.py` output.

Status 2026-07-22: `train_student.py` written + smoke-tested on the 3080;
500-species pilot next.

### Phase 4 - benchmark + writeup

Run the student through the **same** gated+range pipeline
(`../scripts/pipeline-experiment.mjs`) on the 27-image set + a larger held-out
set. Compare top-1/top-5 vs GPT (83/87) and ViT-L (87/96). Go/no-go.

**Eval anchors (decided 2026-07-21):**
- **NABirds** (HF mirror `zguo0525/nabirds-dataset`, ~48K imgs / 555 NA species,
  expert labels + boxes) - primary labeled accuracy anchor, NA-focused like our
  users. Downloadable today; pull at eval time (don't compete with the resolve).
- **CUB-200-2011** (HF `syedashfaq/CUB_200_2011`, 11,788 imgs / 200 species) -
  quick FGVR sanity eval.
- **RealBirdID** (arXiv 2603.27033, CVPR'26, MIT) - *headline* abstention-aware
  benchmark, scored on BOTH species accuracy AND calibrated abstention (our
  softmax-confidence gate gives us an abstention lever GPT lacks). NOT RELEASED
  yet as of 2026-07-21 (HF `cvl-umass/RealBirdID` usedStorage=0, quickstart
  notebook is `# TODO`). Watched by cron `realbirdid-release-watch` (daily 9am);
  wire in when data lands.
- Automated in-pipeline eval stays: student vs GPT (83/87) vs BioCLIP-2 ViT-L
  (87/96) on the shared gated+range pipeline.

## Teacher (decided 2026-07-21)

**Teacher = BioCLIP-2 ViT-L/14** (open_clip `hf-hub:imageomics/bioclip-2`). It's
the only BioCLIP-2 variant that exists (built on LAION-2B CLIP ViT-L/14, MIT
license), and the SOTA open bird encoder (RealBirdID: 41% genus / 76% species).
No larger ViT-H/bigG release to chase. Teacher size is a training-time cost
only; the shipped student is unaffected.

**Ensemble / multi-teacher = deferred improvement pass.** First student is
single-teacher (BioCLIP-2, free/local) to get a baseline + confusion matrix.
Then targeted multi-teacher: GPT-5.4-mini-label ONLY the confused hard pairs
(GPT API cost, so subset not full corpus), blend BioCLIP+GPT distributions
(KL) + BioCLIP embedding (cosine), use range/co-occurrence as a training-time
sampling weight. Range stays external at inference (model-agnostic, updatable).

## Working location

Heavy work runs on **tomahawk** (RTX 3080) under the existing spike venv
`~/spikes/bioclip-birdid/.venv` (torch 2.6.0+cu124, open_clip 3.3.0).

**SSOT (single source of truth):** this repo dir (`ml/distill/` on
branch `bioclip-distill`) holds the pipeline code. The runtime working
copy is `~/spikes/bioclip-birdid/distill/` on tomahawk. Edit here, then sync to
tomahawk (`tar`/`scp`). Corpus, embeddings, manifests, logs, and checkpoints
stay OFF git (see `.gitignore`) - they're too large and are regenerable.
History note: scripts were briefly split across `bioclip-birdid` and
`bioclip-distill`; consolidated onto `bioclip-distill` 2026-07-22.
</content>
