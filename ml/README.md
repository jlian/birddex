# WingDex on-device bird ID: BioCLIP-2 spike → distilled student

**Single source of truth** for the on-device / offline bird-ID effort. This one
doc replaces the former `ml/README.md`, `ml/BROWSER.md`, `ml/distill/README.md`,
`ml/distill/METHOD.md`, and `ml/demo/README.md` (consolidated 2026-07-23 so the
queue and status are impossible to miss).

Tracks issue [#260](https://github.com/jlian/wingdex/issues/260). Branch:
`bioclip-distill`.

---

## STATUS + QUEUE (read this first)

🔵 **In progress.** Full 7,555-species **ViT-B/16** baseline distillation run is
training on the RTX 3080.

**Working locations (see "Where things live" at bottom, there are 3 code copies):**
- Edit code/docs in the Pi git repo `~/wingdex/ml/`.
- Training runs on tomahawk in the loose scratch dir `~/spikes/bioclip-birdid/`.

### Queue (ordered; corrected 2026-07-23)

- [x] Phase 1 — corpus assembled (iNat AWS Open Data, 7,555 sp, 2.65M imgs / 262 GB)
- [x] Phase 2 — teacher embeddings cached (366 shards, ~2.644M × 768-d)
- [x] Pilot: 500-species ViT-B/16 (val_cos 0.946; 99% OOD retention on NABirds)
- [ ] **Full 7,555-species ViT-B/16 baseline run** ← *in progress* (epoch ~7, val_cos ~0.9505)
- [ ] **Pilot experimentation stage (500 sp) — BOTH recipes locked here:**
  - [ ] distillation-recipe sweep: batch 96 × LR {5e-5, 7e-5, 1e-4}, aug, resolution, epochs
  - [ ] **co-occurrence hard-example weighting** wired into `train_student.py` + tested (built but NOT yet integrated)
  - [ ] **ground-truth fine-tune recipe** (see below) — same cheap-iteration harness
- [ ] Build **leak-free held-out ground-truth set** (sampler script, NOT built yet — see "Ground-truth fine-tune")
- [ ] One more full ViT-B run *only if* the sweep beats baseline meaningfully
- [ ] Re-benchmark **MobileCLIP-S2 (FastViT)** training speed on the 3080 (the ~17s/step figure is suspect — see caveats)
- [ ] Final **MobileCLIP-S2** production run with locked recipe (3080 if viable, else torch.compile / rented cloud GPU)
- [ ] Apply the proven fine-tune recipe to the shipped MobileCLIP student
- [ ] Phase 4 — benchmark vs GPT (83/87) + ViT-L (87/96) on shared gated+range pipeline; go/no-go writeup
- [ ] Export: int8 + ONNX + Core ML; demo page real WebGPU numbers
- [ ] Move 262GB corpus to NAS (keep ~4GB embeddings + checkpoints); clean up tomahawk code copies

**Definition of done (from #260):** distilled student trained + quantized +
ONNX/Core ML export; benchmarked vs GPT and ViT-L on the shared gated+range
pipeline; go/no-go writeup: does a <25 MB (or <86 MB) student beat GPT?

### Why the sweep is queued AFTER the baseline (not before)

The pilot came out strong (0.946), so rather than restart, we let the full run
continue at the default recipe (LR 1e-4) to get a clean baseline checkpoint
first. The sweep was **deferred, not cancelled.** Sweeps + fine-tune experiments
run on the cheap **500-species pilot subset** (fast iteration, cached eval, early
stopping), NOT the full corpus — you only pay for the full/production run once,
with the winning recipe locked in. Guard against the "shipped baseline, never
went back" failure: if the baseline has a visible weakness (overfit drift,
co-occurring-species confusion), the pilot sweep is where you fix it before the
expensive MobileCLIP cloud run.

---

## The problem

WingDex needs on-device (iOS + browser) bird species ID. The best open teacher,
**BioCLIP-2** (ViT-L/14, ~428M params, ~1.7GB), is far too big to ship on a
phone. GPT-4.1-mini vision (the current WingDex identifier) is accurate (~83/87
top-1/5 on our golden set) but is a paid API call per photo, needs a network
round-trip, and gives no calibrated "I'm not sure" signal. We want a small
(<25MB stretch / <86MB fallback), fast, offline model that keeps most of
BioCLIP-2's accuracy AND can abstain when unsure.

### Why on-device, why BioCLIP-2

- iOS 27 Foundation Models on-device LLM gained vision, but it's a generalist and
  weak at fine-grained species ID (Apple's own WWDC guidance routes plant/species
  ID to a specialist via tool calling).
- Merlin (the gold standard) does NOT use an LLM: purpose-built on-device CNN
  (Visipedia/Cornell) trained on eBird's private corpus. Not obtainable.
- **BioCLIP-2** (`imageomics/bioclip-2`, NeurIPS'25) is the closest open
  substitute: CLIP ViT-L/14 retrained on TreeOfLife-200M (200M organism images,
  952K taxa). Openly licensed (MIT), exports to ONNX + Core ML, one model for
  web + iOS + Android. SOTA open bird encoder (RealBirdID: 41% genus / 76% species).

---

## Spike findings (Phase 0, 2026-07-20) — why distillation is the only path

### Zero-shot BioCLIP-2 + recalibrated range pipeline beats GPT

On the 27-image benchmark (`src/assets/images`), scoring image embedding vs text
embeddings of all 11,167 species in `src/lib/taxonomy.json`:

- gpt-5.4-mini (current prod): 83% / 87%
- BioCLIP-2 raw zero-shot (no range): 70% / 87%
- BioCLIP-2 through prod pipeline **as-is**: 70% / 70%
- **BioCLIP-2 + recalibrated pipeline (Strategy F): 87% / 96%**

(23 scorable images; 4 ambiguous excluded.)

**Our pipeline was shaped for GPT, not a classifier.** As-is it drops BioCLIP to
70/70 because three steps are tuned to GPT's confidence semantics:
1. `confidence >= 0.2` hard floor — deletes the true species (BioCLIP softmax
   over 11k puts hard-image truth at 0.01–0.05).
2. `slice(0, 5)` before range adjustment — throws away the in-range true species
   sitting at rank 6–15.
3. Multiplicative range penalty (×0.65 OOR) — too gentle for BioCLIP's tiny
   softmax margins.

**Strategy F (confidence-gated tiering)** fixes it: keep top-K (K=15) not a fixed
floor; if #1 dominates (score − #2 ≥ 0.5) TRUST the visual ID and keep raw order;
otherwise hard-partition by range tier (present > near-range > out-of-range),
keep BioCLIP order within each tier. Stable across domMargin 0.45–0.70 (all 87/96,
not overfit).

**Range-data bug found (benefits prod too):** `nearestNeighborCell` in
`functions/lib/range-filter.ts` / `range-adjust.js` only checks ONE neighbor
(nearest edge), never diagonals/other edges, so coastal/boundary points get
wrongly flagged out-of-range. Fix = scan the full 3×3 ring (`lookupRangeExpanded`,
first hit → near-range). **Follow-up independent of BioCLIP: port this into
`functions/lib/range-filter.ts`.**

Remaining misses (2/23, unfixable by range): Chukar@Maui (loses to same-genus
Rock Partridge, real visual near-tie); Double-crested Cormorant@Skagit (not in
top-50, true classifier failure).

### Browser feasibility: accuracy is inseparable from ~307 MB

Measured 2026-07-20 (image encoder, ONNX):
- ViT-L/14 int8: **307 MB → 87/96** (only variant that beats GPT)
- ViT-B/16 int8: 86 MB → 70/74 (below GPT, too weak)
- ViT-L q4 (bs32/128): 254–280 MB → 78/87 (barely smaller, accuracy drops to GPT
  level; 4-bit rounding erodes the fine-grained margins that are BioCLIP's edge)

fp32 ONNX 1217 MB / fp16 609 MB / int8 307 MB (max abs diff vs torch 1.8e-2).
Plus text-label matrix (11,167×768): int8 gzipped **7.9 MB** (shipped once, so the
browser never runs the text encoder). Realistic int8 download ~315 MB.

Inference (ONNX CPU, 8-core Ryzen): fp32 508 ms/img, int8 325 ms/img. Browser
WASM ~2–4× slower (~0.7–1.3 s int8); WebGPU is the intended path (few hundred ms,
not yet measured in a real browser).

**Verdict:** iOS → ship ViT-L int8 via Core ML (307 MB bundled is fine, Neural
Engine runs it well, strong play). Web → keep GPT (307 MB cold download is rude,
ViT-B too weak, a BioCLIP *server* has no edge over the GPT call already wired).
Cloudflare Workers AI → no (fixed catalog, only generic CLIP, no BYO 307 MB ONNX).
**The only path to "small AND accurate" is knowledge distillation** — this project.

---

## The approach: feature distillation into the teacher's embedding space

Standard KD copies a teacher's *output logits*. We do **feature (embedding)
distillation**:

1. **Teacher = frozen BioCLIP-2.** Precompute + cache each corpus image's 768-d
   L2-normalized image embedding. ~2.6M images → 366 shards. Done ONCE; the
   teacher never runs at train time.
2. **Student = a smaller CLIP image encoder + a linear projection** into the
   teacher's 768-d space. Train so student embedding matches the cached teacher
   embedding for the same image, via **cosine loss** `1 − cos(student, teacher)`.
3. **Classification is zero-shot, shared.** Because the student lives inside the
   teacher's embedding geometry, BioCLIP-2's **text classifier** (11,167 species
   prompts) works UNCHANGED. Prediction = `argmax(student_emb · text_emb)`. No
   species head to train, no class list baked into weights; add/rename species by
   changing prompts, not retraining.

### Why this design (the novelty for our use case)

- **Model-agnostic + future-proof** — distilling the embedding (not logits over a
  fixed species set) means the student isn't locked to today's taxonomy; swap
  student arch later without touching the classification path.
- **Cheap iteration** — cached embeddings turn each run into a pure student-forward
  job (no teacher in the loop). A full 7,555-sp epoch is ~2.3h on one 3080.
- **Built-in abstention** — softmax over image-vs-text sims gives calibrated
  confidence; thresholding it = accuracy/coverage dial GPT-4.1-mini doesn't expose.
  Headline differentiator for the RealBirdID abstention benchmark.
- **License-clean** — corpus is openly-licensed iNat; ShareAlike excluded from the
  training manifest so student weights can be released MIT; full attribution kept.
- **Trained on a single consumer GPU (RTX 3080, 10GB).** No cluster/cloud. Caching
  teacher embeddings once + LAION-pretrained init collapses CLIP-scale student
  training into a single-desktop-GPU job (pilot ~3h, full run ~1.5 days) vs the
  teacher's 8–176× A100/H100 node-days.

### Transfer learning: NOT from random weights

The student encoder inits from **LAION-2B-pretrained CLIP weights** (e.g.
`ViT-B-16 / laion2b_s34b_b88k`), already trained on ~2B image-text pairs. Only the
512→768 projection head starts random. Distillation *specializes* an already-smart
encoder into BioCLIP-2's bird geometry — cosine sim jumps ~0 → ~0.77 in the first
50 steps.

---

## Two-architecture plan (decided 2026-07-22)

- **Tuning arch: ViT-B/16** — trains fast (~316 img/s, batch 96, 3080). Develops
  the recipe. Distillation-preserves-accuracy is arch-agnostic.
- **Shipping arch: MobileCLIP-S2 (Apple, FastViT backbone)** — ~15–20 MB,
  CoreML/ONNX-ready, hits the <25 MB stretch target.
- **The ViT-B/16 student is ITSELF shippable** (~86 MB fp16 / ~45 MB int8),
  hitting the <86 MB *fallback* target. If ~45 MB int8 is acceptable, one ViT-B
  run + export could BE the production model — MobileCLIP only needed for <25 MB.

**FastViT training-speed caveat (unverified — TODO before concluding cloud is
needed):** MobileCLIP's FastViT uses MobileOne-style train-time
overparameterization (parallel depthwise-conv branches that only fuse at inference
via `reparameterize_model()`), slow to TRAIN on desktop Ampere. Measured ~17s/step
(batch 64) on the 3080 that day — **but that figure is SUSPECT**: it was during
the session where the GPU was thrashing and several numbers were misread (the
ViT-B "48 img/s ceiling" was a batch-128 VRAM-wall artifact; batch 96 ran 6× faster
at 314 img/s). FastViT at batch 64 may have hit the same 10GB wall. Never did a
clean batch-swept re-measure. **Re-benchmark FastViT (fresh GPU context, batch
96/48/32) AFTER the full ViT-B run frees the GPU.** Native Windows CUDA gave the
same ~17s (not a WSL issue); channels_last made it worse; torch.compile got ~6s.
FastViT is fast at iPhone Neural Engine *inference* after reparameterization, not
dGPU *training*; Apple trained on clusters; Apple Silicon/MPS would be slower for
training.

---

## Training recipe (as of the pilot)

- Cosine loss on L2-normalized embeddings; AdamW (lr 1e-4, wd 0.1); cosine LR
  schedule; AMP (fp16 autocast); tf32 + cudnn.benchmark.
- **Batch 96** (3080 sweet spot; batch 128 hits the 10GB VRAM wall → thrashes to
  ~48 img/s; batch 96 runs ~316 img/s).
- **LR NOT retuned when batch dropped 128→96** (both pilot + full run use lr 1e-4).
  Change was only 0.75× (minor), AdamW is adaptive, distillation-to-fixed-targets
  is smooth — pilot still hit 99% retention. Still UNTUNED: a slightly lower LR
  (~5–7e-5) might improve the val plateau / reduce the mild overfit drift (val
  peaked ~epoch 11 then declined). **TODO in sweep: batch 96 × lr {5e-5, 7e-5, 1e-4}.**
- 2% held-out val split (seeded). ⚠️ `val_cos_sim` measures **student-vs-teacher
  cosine**, i.e. "how well did we copy the teacher," NOT species accuracy against
  ground truth. Early stopping (patience 3) + best-checkpoint saving.

---

## Results

### Pilot: 500 species, ViT-B/16, 15 epochs, ~3h on one RTX 3080 (2026-07-22)

Final `val_cos_sim` 0.946 (plateaued ~0.947 from epoch ~10–11). Both models scored
with the SAME BioCLIP-2 text classifier (fair encoder-vs-encoder). No GPT in these
evals.

Held-out corpus (in-distribution, 4,000 unseen iNat imgs): teacher 53.9/77.9,
student 56.1/78.5 → **retention 104% / 101%**.

NABirds (OOD, external expert-labeled, 282 test imgs ∩ pilot species): teacher
91.5/99.7, student 90.8/97.2 → **retention 99.2% / 97.5%**. The headline: a ViT-B/16
student retains ~99% of teacher top-1 on unseen external birds. In-distribution the
student slightly *beats* the teacher (normal distillation specialization, not a
general-superiority claim).

Abstention (student, held-out corpus): @0.7 conf → keep 34% @ 91% acc; @0.9 → keep
16.6% @ 97%.

### Full run: 7,555 species, ViT-B/16 (launched 2026-07-22 ~19:54)

2,502,898 imgs, max 20 epochs, patience-3, ~316 img/s (~2.3h/epoch), ETA ~26–30h.
Progress (2026-07-23): epoch 1→6 val_cos 0.9313 → 0.9399 → 0.9441 → 0.9467 → 0.9486
→ 0.9505, monotonic, new best each epoch. Epoch 7 in progress. Results + evals TBD
(update when it lands, evals at `--pilot-species 0`).

---

## Ground-truth fine-tune (post-distillation teacher-beating lever)

Distillation caps the student at ≈teacher on the teacher's own task (the embedding
IS the target — you can't exceed what you copy). To BEAT the teacher on real
bird-ID accuracy, fine-tune the distilled student on **ground-truth species labels**
afterward. Fuel we have:

- **Research-grade iNat labels are real human ground truth** — an observation only
  reaches "research grade" when 2+ independent identifiers agree (+ date, location,
  photo, not captive). Corpus was built `--research-only`. (Small error rate on hard
  confusables; biased to common/photogenic species + populated areas.)
- **~49M untouched photos** — iNat has 52.0M research-grade open-licensed candidate
  photos across our species; we downloaded only 2.65M (cap 500/species; 3,868
  species hit the cap). The rest is a leak-free reservoir the distillation NEVER
  saw. Concentrated in *common* species (rare ones are cap-limited by scarcity, so
  extra data can't rescue the 1,132 species stuck at 50–99 photos).
- **GPS/date metadata** (99.8% coverage) — the biggest teacher blind spot. BioCLIP-2
  is image-only; a student that fuses range/season priors beats it on real-world ID.
  Same signal as the co-occurrence work (two uses: inference-time external range
  filter, and training-time hard-example weighting).

**We do NOT have WingDex user-confirmed IDs** (not stored) — so no user-feedback
loop; the fuel is iNat labels + metadata only.

**Leakage caveat:** distillation and this corpus share the same images. Fine-tuning
a pure image-only classifier on the SAME 2.65M mostly re-touches data the student
already saw through the teacher's eyes → recovers the teacher, doesn't beat it. To
actually beat it: (a) build a clean held-out split from the untouched 49M pool,
sampled **by observation not photo** (avoid near-dup leakage), for both fine-tune +
eval on TRUE labels; and especially (b) fuse the GPS/season metadata.

**We are NOT doing direct-from-scratch supervised training** (decided 2026-07-23):
too data-hungry for 7,555 fine-grained classes at 50–500 imgs each, overfits to
iNat quirks, worse OOD, loses open-vocab + license-clean properties. Distill first
(robust general embedding + OOD generalization + open vocab), THEN ground-truth
fine-tune.

**Prereq not built yet:** a sampler script (alongside `download_inat.py`) that
pulls research-grade photos EXCLUDING observation_uuids already in our manifest
(~100/species by observation) → the leak-free held-out ground-truth set.

---

## Teacher + future improvement passes

**Teacher = BioCLIP-2 ViT-L/14** (`hf-hub:imageomics/bioclip-2`) — only variant
that exists (LAION-2B CLIP ViT-L/14 base, MIT). No larger release to chase. Teacher
size is a train-time cost only; shipped student unaffected.

**Ensemble / multi-teacher = deferred.** First student is single-teacher (BioCLIP-2,
free/local) for a baseline + confusion matrix. Then targeted: GPT-5.4-mini-label
ONLY the confused hard pairs (API cost → subset), blend BioCLIP+GPT distributions
(KL) + BioCLIP embedding (cosine), range/co-occurrence as a training-time sampling
weight. Range stays external at inference (model-agnostic, updatable).

---

## Phase 4: benchmark + eval anchors

Run the student through the **same** gated+range pipeline
(`scripts/pipeline-experiment.mjs`) on the 27-image set + a larger held-out set.
Compare top-1/top-5 vs GPT (83/87) and ViT-L (87/96). Go/no-go.

- **NABirds** (HF `zguo0525/nabirds-dataset`, ~48K imgs / 555 NA species, expert
  labels + boxes) — primary labeled anchor, NA-focused like our users.
- **CUB-200-2011** (HF `syedashfaq/CUB_200_2011`, 11,788 imgs / 200 sp) — quick FGVR
  sanity.
- **RealBirdID** (arXiv 2603.27033, CVPR'26, MIT) — *headline* abstention-aware
  benchmark (species accuracy AND calibrated abstention). NOT RELEASED as of
  2026-07-21 (`cvl-umass/RealBirdID` usedStorage=0). Watched by cron
  `realbirdid-release-watch` (daily 9am); wire in when data lands.

### Detection / localization (open integration problem)

GPT returns `birdCenter`, `birdSize`, `multipleBirds`; a pure classifier doesn't.
Substitutes: crop trigger (softmax_top1 < ~0.6 flags ambiguous/multi/small — clean
separation from confident singles at 0.9+); iOS Vision framework animal detection
(real boxes + count, free); web leans on existing manual-crop UX (`crop-math.ts` is
model-agnostic) + the softmax gate.

### Shipping range data offline

27km Equal Earth grid (1276×618). Ship a regional quantized table (few MB gzipped
for NA), not the full store. Lookup = grid index + vector op.

---

## In-browser adaptive-router demo (`ml/demo/`)

Proof of the **adaptive router**: one shared pipeline with a swappable front-end
(on-device BioCLIP-2 when available, GPT fallback otherwise) — no divergent
per-platform pipeline. Both emit `{species, confidence}[]`; the entire
post-processing path (taxonomy grounding → range tiering → confidence gate) is
shared; the router only swaps which model produces candidates:

```
model cached?            -> BioCLIP on-device (instant, free, offline)
not cached, fast/wifi    -> GPT now + background prefetch, switch when ready
not cached, slow/metered -> GPT; optionally offer "download ~300MB for offline"
```

Loads ViT-L int8 (307 MB) via onnxruntime-web + WebGPU (WASM fallback);
background prefetch with live speed/ETA; persistent Cache API; softmax gate
(<0.6 → manual crop); text embeds shipped as 8.6 MB int8 matrix.

Files: `index.html` (UI), `router.js` (prefetch/cache/WebGPU/int8 matmul/gate/GPT
stub), `serve.mjs` (static server with COOP/COEP headers required by ort-web),
`models/` (not committed, 307 MB).

Run:
```bash
# regenerate assets (GPU box): scripts/export-onnx.py -> bioclip2_visual_int8.onnx
#                              scripts/gen-demo-assets.py -> text_embeds_int8.bin, _scale.bin, species.json
node ml/demo/serve.mjs ml/demo 8770   # open in Chrome/Edge (WebGPU)
```

**Verified** (`validate_node.js`, onnxruntime same API as browser): int8 ONNX loads
+ faithful embeddings; full path preprocess → encoder → int8 text-matmul → softmax
→ candidates; raw 74/83 pre-range matches PyTorch (faithful export; gated+range
lifts to 87/96); CPU ~335 ms/img. **Pending** (needs real WebGPU browser session):
actual WebGPU latency, end-to-end download+cache timing, Cloudflare Pages preview.

---

## Pipeline scripts (`ml/distill/`, run in order)

- `fetch_metadata.py` — resumable HTTPS pull of iNat Open Data taxa/observations/
  photos `csv.gz` dumps (S3 bucket `inaturalist-open-data`, no 60 req/min API cap).
- `build_manifest.py` — DuckDB join (photos→observations→taxa), filter to target
  bird taxa + open licenses, per-species floor/cap, emit `manifest.parquet` +
  `target_taxa.csv` + `manifest_stats.txt`.
- `pull_images.py` — parallel S3 fetch (32 workers, resumable). Writes
  `corpus/<inat_taxon_id>/<photo_id>.<ext>` + `download_manifest.jsonl` + `failures.log`.
- `build_cooccurrence.py` — grid-cell (~27km) species co-occurrence from corpus GPS,
  for training-time hard-example weighting. **Built + tested, NOT yet wired into
  `train_student.py`.** (Test: 2.64M obs binned, 1.79M co-occurring pairs.)
- `precompute_embeddings.py` — batched GPU forward of the frozen teacher over corpus
  images → `embeddings/shard_*.npz` (photo_ids int64, embeddings fp16 [N,768],
  L2-norm). Catch-up mode overlaps the download. `embed_loop.sh` self-relaunches it.
- `prep_training_set.py` — emit `train_manifest.parquet` (ShareAlike EXCLUDED by
  default for MIT release; `--keep-sharealike` research variant) + `ATTRIBUTIONS.md`.
- `train_student.py` — the distillation trainer. `--arch` (default `ViT-B-16`),
  `--pilot-species 500` (top-N most-photographed; `0` = full 7,555), `--smoke`
  (3-sp/2-step self-test), `--patience`, `--batch`, checkpoints `best.pt`/`last.pt`.
- `eval_student.py`, `eval_heldout.py`, `eval_nabirds.py` — eval harnesses.
- `select_species.py`, `download_inat.py`, `lic_query.py`, `nabirds_map.py` —
  earlier API-era / license / taxonomy-mapping helpers, kept for reference.

Corpus (2026-07-22): floor 50 / cap 500 → 7,555 species, 2,646,057 manifest rows,
~2.645M imgs (~262 GB; ~272 iNat-deleted 404s). 2,503,107 kept after ShareAlike
exclusion. Design: resumable everywhere (skip completed via on-disk state),
license-audit ready (every image records license + attribution).

---

## Where things live (⚠️ 3 code copies — cleanup pending)

Heavy work runs on **tomahawk** (RTX 3080) under the spike venv
`~/spikes/bioclip-birdid/.venv` (torch 2.6.0+cu124, open_clip 3.3.0).

1. **Pi `~/wingdex/ml/`** — git repo, branch `bioclip-distill`. **SOURCE OF TRUTH
   for code + docs. Edit here.**
2. **Tomahawk `~/wingdex`** — a real git checkout too, but **stale** (`3c82604`,
   behind origin) and **unused**. Training does NOT run from here.
3. **Tomahawk `~/spikes/bioclip-birdid/`** — **non-git loose scratch dir where
   training ACTUALLY runs** (path `distill/`, no `ml/`). Scripts hand-synced from
   the repo (rsync/tar) → drift risk. Corpus, `runs/`, `embeddings/`, manifests,
   logs, checkpoints live here — all OFF git (`.gitignore`), too large + regenerable.

**Cleanup (AFTER current run finishes):** consolidate onto ONE tomahawk checkout —
make `~/spikes/bioclip-birdid` a real `git clone` (or reuse `~/wingdex`), data
gitignored, so the path matches the repo (`ml/distill/`) and scripts never drift.
Then move the 262GB corpus to the NAS (keep the ~4GB embeddings + checkpoints; raw
JPEGs only needed during precompute).

History note: scripts were briefly split across `bioclip-birdid` and
`bioclip-distill` branches; consolidated onto `bioclip-distill` 2026-07-22. The
5 separate ml docs were merged into this file 2026-07-23.
