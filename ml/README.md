# WingDex on-device bird ID: BioCLIP-2 distillation → WingCLIP → occurrence rerank

**Single source of truth** for the on-device / offline bird-ID effort. This one
doc replaces the former `ml/README.md`, `ml/BROWSER.md`, `ml/distill/README.md`,
`ml/distill/METHOD.md`, and `ml/demo/README.md` (consolidated 2026-07-23).

Tracks issue [#260](https://github.com/jlian/wingdex/issues/260). Branch:
`bioclip-distill`. Working location: **ONE directory** — `~/wingdex/ml/distill/`
on tomahawk (repo + data + uv venv). The Pi checkout and `~/spikes` scratch dir
are gone. Training data = WebDataset shards on the NAS.

> This document was reorganized 2026-07-31 so the CURRENT TRUTH is stated once,
> up front. Many earlier claims were corrected (sometimes twice) as the work
> progressed; the corrected value is what appears in the top sections. The
> **Historical log** at the end preserves the full chronological record and the
> instructive mistakes — nothing was thrown away, only reordered and de-duplicated.

---

## STATUS — read this first

🟢 **Distillation, fine-tune, and the occurrence-rerank pipeline are settled for
the ViT-B backbone.**

**Ship candidate: `WingCLIP-0.1` = WiSE-FT alpha=0.90 blend, 89.93 NABirds top-1**
(teacher BioCLIP-2 ViT-L = 86.41, so **104.1% retention** — the student beats the
teacher on out-of-distribution NABirds). This is on the CLEANED ground-truth set
(3,850 species / 151,042 photos); it edges the old dirty-set alpha=0.75 run
(89.45).

🔥 **The big win is the RANKER, not the vision model.** A fitted Bayesian log-sum
with an empirical `P(species|cell)` from iNat occurrence data
(`score = sim/T + beta·log P(species|cell)`) massively beats the old
floor/tier/dominance ranking. On 3,322 leak-free held-out photos, **absolute**
top-1:

| ranker | ABS top-1 |
|---|---|
| raw argmax (vision only) | 72.94 |
| F: gated tiering (old ranking logic) | 79.53 |
| H: log-sum + BirdLife | 81.87 |
| **I: log-sum + iNat occurrence (SHIP THIS)** | **88.29** |

Stress-tested: generalises to unseen geography (0.87 pt penalty) and a 2-year-stale
prior costs 2.88 pts (~2.04 genuine drift, ~0.84 density) → refresh quarterly.

🔜 **NEXT PLANNED WORK: distil a smaller TinyCLIP backbone.** The ViT-B student is
86.6M params (43 MB at int4) and CANNOT reach the sub-25 MB web target by
quantisation alone (int3/int2 collapse the model to 0% top-1). TinyCLIP-ViT-39M
(MIT-licensed, ships basis weights) is 38.3M params → **19.2 MB at int4**, which
clears 25 MB. The METHOD is proven; the OPERATING REGIME (fine-grained 11,167-species
ID at 2.2x less capacity) is NOT yet proven and must be measured on the ~496-species
pilot first. See "Next steps" and "Smaller backbone: TinyCLIP".

> ⚠️ **This supersedes the old header** which said "Do not start another training
> experiment" and "No distillation-recipe lever with known upside remains." Those
> were true for the ViT-B *recipe* search (LR, epochs, aug, WiSE-FT alpha are all
> settled) but are STALE now: the TinyCLIP backbone swap is a new, planned
> training effort with real upside (a shippable <25 MB model).

**What is actually in production TODAY:** GPT-5.4-mini vision feeding
`functions/` → `bird-id.ts`. WingCLIP has never been in production. The on-device
inference runtime is **undecided** — the app has no `onnxruntime-web`,
transformers.js, WebGPU, or Core ML code yet. See "Target runtime is undecided".

⚠️ **Golden-set warning.** The GPT-5.4-mini **83/87** baseline was measured ONLY
on the 27-image golden set (n=23 scorable, self-labelled, uncertain labels — one
image is worth 4.3 pts). It is NOT comparable to any 11k-photo number. Running GPT
over 11,070 photos is prohibitively expensive, so **no GPT baseline exists at
scale and none is planned.** Never place a golden-set number beside an 11k number
as if they were peers. Judge reranking on the 11k / leak-free sets, never on the
golden set.

---

## The model + pipeline as it stands now

### Architecture

The student (`train_student.py`) is a **ViT-B-16 visual tower** (LAION-2B init,
`laion2b_s34b_b88k`) whose 512-d output is projected by `nn.Linear(512, 768)` into
BioCLIP-2's embedding space and L2-normalised. `Student.forward()` IS the
exportable graph (visual → proj → normalize). Input resolution **224**.

Classification is **zero-shot cosine similarity** against an **11,167 × 768 matrix
of BioCLIP-2 TEXT embeddings**, computed once at build time and shipped frozen —
**the text encoder never runs on device.** Prediction = `argmax(student_emb · text_emb)`.
Add/rename species by changing prompts, not retraining.

| component | shape | fp32 | int8 | int4 |
|---|---|---|---|---|
| visual tower | 86.6M params | 346.3 MB | 87–88 MB | 43 MB |
| text classifier | 11,167 × 768 | 34.3 MB | ~8.6 MB | — |
| occurrence prior blob | 99,900 cells | — | 5.4 MB (gzipped) | — |
| **on-device total (int8)** | | | **~102 MB** | |

The student is a **3.5x compression of the teacher's visual tower** (304.0M →
86.6M params).

### The occurrence-prior ranker (Strategy I — the shipped math)

```
score(species) = sim/T + beta · log P(species|cell)
```

**TWO parameters only: T and beta.** No confidence floor, no top-K slice, no
multiplicative penalties, no tier table, no dominance gate. Strong visual evidence
produces a large enough likelihood term to overcome an unfavourable prior on its
own; weak evidence does not — which is exactly what the old `dom>=0.5` gate was
hand-faking.

- `T` (vision temperature) fitted **0.007809** (was hardcoded 0.01). Note T moves
  with the joint fit (0.00845, 0.00927 appear in other fits) — always state which
  fit produced a number.
- `beta` (scalar on the geography term) fitted ~0.6–1.33 depending on the joint fit.
- Fitted params live in `ml/distill/calibration_occ_01.json`, for **WingCLIP-0.1 @
  alpha=0.90**. They are NOT transferable to a different backbone — 0.2 has a
  different confidence distribution (median top-1 0.807 vs 0.715). Any model swap
  REQUIRES re-running `emit_calib_candidates` + `fit_occurrence`.

**Absent-species floor.** A candidate with no occurrence record in the cell gets
`log(1e-9) ≈ -20.7`. 87.2% of candidate slots have no record, so the floor is the
dominant term for most candidates. Swept and refit at each value: **-20.7 is optimal
and the curve plateaus there.** A SOFT floor is catastrophic — at -2/-4 the optimiser
drives beta to 0 and abandons the prior entirely. Absence must be treated as strong
evidence (same lesson as alpha=0, from the other direction).

**`P(species|cell)` is empirical iNat occurrence**, built from the FULL iNat corpus
(`observations.csv.gz`, 157,114,210 research-grade GPS observations →
26,396,703 (species,cell) pairs; **birds only** = 3,176,965 pairs / 99,900 occupied
cells / 10,615 species / 31,439,746 observations). Built in ~2 min in DuckDB, no
images, no GeoPackage, no rasterization. Grid = 27 km Equal Earth (1276×618);
projection uses the **WGS84 ellipsoid** (authalic latitude), verified 12/12
exact cell-id matches against production `range-adjust.js`.

> ⚠️ **Do NOT build the prior from `train_manifest.parquet`** — it is the
> post-floor (≥50), post-cap (500/species) download list, so abundance ratios are
> flattened. Use the raw uncapped/unfloored dump.

**Prior-dominance regimes** (fitted; thresholds tied to the run's T, re-derive if
the model changes):

| vision conf | behaviour |
|---|---|
| **> 0.9** | prior is decorative (flip 1.1%→0.5%, net +0.55→0.00 over 756 photos) → **SKIP the range lookup entirely**, save a fetch + rerank on ~34% of traffic |
| 0.6–0.9 | normal collaboration, standard confidence display |
| **< 0.6** | prior flips 40–70% of answers and supplies more accuracy than vision → **change the WORDING** ("crows are common here, and this is consistent with what I can see", flag life-list entries as a GUESS) |

### Abstention / confidence gate

**Ship the existing confidence gate at threshold 0.5. No separate bird/not-bird
detector needed.** At the ship candidate (alpha=0.90, thr 0.5): **2.4% of non-bird
photos pass vs 88.4% of real birds** (~36x selectivity, from a model never trained
to detect birds). Mechanism: a dog resembles none of the 11,167 species, so
similarity is diffuse (mean non-bird confidence 0.109) and no class wins the softmax.
The "no none-of-these class" concern does not bite.

- Caveat: measured on Imagenette (EASY negatives — churches, chainsaws). Real
  WingDex hard negatives (blurry branches, squirrels, a leaf at bird scale) are not
  represented; 2.4% is a FLOOR, not a guarantee.
- ⚠️ **The softmax gate is NOT a small-bird / framing detector.** Correlation of
  top-1 confidence vs relative bird area (NABirds boxes, 4,000 imgs): **Pearson
  0.051, Spearman 0.032** — essentially zero. Low confidence means **species
  ambiguity, not bad framing.** Prompting the user to crop when confidence is low
  will mostly NOT help (cropping a Downy tighter does not stop it looking like a
  Hairy). A crop prompt needs a REAL framing signal — iOS Vision framework, ViT
  patch saliency, or multi-crop consistency (all validatable against NABirds boxes).
  Hedge: NABirds median bird area is 28% (well-framed); the 0-2% bucket (15 imgs)
  DID show a confidence drop, so a crop prompt may still be right for genuinely
  distant birds — this dataset just cannot see that regime.
- ⚠️ Fine-tuning slightly WORSENS non-bird rejection (0.8%→2.4% leakage from alpha
  0→0.9), consistent with the general-knowledge collapse below. Magnitude trivial.

---

## Measured results (current numbers, one place each)

### Distillation → fine-tune → WiSE-FT (the shipped WingCLIP-0.1 chain)

- **0.1-alpha (distillation base):** full 7,555-species distill, OLD recipe (aug
  none, lr 1e-4, wd 0.1, beta2 default, no warmup/clip, 20 ep), `full7555_vitb`.
  val_cos **0.9650**, held-out 100.1%, **NABirds 94.7% retention** (student 81.83 /
  teacher 86.41).
- **0.1-beta (ground-truth fine-tune):** 0.1-alpha fine-tuned on TRUE species labels
  from the CLEANED leak-free ground-truth set (3,850 species / 151,042 photos),
  `ft_clean_01` (aug light, lr 1e-5, wd 0.1, warmup 200, clip 1.0, 12 ep), FROZEN
  BioCLIP-2 text tower as fixed class weights (stays open-vocab). In-distribution
  val 63.39 → **77.61** (+14.22).
- **0.1 (complete pipeline):** 0.1-beta + WiSE-FT `θ = (1-α)·distilled + α·finetuned`
  at **alpha=0.90** → **NABirds 89.93** (retention 104.1%). WiSE-FT interpolation
  verified bit-for-bit correct.

**WiSE-FT alpha sweep (clean set, both bases; alpha=0.90 is the peak on BOTH):**
```
base 01: 0.25→85.86  0.50→88.42  0.75→89.69  0.90→89.93  1.00→89.77
base 02: 0.25→83.20  0.50→86.40  0.75→88.19  0.90→88.46  1.00→88.26
```
The optimum ~0.9 is a MILD version of the paper's ~0.5 — our fine-tune was gentle
(4.7% global weight movement, concentrated in the projection + last few blocks),
so alpha=1.0 is already effectively a mild interpolation, leaving little OOD damage
for WiSE-FT to repair. A more aggressive fine-tune would likely move the optimal
alpha DOWN toward ~0.5 (backlog).

**The fine-tune gain is RECOGNITION, not coverage.** All 24,633 NABirds test images
belong to distilled species; ZERO come from the 2,058 never-distilled ones. The
entire +7.61 pt WiSE-FT gain (base → alpha=0.75) is on species the base model
already knew.

**Catastrophic-forgetting caveat (NABirds is blind to it).** On Imagenette (10
general non-bird classes) base 01 collapses monotonically −8.0 pts across the alpha
sweep — fine-tuning destroys general knowledge exactly as WiSE-FT theory predicts.
Absolute values are near the chance floor (bird specialists were never general); the
RELATIVE collapse is the signal. ⚠️ **UNEXPLAINED: base 02 runs BACKWARDS** on the
same eval (10.4 → 14.0, rising with alpha) and starts 7 pts below base 01. Two bases,
opposite signs. No explanation — do NOT build on the base-02 general numbers.

### Reranking (absolute top-1, one authoritative table)

⚠️ **Always report ABSOLUTE accuracy, not conditional.** Earlier write-ups quoted
*conditional* numbers (accuracy over photos where the true species is in the top-K),
which is why a figure once appeared to exceed the recall ceiling. Corrected, over
ALL 3,322 leak-free held-out photos (recall ceiling 94.52%):

| strategy | conditional | ABSOLUTE |
|---|---|---|
| raw argmax (vision only) | 77.17 | **72.94** |
| F gated dom=0.5 (old ranking logic) | 84.14 | **79.53** |
| H bayes + BirdLife | 86.62 | **81.87** |
| **I bayes + iNat occurrence** | **93.41** | **88.29** |

**Ablation (is BirdLife redundant?), ABS top-1 on the same split:**

| model | ABS top-1 | marginal |
|---|---|---|
| vision only | 72.94 | — |
| + BirdLife (= H) | 81.88 | BirdLife alone +8.94 |
| + iNat occurrence ONLY | 87.99 | occurrence alone +15.05 |
| + both (= I) | 88.29 | BirdLife on top of occurrence **+0.30**; occurrence on top of BirdLife +6.41 |

**BirdLife is not useless — it is REDUNDANT.** Almost all of its ~9 points is already
implied by the occurrence counts (a species with many iNat records in a cell is
nearly always BirdLife-`present`). Its only surviving distinct job is separating
*unobserved-but-plausible* from *unobserved-and-impossible* (a per-cell SET of
plausible species). At +0.30 pts it does not justify a second shipped data layer.

**alpha=0 (BirdLife smoothing) is real, not a small-n artifact.** The alpha sweep is
MONOTONIC (89.95 at 0 → 82.72 at 1000) and stable at exactly 0.0 across 1,937 /
3,874 / 7,748 training photos. Every unit of BirdLife smoothing actively hurts. What
alpha=0 kills is only the pseudo-count term; a flat per-status bump survives.

**GBIF adds NOTHING on top of iNat.** The weighted joint fit drove beta_gbif to
exactly 0.0 and reproduced iNat-only to two decimals; naive count-summing actively
HURTS (−1.44 pts, GBIF's 2.16B records swamp iNat's 157M).

⚠️ **Blind spot (appears three times in this project):** every calibration photo IS
an iNat observation, so its cell is covered by construction. So "GBIF/BirdLife add
nothing" and "5-bit quant part-2 coverage" all hold ONLY for photos taken where iNat
users go. Whether external sources help in genuinely iNat-sparse areas is UNMEASURED
and this eval set structurally cannot answer it.

**Stress tests:**
- **Geographic holdout** (split by cell, fit never sees test regions): occurrence
  gain +14.36 on unseen geography vs +15.22 random → **transfer penalty 0.87 pts**.
  The prior generalises rather than memorising.
- **Temporal holdout** (prior from pre-2024, eval on 2025+): a 2-year-stale prior
  costs **2.88 pts** (retains 54% of the benefit). Density-matched control
  decomposes it: **~2.04 pts genuine DRIFT, ~0.84 pts DENSITY** — freshness matters
  ~2.4x more than volume. Fix is "refresh often", not "collect more". ⚠️
  `temporal_holdout.py` prints an auto-verdict "yearly refresh is plenty" that
  compares the DENSITY delta, not the staleness delta — ignore it; the staleness
  number is the pre-2024 row.

**End-to-end validation on 11k (the shipping JS pipeline, not the Python
reimplementation):** converted the calibration parquet to harness fixtures and ran
the real `pipeline-experiment.mjs` over 11,070 photos — the first run of the JS path
at scale (all prior JS agreement was on n=23).

| strategy | top-1 | top-5 |
|---|---|---|
| A_production (GPT-era pipeline) | 74% | 78% |
| D_tiered_nogate (1/8 neighbour) | 74–75% | 91% |
| F_gated_dom0.5 (old ranking logic) | 80% | 92% |
| H_bayes_logsum (BirdLife) | 82% | 93% |
| **I_occurrence_SHIPPING** | **89%** | **94%** |
| *GPT-5.4mini (golden-set-only, n=23)* | *83%* | *87%* |

**Strategy I = 89/94 at 11k.** The cross-check passes (Python reference on the
held-out third = 88.29; JS harness on full 11,070 = 89 — close agreement means the
shipping code and reference math implement the same model). The **+9 top-1 over
F_gated (80→89) is an internal ABLATION** — same WingCLIP candidates, old ranker vs
new ranker — NOT a production delta. **The production delta (WingCLIP vs GPT) is
UNMEASURED at scale** (see the golden-set warning). ⚠️ A/D/F/G/H read BirdLife range
cells and this worldwide fixture set has gaps in our local 104-cell BirdLife subset,
so those rows may be mildly understated; Strategy I uses no BirdLife and is unaffected.

Name drift, for grep: proposed as `I_bayes_occurrence`, shipped as
`I_occurrence_SHIPPING` in `pipeline-experiment.mjs`.

### Phase 4 benchmark (golden set) — recorded, but NOT the ship gate anymore

Phase 4 (27-image golden set, gated+range pipeline vs GPT 83/87 and teacher 87/96)
RAN 2026-07-30 and initially "failed" at 78/91 for WingCLIP-0.1 @ alpha=0.90. Root
cause was **softmax CALIBRATION, not recognition** — top-5 MATCHED the teacher (96%)
under Strategy D; the answer was in our candidate list as often, we just ranked it
worse at position 1. That failure is what produced the entire occurrence-rerank line
of work above, which resolved it. Detail (confidence distributions, the argmax-vs-
softmax root cause, the 0.1-vs-0.2 pipeline inversion) is in the Historical log.
**Do not tune or judge reranking on the golden set** — n=23, one image is 4.3 pts.

### Quantisation — measured in torch on GPU, and it is nearly free

**NABirds, all 24,633 images, PyTorch weight fake-quantisation** (`quant_accuracy.py`,
~6 s/variant on GPU). fp32 lands at 89.94 vs the 89.93 torch reference, so the
harness is sound.

| variant | ~MB | cos(fp32) | agree% | top-1 | Δ(top-1) |
|---|---|---|---|---|---|
| fp32 | 346 | 1.000000 | 100.00 | 89.94 | +0.00 |
| **fp16** | **173** | 1.000000 | 99.98 | **89.94** | **+0.00** |
| bf16 | 173 | 0.999987 | 99.75 | 89.92 | −0.02 |
| **int8** | **87** | 0.999967 | 99.63 | **89.89** | **−0.05** |
| **int4-blk128** | **43** | 0.993095 | 95.27 | **89.06** | **−0.88** |
| int3-blk128 | 32 | 0.739231 | 0.00 | **0.00** | −89.95 |
| int2-blk128 | 22 | 0.732123 | 0.00 | **0.00** | −89.95 |

- **fp16 is exactly free** (identical top-1, half size).
- **int8 costs 0.05 pts for 4x** — inside noise.
- **int4 costs 0.75–0.88 pts for 8x**, top-5 barely moves. (The −0.75 figure is with
  attention quantised too; see the correction below.)
- **int3/int2 COLLAPSE to 0.00% top-1** — cosine falls to ~0.73, the embedding is
  destroyed, not merely noisy. There is no gentle slope below 4 bits with naive
  round-to-nearest.

⚠️ **int4 = 43 MB, definitively.** Two earlier WRONG numbers were tool artifacts:
1. **"int4 = 75.3 MB"** came from ONNX `MatMulNBitsQuantizer`, which only quantises
   MatMul weights and leaves embeddings/LayerNorm/bias (and, in an earlier torch bug,
   all attention `in_proj_weight` = 24.5% of the model) at fp32. Quantising ALL
   weights in torch gives the true **43 MB**. The size column is `params × bits/8`
   from a constant table, so 43 MB never depended on which layers were actually
   quantised — the attention bug changed HONESTY (24.5% was silently running fp32
   while reported as int4) and the accuracy cost (−0.55 → −0.75), not the size.
2. **"fp16 cannot be built"** is true only of the ONNX converters (`onnxconverter_common`
   emits an invalid Cast; torch cannot export `aten::_native_multi_head_attention` in
   half at opset 17) — but IRRELEVANT to accuracy: fp16 in torch is one `.half()` call
   and works perfectly. Export-format problems are DEPLOYMENT problems, not accuracy
   problems.

**Method lesson (cost the most time in the whole effort):** to answer "what does
precision cost", quantise weights in torch and run the normal eval (~6 s/variant on
GPU). Only involve ONNX/Core ML when the deliverable is the artifact itself. The ONNX
detour produced two wrong numbers and cost hours.

**fp32 ONNX export is bit-exact** (`export_onnx.py`, opset 17, dynamic batch): worst
cosine(pytorch, onnx) = 1.00000000, worst |abs diff| 9.18e-07, 0/16 top-1
disagreements. This makes it a trustworthy baseline: any int8/int4 loss is
attributable to quantisation. **ONNX fp16 export is BLOCKED** (two failures above) —
must be solved before any WebGPU work, but Core ML does NOT need it (coremltools
converts from torch directly and never touches ONNX).

### CPU latency (measured 2026-07-31, Ryzen/WSL, contended → optimistic-for-phone)

| threads | fp32 | int8 |
|---|---|---|
| 1 | 612.2 ms | 472.2 ms |
| 2 | 388.1 ms | 245.4 ms |
| 4 | 247.5 ms | 143.6 ms |

**int8 is ~1.7x faster than fp32 on CPU.** 144 ms at 4 threads is fine — imperceptible
beside the network round-trip to a hosted VLM it replaces. CPU/WASM is therefore a
viable web target on latency grounds, not merely a fallback. (Note: onnxruntime's
CUDA execution provider does not accelerate dynamically-quantised weights, so the
CPU run measures the format that would actually ship. Install `onnxruntime-gpu` when
fp16/int4 GPU paths are explored.)

### The shippable occurrence blob (built + verified 2026-07-31)

`public/priors/occurrence-v1.bin.gz` — **5.41 MiB gzipped**, 7.61 MiB raw, 99,900
cells, 3,176,965 (species,cell) pairs, 5-bit quantised log-prob. Beats the 5.6 MiB
4×4-tile estimate because whole-file gzip sees cross-cell redundancy. For comparison,
the existing BirdLife range-priors layer is **260 MiB** — the occurrence layer is
~48x smaller AND carries more signal.

Size measurements (birds only, 2.82 gzipped bytes/pair on a real sample): **global
8.5 MiB, North-America 3.0 MiB**. A 2-byte taxonomy index beats the 8-byte eBird
code (9.1 vs 27.3 MiB raw); use the index. **Keep sparse cells** — cells with <10
obs are 47.5% of cells but only 4.0% of pairs, so dropping them saves ~nothing and
creates a fallback path.

**5-bit quantisation is FREE** (−0.03 pts vs float32; 4-bit −0.45 is arguably
shippable if size ever dominates). Range of log P(species|cell) is −13.82 .. −0.34.

**DECIDED: ONE binary blob, sliced client-side** — not per-cell CDN objects, not
tiles. No file-count ceiling (Cloudflare Pages caps at 20,000 files; 4×4 tiling
would have been 14,721), no boundary logic, one fetch, one immutable cache entry.
Lives in `public/` as a Pages static asset: no R2 binding, no Worker, no egress
accounting. Version-stamped filename → add an `immutable` Cache-Control entry to
`public/_headers` and bump N each quarterly refresh.

**FORMAT** (`WDOP`, little-endian):
```
magic     4B   "WDOP"
version   1B   1
qbits     1B   5
reserved  2B
n_cells   4B   uint32
index     n_cells * 8B, sorted ascending by cell_id:
            cell_id  u32   = row * 1276 + col
            offset   u32   = byte offset into payload
sentinel  8B   (0xFFFFFFFF, payload_len)
payload   per record: varint(delta of sorted species index) + 1B quantised logprob
```
- Species keyed by **2-byte taxonomy index** (`app_idx` into taxonomy.json).
- Client recovers `log(p) = -q / 2.5`, q in [0,31].
- Sentinel row → cell length is always `index[i+1].offset - index[i].offset`.
- Lookup = binary search index, slice, walk varint deltas.

**VERIFIED** by `verify_prior_blob.py` (decodes as a client would, diffs against
DuckDB): 40 random cells, 897 pairs, 0 mismatches; species indices EXACT, only
log-prob lossy by design (worst |log p| error 0.1996, consistent with 5-bit).
Rebuild: `build_prior_blob.py --occurrence occurrence_cells.parquet --target-taxa
target_taxa.csv --out public/priors/occurrence-vN.bin.gz` (~40 s).

---

## 🏷️ Model registry — WingCLIP versioning

**Name:** WingCLIP. A legitimate CLIP variant — ViT-B/16 image tower, CLIP-contrastive
pretrained (LAION-2B), emitting embeddings in a shared image/text space, usable
zero-shot with a text tower. Model card MUST state lineage: **LAION-2B ViT-B/16 init,
distilled from BioCLIP-2 ViT-L/14** (attribution + licensing requirement).

**Scheme: `WingCLIP-<MAJOR>.<MINOR>[-stage][-pilot]`**
- **MINOR** = the training-recipe/data basis (a distillation generation). Bump when
  recipe or corpus changes.
- **stage suffix** = pipeline position (all cheap post-processing): `-alpha` = raw
  distillation, `-beta` = + ground-truth fine-tune, *(no suffix)* = + WiSE-FT blend
  (complete pipeline).
- **`-pilot`** = the ~496-species version (directory says 500; see the tie-break bug).
- **MAJOR 1.0 = earned** — a basis becomes 1.0 only when it PASSES Phase 4 vs GPT.
  Most likely a promotion of a 0.x, not a separate run.

| version | what | run dir | key numbers |
|---|---|---|---|
| `WingCLIP-0.1-alpha-pilot` | 500sp distill, old recipe | `pilot500_vitb` | val_cos 0.9465 |
| **`WingCLIP-0.1-alpha`** | **full 7,555sp distill, OLD recipe** (aug none, lr 1e-4, wd 0.1, beta2 default, no warmup/clip, 20ep) | `full7555_vitb` | val_cos 0.9650 · NABirds **94.7%** (81.83/86.41) |
| **`WingCLIP-0.1-beta`** | 0.1-alpha + clean-set ground-truth fine-tune (`ft_clean_01`: aug light, lr 1e-5, wd 0.1, warmup 200, clip 1.0, 12ep) | `ft_clean_01` | GT-val 77.61 |
| **`WingCLIP-0.1`** | 0.1-beta + WiSE-FT **alpha=0.90** — complete pipeline | `ft_clean_01` (a=0.90 blend) | **NABirds 89.93** (retention 104.1%) ⬅ **current best / ship candidate** |
| `WingCLIP-0.2-alpha-pilot` | 500sp distill, LOCKED pilot recipe | `exp7_combined_lr7e5_auglight_ep25` | val_cos 0.9540 |
| `WingCLIP-0.2-alpha` | full distill, LOCKED recipe (aug light, lr 7e-5, wd 0.2, beta2 0.95, warmup 500, clip 1.0, 25ep) | `full7555_locked_ep25` | val_cos 0.9618 · **NABirds 90.7%** (78.4/86.41) — **LOST to 0.1-alpha, RETIRED** |
| `WingCLIP-0.2-beta` / `0.2` | 0.2-alpha + clean fine-tune + WiSE-FT | *tbd* | value DOUBTFUL: 0.2 stays ~1.3–1.5 pts behind 0.1 after identical clean fine-tuning at every alpha |
| `WingCLIP-0.1-tiny-pilot` | **TinyCLIP-39M distilled FROM WingCLIP-0.1**, NABirds-401 pilot, 0.2 recipe lr 7e-5 | `nb401_teach_wingclip` | val_cos 0.9612 - NABirds **89.09** (vs teacher 89.93, 38.3M vs 86.6M params) |
| `-` (control, not shipped) | same student, BioCLIP-2 teacher | `nb401_teach_bioclip` | val_cos 0.9616 - NABirds **83.44** - LOST by 5.65, teacher control |
| `WingCLIP-1.0` | whichever basis first PASSES Phase 4 | *tbd* | earned, not automatic |

> Historical note: the earlier registry listed `WingCLIP-0.1` as the alpha=0.75
> blend on the DIRTY (5,908-species) set at NABirds 89.45. That is superseded — the
> ship candidate is the clean-set alpha=0.90 blend at 89.93.

Experiments that never became a lineage are tagged under the basis they informed and
NEVER quoted as WingCLIP results: `0.2-pilot-exp1..exp6` (recipe + LR sweep),
`0.2-pilot-exp8` (40-epoch test), `0.2-pilot-exp9` (strong aug + 5-view). Non-registry:
`gate*`, `*smoke*`, `pilot`.

**Publishing:** keep 0.x internal; only push to HF at 1.0 (a 0.x with a known sampler
bug is not something to put a card on).

**Teacher reference** (every retention number divides by this): BioCLIP-2 ViT-L/14
`hf-hub:imageomics/bioclip-2` — NABirds **86.41** top-1 at full species; **57.69** on
the 5,908-sp ground-truth val split; **91.49** at the `--pilot-species 500` default
(do not mix). ⚠️ **ALWAYS pass `--pilot-species 0` to `eval_nabirds.py` for any
shippable number** — it defaults to 500, silently inflating retention 94.7% → 98.1%.

---

## Decisions and rationale (including rejected options and WHY)

### Ship a ViT-B student now; TinyCLIP is the smaller-backbone path; MobileCLIP is dead

- **Shipped model = the LAION ViT-B/16 student** (clean license). fp16 173 MB / int8
  87 MB / int4 43 MB. iOS is real product (accuracy matters); web is an engineering
  flex (shipping on-device inference at all is the payoff).
- **MobileCLIP-S2 CANCELLED (John's call 2026-07-25).** LICENSE GATE: only Apple
  `datacompdr`/`dfndr2b` weights exist and they are "Research Purposes" only —
  "Model Derivatives" (fine-tuning) inherit the restriction, WingDex is a public app,
  and no non-Apple MobileCLIP-S2 checkpoint exists. And more fundamentally: without a
  usable pretrained checkpoint you'd train FastViT from random init (orders of
  magnitude more compute, would not land near 89%). The whole method depends on strong
  basis weights.
- **TinyCLIP is the proven replacement** (Wu et al., ICCV 2023, Microsoft, "CLIP
  Distillation via Affinity Mimicking and Weight Inheritance"). **MIT-licensed**
  (kills the blocker), **ships basis weights** on HF/timm (fine-tune, don't train from
  scratch), and ViT→ViT matches our teacher/student style (weight inheritance
  applies). `vit_medium_patch16_clip_224.tinyclip_yfcc15m` = 38.3M params, 512-d
  output (matches ViT-B-16's dim, so the existing projection works unchanged), fp32
  153.3 / int8 38.3 / **int4 19.2 MB** — clears the 25 MB target. Load via **timm**
  (`timm.create_model(...)`), NOT open_clip (no `open_clip_config.json` on the HF
  repo). ⚠️ Unproven risk: 39M is a 2.2x capacity cut and all TinyCLIP headline
  numbers are coarse zero-shot ImageNet, not fine-grained 11k-species ID — MEASURE on
  the pilot before committing.
- **ViT-B-32 is a dead end** — 87.8M params vs ViT-B-16's 86.2M (patch size changes
  token count, not param count). ~4x faster to run but ZERO size reduction.
- **Move the size target.** Sub-25 MB was a MobileCLIP-era assumption; int3/int2
  collapse the ViT-B model, so it is NOT reachable with this backbone by quantisation
  alone. int4 at 43 MB (−0.75 pts) is an excellent trade. Chasing <25 MB now means
  TinyCLIP (or QAT/GPTQ/AWQ at 3-bit, pruning+distillation — all real work/risk).
- **Ship different artifacts per runtime, same weights:** iOS int8 87 MB (take the
  0.7 pts back; Core ML palettises from torch directly), web int4 43 MB (download IS
  the UX, cached after first visit). Not a maintenance burden.

### Distillation recipe: the pilot "locked recipe" LOST at full scale

The pilot sweep (500 species) settled a recipe — **lr 7e-5, wd 0.2, beta2 0.95,
warmup 500, grad-clip 1.0, min-lr 1e-7, aug light, ~25 ep** — winning on val_cos.
But applied at full 7,555 species it **LOST**: NABirds retention 90.7% (0.2-alpha) vs
94.7% (0.1-alpha's OLD recipe). Read: at 2.5M images the extra regularization has
little overfitting left to prevent and instead costs representation quality — **scale
dominates recipe**, and val_cos is not the ship metric. So **WingCLIP-0.1-alpha (old
recipe: aug none, lr 1e-4, wd 0.1) stays the distillation base; 0.2-alpha is retired.**
The ~62 GPU-hours turned "the pilot recipe is better" into a measured, disproven claim.

- Levers SETTLED for ViT-B (do not re-litigate on this backbone): LR (7e-5 > 1e-4 >
  5e-5 on pilot), epochs (40 does NOT help — exp8), recipe bundle (+0.0016, marginal),
  augmentation (light > strong — exp9 tested TRUE strong aug [0.08,1.0] + 5-view
  teacher caching and LOST on NABirds; the ~56 GPU-h full-corpus precompute was
  cancelled, saved by the cheap pilot test).
- ⚠️ **The 0.2 recipe changed SIX variables at once vs 0.1** (aug none→light, lr
  1e-4→7e-5, wd 0.1→0.2, beta2 default→0.95, +warmup 500, +grad-clip 1.0). So the
  recorded blame on "aug light + wd 0.2" is a GUESS across confounded variables — we
  know 0.2 lost, not which knob did it. The cleanest existing isolation is pilot exp1
  vs exp2 (both aug none: old recipe vs new recipe minus augmentation).
- **These SETTLED conclusions may NOT transfer to TinyCLIP.** A 2.2x capacity cut
  moves back toward the regime where regularization helps, so the 0.2 recipe could WIN
  on 39M. Run BOTH on the pilot-500 (cheap A/B) before committing to the full corpus.
  Informative ablation order: (1) 0.1 recipe, (2) 0.2 recipe, (3) 0.2 minus aug,
  (4) 0.2 with wd 0.1.

> ⚠️ **Two aug facts that were repeatedly confused** (corrected 2026-07-31 from
> checkpoint `args`, not prose): the **0.1 DISTILLATION used `aug none`**, the **0.2
> distillation used `aug light`**, and the **0.1 FINE-TUNE (`ft_clean_01`) used
> `aug light`**. The distillation stage and the fine-tune stage are different; do not
> conflate them. This mistake made an earlier section wrongly conclude "both recipes
> use aug light, so wd 0.2 is the differentiator" — wrong, aug IS a changed variable.

### Ground-truth fine-tune (the teacher-beating lever) and its rationale

Distillation caps the student at ≈teacher on the teacher's own task (the embedding IS
the target). To BEAT the teacher on real bird-ID, fine-tune on ground-truth species
labels afterward, keeping the FROZEN BioCLIP-2 text tower as fixed class weights (stays
open-vocab, all evals stay valid). This is a **WingDex extension, NOT prescribed by
MobileCLIP** (their paradigm is distill → zero-shot). The published handbook is
**WiSE-FT (Wortsman et al., CVPR 2022)** — see the reference section.

- **We do NOT do direct-from-scratch supervised training** (too data-hungry for 7,555
  fine-grained classes, overfits to iNat quirks, worse OOD, loses open-vocab +
  license-clean). Distill first, THEN fine-tune.
- **We do NOT have WingDex user-confirmed IDs** (not stored) — fuel is iNat labels +
  GPS/date metadata only.
- **The sampler bug (now fixed).** The original fine-tune set was 5,908 species /
  178,852 photos, but `build_groundtruth_split.py` never intersected with the species
  the distillation actually trained on — it silently pulled 2,058 data-starved species
  (5–49 total photos worldwide, 15.5% of the set) that FAILED the corpus ≥50 floor and
  were never distillation candidates. **Fixed (T2, 2026-07-30): clean set = 3,850
  species / 151,042 photos.** The 2,058 starved classes were pure dilution — removing
  them RAISED OOD slightly (NABirds 89.45 dirty → 89.93 clean) and lifted in-dist val
  63.39 → 77.61. ⚠️ In-distribution figures are NOT comparable across the two sets
  (5,908-way vs 3,850-way softmax); NABirds is the only fixed-basis comparison.

### Ship WORLDWIDE, occurrence-only, one blob (NEXT-1, decided 2026-07-31)

**John's call: ship WORLDWIDE, not region + on-demand fallback.** At these sizes
regional bundling buys ~0.4 MiB and costs region-detection + travel-fallback logic —
not worth it. Underlying cells stay 27 km regardless of tiling, so there is no
accuracy cost to shipping globally.

**🔴 DO NOT SHIP BIRDLIFE. Occurrence only.** Rationale:
- The committed plan shipped BirdLife ONLY for cells occurrence already covers, i.e.
  exactly where it is redundant (+0.30 pts) — incoherent.
- In uncovered cells the no-BirdLife fallback is pure vision (72.94 vs 88.29): a real
  but GRACEFUL degradation (worse ranking, not wrong-and-confident).
- Removes a licensed dependency, the 60 GB rasterizer, and 2.3 MiB. Kills the
  rasterizer-rewrite task outright.

**Payload = 5.41 MiB gzipped (the whole thing)**, vs the 260 MiB BirdLife layer
shipping today. Delivery: one static blob in `public/`, sliced client-side (see the
blob section above).

> Surviving open consideration: BirdLife folding COULD distinguish
> unobserved-but-plausible from unobserved-and-impossible as a per-cell SET of
> plausible species (~23.8 gzipped bytes/cell → ~2.3 MiB, i.e. 260 MiB → 2.3 MiB,
> 113x). At +0.30 pts for +2.3 MiB it is deferred, not adopted. Numbers extrapolated
> from 300 cells, ±50%.

### Refresh cadence: quarterly

The full occurrence build is ~2 min in DuckDB, no images, no GeoPackage, emits a
162 MB parquet. A 2-year-stale prior costs 2.88 pts (mostly drift), so quarterly (not
annual) is the recommendation.

### Licensing (SHIP GATE) — summary

Full analysis in the reference section. Bottom line:
1. **BioCLIP-2 teacher — CLEAN (MIT).** Distilling + redistributing is fine w/
   attribution. ✅
2. **Training data — CLEAN.** Openly-licensed iNat; ShareAlike EXCLUDED for MIT
   release; `ATTRIBUTIONS.md` bundled. ✅
3. **MobileCLIP-S2 — the only issue, now moot** because MobileCLIP is cancelled and
   the ship model is the clean LAION ViT-B. TinyCLIP (MIT) is the smaller-backbone
   path and has no license question.
- ⚠️ `train_student.py` defaults to `--pretrained datacompdr` (Apple's restricted
  weights) — FINE for research/measurement, but the SHIPPING config must use
  `laion2b_s34b_b88k` (the current ViT-B run does). TinyCLIP uses timm weights.

### The int4-collapse and web-size story (John, 2026-07-23)

- The <25MB number is the **Cloudflare 25 MiB per-asset limit** (26.2 MB), for BOTH
  Pages and Workers Static Assets. But WingDex already uses **R2** (free egress), so
  ">25MB forces R2" is moot — a 43/87 MB model from R2 is fine.
- The one real reason to still want <25 MiB: **abuse-proof free serving.** Workers
  static assets are structurally un-billable even under a download-flood; R2 reads
  are metered (free at normal traffic, but a malicious flood could push past the free
  tier). Both paths are $0 at normal scale; the difference is only under abuse.
- **Web is a fun flex, not a product requirement.** The point is "on-device WebGPU/WASM
  CLIP inference, no server", so web accuracy barely matters. int4 GPT-level-but-
  instant/offline/free is a genuinely good demo.

---

## Open questions / next steps (the queue)

Ordering principle: the ViT-B modelling questions are answered; remaining work is
INTEGRATION and the TinyCLIP backbone swap.

**[NEXT] TinyCLIP smaller-backbone distillation** (cheap pilot first, commit later).
The expensive asset already exists: 3.9 GB of cached BioCLIP-2 teacher embeddings
(`embeddings/`, architecture-INDEPENDENT, reusable for any student). `train_student.py`
already exposes `--arch`/`--pretrained`.
1. Teach `Student` to build a timm backbone when `--arch` is a timm name (currently
   only calls open_clip). Small change: create via timm, read `student_dim` from the
   dry-forward probe, keep the same projection + normalize.
2. ✅ **Teacher: WingCLIP-0.1. SETTLED 2026-08-02.** Measured on the full
   24,633-image NABirds eval: WingCLIP-0.1 teacher 89.09 vs BioCLIP-2 teacher
   83.44, a +5.65 win, identical recipe, only the teacher differs. The
   2026-08-01 claim that BioCLIP-2 won by +3.90 is RETRACTED: it was measured
   on a 7-species / 282-image subset and was void. See the TEACHER SETTLED
   section for the full result, including why val_cos is disqualified for
   this decision (it ranked the LOSING teacher higher, again).
3. Pilot distill TinyCLIP-39M on the ~496-species pilot, run BOTH the 0.1 and 0.2
   recipes (prior evidence is from a different capacity regime and does not transfer;
   ablation order above). Compare val_cos, then the real test: **NABirds top-1.**
   ⚠️ When comparing against WingCLIP-0.1's 89.93 or the teacher's 86.41, note those
   are FULL-SET (24,633 img, all species) numbers; pilot students restricted to their
   ~496 trained species are graded against a 282-image subset where the same teacher
   scores 91.49. Compare RETENTION over a common teacher, never raw top-1 across the
   two evals. DONE 2026-08-01, see the teacher note in step 2.
4. ⚠️ **The second fine-tune has a REDUNDANCY trap.** WingCLIP-0.1 was ALREADY
   fine-tuned on the 178k ground-truth photos; re-fine-tuning the TinyCLIP student on
   the SAME photos re-teaches what the teacher already encoded (double-counted signal,
   not eval leakage). Options, in order: (1) SKIP the second fine-tune and evaluate
   first — the target is already a fine-tuned model; (2) fine-tune on a DISJOINT slice
   (re-split by observation, or pull a FRESH iNat slice via `download_inat.py` +
   `build_groundtruth_split.py`, obs-split against BOTH the 178k set AND
   `calib_untouched.parquet` or the held-out eval is contaminated); (3) same set
   anyway, only if (1) shows a gap.
5. Then quantise and re-measure — int4 at 19.2 MB is the prize, but a 39M model has
   less redundancy to absorb quantisation, so re-measure the int4 cost. Optional
   later: progressive distillation (86.6M → ~60M → 39M) if the direct jump loses too
   much (TinyCLIP's own multi-stage scheme).

**[NEXT] Port the log-sum into `bird-id.ts`.** Replace the floor/tier/dominance stack
with `score = sim/T + beta·log P(species|cell)`. Delete the 0.2 floor,
slice-before-range, the ×0.65/×0.25 multipliers, the TIER table, and the dom>=0.5
gate. Fitted params in `ml/distill/calibration_occ_01.json`. Exit: production
reproduces the 88.29 offline number. (⚠️ If the model changes, re-fit T/beta —
NEXT-4.)

**[NEXT] Abstention redesign under the new ranker** (do properly). Abstention is TWO
decisions:
- **(a) ASK FOR A CROP** — a FRAMING problem, and the softmax gate CANNOT trigger it
  (Spearman 0.032; low confidence = species ambiguity). Needs a real signal: iOS
  Vision animal detection (boxes + count, on-device, free), ViT patch saliency, or
  multi-crop consistency — all validatable against NABirds boxes.
- **(b) GUESS WITH LOW CONFIDENCE** — the prior does most of the work below vision
  conf 0.6 (correct: when the image can't decide, location is the best evidence). UI
  must be honest it is a guess; a guess must NOT silently enter a life list as a
  confirmed sighting.
- ⚠️ **ALL existing abstention thresholds are INVALID** — they were measured on the
  OLD uncalibrated softmax (median conf 0.675 → 0.85 after temperature; the log-sum
  moves it again). Re-measure every threshold, and re-check non-bird rejection (a
  geographic prior may make a dog look MORE like a locally-common bird). Use the
  prior-dominance regimes (>0.9 skip lookup, <0.6 change wording) as the design basis.

**[NEXT] Independent-source / coverage validation** (the standing blind spot). Every
number rests on iNat photos with an iNat-derived prior; every calibration photo IS an
iNat observation, so the eval set structurally cannot contain an uncovered cell.
Untested: SOURCE transfer and the coverage gap. eBird is unavailable (no reply). GBIF
adds nothing where iNat is dense (measured) but is UNMEASURED in iNat-sparse areas. To
probe the coverage gap: sample locations from a NON-observation source (population
grid / road network) and measure the zero-data fraction, weighted by land area +
population (most of the 99,900-of-681,023-cell gap is ocean/uninhabited). Cheap next
check: temporal holdout is done; consider a density-matched GBIF-sparse probe.

**[AFTER] Export + web.** int8/ONNX/Core ML (Core ML via coremltools from torch,
skips the blocked ONNX fp16); then int4 for web. **Solve the ONNX fp16 export before
any WebGPU work** (try newer onnxruntime/onnxscript dynamo path, fp32→onnxslim, or
coremltools directly). Real WebGPU latency + download/cache timing still unmeasured.

**[NEXT-4] Re-fit the ranker if the model ever changes.** All fitted params (T, beta,
and the prior-dominance thresholds) are for WingCLIP-0.1 @ alpha=0.90 and are NOT
transferable — re-run `emit_calib_candidates` + `fit_occurrence`.

**BACKLOG (not blocking):**
- Aggressive fine-tune sweep (ours moved weights gently, lr 1e-5/12ep; try
  lr 3e-5..1e-4 / 25ep and re-sweep alpha — a harder fine-tune would likely move
  optimal alpha DOWN toward the paper's ~0.5).
- `--per-species` sweep for the fine-tune set (40 was never tuned; ~0.4% of ~49M
  untouched photos available).
- Shard the ground-truth corpus (178k loose JPEGs = ~9 min/epoch; sharding pays off
  if the fine-tune becomes a sweep).
- Stock MobileCLIP-S2 vs our student (research-only weights, writeup comparison only,
  NOT a ship path — inference-only, GPU-when-free).
- Co-occurrence hard-example weighting (built, never wired into `train_student.py`;
  a DISTILLATION-time signal, so testing it costs a FULL RETRAIN ~60h; unvalidated).
- cosine→accuracy curve (needs per-epoch checkpoints on a future run).
- RealBirdID abstention benchmark — NOT released as of 2026-07-21
  (`cvl-umass/RealBirdID` usedStorage=0), watched by cron `realbirdid-release-watch`
  (daily 9am); wire in when data lands.

**SETTLED — do not re-litigate** (for ViT-B):
- distillation recipe question is answered: 0.1-alpha (old recipe) is the base; the
  0.2 "locked recipe" lost at full scale.
- epochs 40 does NOT help (exp8); strong aug does NOT help (exp9, saved 56 GPU-h).
- ship arch = LAION ViT-B/16 (clean); MobileCLIP-S2 cancelled (license); TinyCLIP is
  the smaller-backbone path.
- always pass `--pilot-species 0` to `eval_nabirds.py` for any shippable number.
- ranker = occurrence log-sum (I); BirdLife and GBIF add ~nothing on top of iNat.

**Definition of done (from #260):** distilled student trained + quantized +
ONNX/Core ML export; benchmarked vs GPT and ViT-L on the shared gated+range pipeline;
go/no-go writeup: does a <25 MB (or <86 MB) student beat GPT?

---

# Reference material

Detailed background, rationale, and the full research record. Current truth is above;
this section preserves the "why" and the negative results.

## The problem

WingDex needs on-device (iOS + browser) bird species ID. The best open teacher,
**BioCLIP-2** (ViT-L/14, ~428M params, ~1.7 GB), is far too big to ship on a phone.
GPT-4.1-mini / GPT-5.4-mini vision (current WingDex prod) is accurate (~83/87 top-1/5
on the golden set) but is a paid API call per photo, needs a network round-trip, and
gives no calibrated "I'm not sure" signal. We want a small (<25 MB stretch / <86 MB
fallback), fast, offline model that keeps most of BioCLIP-2's accuracy AND can abstain.

### Why on-device, why BioCLIP-2

- iOS 27 Foundation Models on-device LLM gained vision but is a generalist, weak at
  fine-grained species ID (Apple's own WWDC guidance routes species ID to a specialist
  via tool calling).
- Merlin (the gold standard) does NOT use an LLM: purpose-built on-device CNN
  (Visipedia/Cornell) trained on eBird's private corpus. Not obtainable.
- **BioCLIP-2** (`imageomics/bioclip-2`, NeurIPS'25): CLIP ViT-L/14 retrained on
  TreeOfLife-200M (200M organism images, 952K taxa). MIT, exports to ONNX + Core ML,
  one model for web + iOS + Android. SOTA open bird encoder (RealBirdID: 41% genus /
  76% species).

## Spike findings (Phase 0, 2026-07-20) — why distillation is the only path

### Zero-shot BioCLIP-2 + recalibrated range pipeline beats GPT

On the 27-image benchmark (`src/assets/images`), scoring image embedding vs text
embeddings of all 11,167 species in `src/lib/taxonomy.json` (23 scorable, 4 ambiguous
excluded):

- gpt-5.4-mini (current prod): 83% / 87%
- BioCLIP-2 raw zero-shot (no range): 70% / 87%
- BioCLIP-2 through prod pipeline **as-is**: 70% / 70%
- **BioCLIP-2 + recalibrated pipeline (Strategy F): 87% / 96%**

**Our pipeline was shaped for GPT, not a classifier.** As-is it drops BioCLIP to 70/70
because three steps are tuned to GPT's confidence semantics: (1) a `confidence >= 0.2`
hard floor deletes the true species (BioCLIP softmax over 11k puts hard-image truth at
0.01–0.05); (2) `slice(0, 5)` before range adjustment throws away the in-range truth
at rank 6–15; (3) the multiplicative range penalty (×0.65 OOR) is too gentle for
BioCLIP's tiny margins. **Strategy F** (confidence-gated tiering): keep top-K (K=15);
if #1 dominates (score − #2 ≥ 0.5) trust the visual ID and keep raw order; otherwise
hard-partition by range tier (present > near-range > out-of-range), keep BioCLIP order
within each tier. Stable across domMargin 0.45–0.70.

> Strategy F was the best-known ranker at spike time; it has since been superseded by
> the occurrence log-sum (Strategy I, 79.53 → 88.29 absolute on the leak-free set).
> The three GPT-era pipeline bugs above are exactly what I removes.

**Range-data bug (benefits prod too):** `nearestNeighborCell` in
`functions/lib/range-filter.ts` / `range-adjust.js` only checks ONE neighbor, so
coastal/boundary points get wrongly flagged out-of-range. Fix = scan the full 3×3 ring
(`lookupRangeExpanded`, first hit → near-range). Follow-up independent of BioCLIP:
port into `functions/lib/range-filter.ts`.

Remaining spike misses (2/23, unfixable by range): Chukar@Maui (loses to same-genus
Rock Partridge, real near-tie); Double-crested Cormorant@Skagit (not in top-50, true
classifier failure).

### Browser feasibility: accuracy is inseparable from ~307 MB (measured 2026-07-20)

- ViT-L/14 int8: **307 MB → 87/96** (only variant that beats GPT)
- ViT-B/16 int8: 86 MB → 70/74 (below GPT)
- ViT-L q4 (bs32/128): 254–280 MB → 78/87 (barely smaller, drops to GPT level)

fp32 ONNX 1217 MB / fp16 609 MB / int8 307 MB (max abs diff vs torch 1.8e-2). Plus
text-label matrix (11,167×768) int8 gzipped 7.9 MB (shipped once → browser never runs
the text encoder). Inference (ONNX CPU, 8-core Ryzen): fp32 508 ms, int8 325 ms;
browser WASM ~2–4× slower; WebGPU intended path.

**Verdict:** iOS → ship ViT-L int8 via Core ML (307 MB fine, Neural Engine handles it).
Web → keep GPT (307 MB cold download is rude, ViT-B too weak, a BioCLIP server has no
edge over the GPT call). Cloudflare Workers AI → no (fixed catalog). **The only path to
"small AND accurate" is knowledge distillation** — this project.

## Input resolutions (teacher 224 / ViT-B 224 / MobileCLIP-S2 256; source 500px)

Storage res ≠ model-input res:
- **On disk:** iNat `medium` JPEGs, longest edge 500px. Just the raw file; never train
  at 500px.
- **Teacher (BioCLIP-2): native 224**, resized ONCE at precompute and baked into the
  cached embeddings (teacher never runs at train time).
- **Tuning student (ViT-B/16): native 224**, resized live per step.
- **Shipping student (MobileCLIP-S2 / FastViT): native 256** (open_clip config).
  Different input res from the 224 teacher is fine — both land in the same 768-d space.
- The `256` zero-tensor in `train_student.py` is only a decode-failure fallback for
  the ViT-B run, NOT its input res (224).

**Higher-res lever for the ground-truth fine-tune:** ViT-B/16 accepts 256/336 via
interpolated position embeddings, and 500px source supports it. During *distillation*
it barely helps (ceiling = teacher's 224 embedding); during the *fine-tune* (true
labels, not teacher-matching) higher res could genuinely help — test in a sweep.

## The approach: feature distillation into the teacher's embedding space

Standard KD copies output logits; we do **feature (embedding) distillation**:
1. **Teacher = frozen BioCLIP-2.** Precompute + cache each corpus image's 768-d
   L2-normalized embedding (~2.6M images → 366 shards). Done ONCE.
2. **Student = a smaller CLIP image encoder + a linear projection** into the 768-d
   space. Train so student embedding matches the cached teacher embedding via **cosine
   loss** `1 − cos(student, teacher)`.
3. **Classification is zero-shot, shared** — the student lives inside the teacher's
   geometry, so BioCLIP-2's text classifier works UNCHANGED.

### Why this design

- **Model-agnostic + future-proof** (distil the embedding, not logits over a fixed
  taxonomy). **Cheap iteration** (cached embeddings → pure student-forward; full
  7,555-sp epoch ~2.3h on one 3080). **Built-in abstention** (softmax over image-vs-text
  sims → calibrated confidence). **License-clean** (openly-licensed iNat, ShareAlike
  excluded → MIT release). **Single consumer GPU** (RTX 3080 10GB; pilot ~3h, full run
  ~1.5 days vs the teacher's 8–176× A100 node-days).
- **Transfer, not random init:** student inits from LAION-2B CLIP weights
  (`ViT-B-16 / laion2b_s34b_b88k`); only the 512→768 projection starts random.
  Distillation *specializes* an already-smart encoder — cosine sim jumps ~0 → ~0.77 in
  the first 50 steps.

⚠️ **The argmax-vs-softmax root cause** (why Phase 4 failed while NABirds excelled):
cosine distillation constrains embedding DIRECTION, so ORDERING is preserved (NABirds
argmax is great) but the SPREAD of the sims is UNCONSTRAINED. A student can rank
correctly while producing 0.31/0.29/0.28 where the teacher produces 0.42/0.24/0.22 —
same winner, far flatter softmax. Every downstream threshold then misfires. It is a
monotonic rescaling problem (the easiest kind); the fix is calibration (temperature +
occurrence prior), no retraining. Our top-5 MATCHES the teacher at 96%.

## Two-architecture plan (decided 2026-07-22; ship arch later changed)

- **Tuning arch: ViT-B/16** — trains fast (~316 img/s, batch 96, 3080). Develops the
  recipe; distillation-preserves-accuracy is arch-agnostic.
- **Original shipping arch: MobileCLIP-S2 (FastViT)** — ~15–20 MB, CoreML/ONNX-ready.
  **CANCELLED (license + no basis weights); replaced by TinyCLIP** (see Decisions).
- **The ViT-B/16 student is ITSELF shippable** (int8 87 MB / int4 43 MB) — this is now
  the shipped model; a smaller backbone (TinyCLIP) is the sub-25 MB path.

**FastViT training-speed caveat (moot now MobileCLIP is dropped, kept for record):**
MobileCLIP's FastViT uses MobileOne-style train-time overparameterization (parallel
depthwise-conv branches fused only at inference), slow to TRAIN on desktop Ampere.
Measured ~17s/step (batch 64) on the 3080 — but that figure is SUSPECT (GPU was
thrashing; the ViT-B "48 img/s ceiling" that day was a batch-128 VRAM-wall artifact,
batch 96 ran 6× faster at 314 img/s). Never cleanly re-measured. FastViT is fast at
iPhone Neural Engine *inference* after reparameterization, not dGPU *training*.

**Batch size:** the 96 limit is ViT-B-specific (86M-param transformer, 224px: batch
128 hit the 10GB wall → 48 img/s; 96 fit → 314 img/s). Do NOT carry it to a different
arch — measure.

### Cloud GPU rental (fallback only, almost certainly NOT needed)

The "need cloud" conclusion rested on the suspect 17s/step number; the WebDataset
migration showed ViT-B is GPU-bound, not I/O-bound (see below). If ever needed it's a
sub-$20 afternoon on one GPU (RunPod / Vast.ai; full run ~30h on the 3080, ~8–10h on
an A100 → ~$10–20). Not a cluster.

## Adopt upstream training path (option A, decided 2026-07-23)

Our `train_student.py` was hand-rolled (a simple loop opening 2.6M random small JPEGs).
Per the standing rule (adopt proven prior art), route final runs through Apple's tuned
data path.

**Apple `ml-mobileclip` reality** (re-clone from github.com/apple/ml-mobileclip if
needed): their DataCompDR training uses `open_clip_train.main --dataset-type webdataset`
over `.tar` shards, `--precision amp`, `--grad-checkpointing`, and a `dr/` loader that
pulls per-sample teacher reinforcements from the tar. Fast sequential reads. But their
recipe is full CLIP **contrastive** training (image+text towers, synthetic captions,
global batch 8192 on 8×4 GPUs, lr 1e-3).

- **Option A (CHOSEN): adopt their FORMAT + dataloader, keep our loss.** Repackage
  corpus + cached BioCLIP-2 embeddings into WebDataset `.tar` shards (image bytes +
  768-d teacher embedding + taxon idx), use open_clip's webdataset dataloader, keep our
  **image-only cosine feature-distillation** loss. Big dataloader speedup + a
  better-tuned loop WITHOUT the contrastive recipe or a text tower.
- **Option B (REJECTED): fully adopt DataCompDR contrastive training.** Would require
  synthetic captions + a text-capable teacher, changing our whole method. Our thesis is
  image-only distillation from BioCLIP-2, reusing its text tower zero-shot.

**Training reads shards from the NAS** (verify, don't assume): ~300 img/s × ~100KB ≈
~30MB/s of raw JPEG, trivial for 10GbE + sequential RAID5. Real risk is
latency/contention/seeks, not bandwidth. Measured: the WebDataset loader alone hit
~640 img/s from the NAS (vs ~306 old) but end-to-end training stayed ~302–320 img/s —
**we are GPU-bound, not I/O-bound**, so the random-small-file loader was NOT what
capped ViT-B. NAS throughput is a non-issue for ViT-B; the WebDataset win should matter
more for cheaper-per-image archs (FastViT/TinyCLIP).

**Image resolution + JPEG decode in the tar (don't pre-optimize):** per-step cost is
read → **decode JPEG** (usually heaviest) → resize → crop → normalize. Levers in order:
(1) sequential tar reads at 500px original (free, do first — may already saturate the
GPU, keeps all options open); (2) faster decoder (libjpeg-turbo/Pillow-SIMD, GPU JPEG
decode via nvJPEG, more workers — no downside); (3) pre-resize (LAST resort, permanently
discards data — resize to ~320–384px headroom, NEVER 256, to keep RRC + the higher-res
fine-tune lever). Teacher embeddings are cached at 224, so pre-resize only affects the
student input.

## What MobileCLIP's papers say (recipe we borrowed), read 2026-07-23

Read both papers (MobileCLIP CVPR'24 arXiv 2311.17049; MobileCLIP2 TMLR'25 arXiv
2508.20691). Their full method is multi-modal contrastive (which we don't do), but the
dataset-reinforcement + aug + optimizer backbone transfers to our image-only cosine
distillation.

**Their loss (context, NOT ours):** `L = (1-λ)·L_CLIP + λ·L_Distill`, L_Distill = KL
between teacher/student image-text affinity matrices. λ ablation: **λ=1.0 optimal for
ImageNet (pure distillation), λ=1.0 for small variants (S0/S1/S2)**. Takeaway: **our
λ=1.0 image-only cosine setup is the validated regime for small models** — we are not
missing the contrastive term for our use case.

**What we adopted (transfers to image-only):**
1. Cache teacher embeddings once in BF16 + lossless compression (we already do, fp16
   npz).
2. Store multiple augmented-view embeddings per image with reproducible aug params;
   perf saturates ~5 augmentations. **This is a real gap** (we cache ONE 224 embedding,
   so the student can't learn augmentation invariance vs matching targets) — but GATED
   behind a cheap pilot experiment (see exp9: it LOST, so the ~56 GPU-h multi-view
   precompute was cancelled).
3. STRONG augmentation in distillation: RRC [0.08, 1.0] + RandAugment, +4.8% IN-val.
   **Only sound IF the teacher target matches the student's view.** We cache ONE
   center-crop 224 embedding, so applying RRC [0.08,1.0] today trains toward a
   CORRUPTED target — this is why we use `--aug light` (RRC 0.65–1.0 + hflip: mild
   enough that the crop still contains what the cached target describes). `--aug none`
   is exactly the teacher's view.
4. Optimizer: AdamW, β=(0.9, 0.95), cosine LR 1e-3→1e-6, warmup ~2k iters, wd 0.2,
   BF16, grad-clip 1.0. Their lr 1e-3 is from-scratch at batch 8192; we fine-tune from
   LAION at batch 96, so our 1e-4 (later 7e-5) is reasonable.

**Why strong aug's payoff may be smaller for us:** their gain is on ImageNet
from-scratch at batch 8192 / 12.8M pairs; we fine-tune from LAION on 2.5M birds for ~20
epochs (our full run plateaued cleanly, so we may not be in the overfitting regime
where strong aug wins). At 5 views × 20 epochs each view repeats 4×, less diversity
than true random cropping — "perf saturates ~5" is a claim about THEIR setup.

**What we DROP (multi-modal, inapplicable):** the CLIP contrastive term, synthetic
CoCa captions, text-embedding caching, the K=2 teacher ensemble, per-teacher
temperature tuning. **MobileCLIP2 deltas** (better DFN teacher ensembles, improved CoCa
captioners, S3/S4 archs, +2.2% IN-1k) are nearly all on the multi-modal side; the one
transferable meta-lesson is "a better teacher → a better student", which reinforces
keeping BioCLIP-2 (and, for TinyCLIP, using WingCLIP-0.1 as the teacher).

## Ground-truth fine-tune: fuel, leakage, and the WiSE-FT handbook

Fuel we have:
- **Research-grade iNat labels are real human ground truth** (2+ independent
  identifiers agree). Corpus built `--research-only`.
- **~49M untouched photos** — iNat has 52.0M research-grade open-licensed candidates
  across our species; we downloaded 2.65M (cap 500/species). The rest is a leak-free
  reservoir, concentrated in COMMON species (rare ones are cap-limited by scarcity).
- **GPS/date metadata (99.8% coverage)** — the biggest teacher blind spot (BioCLIP-2 is
  image-only). Two uses: inference-time range filter, and training-time hard-example
  weighting.

**Leakage caveat:** distillation and this corpus share images. Fine-tuning a pure
image-only classifier on the SAME 2.65M re-touches data the student already saw → to
actually beat the teacher, build a clean held-out split from the untouched 49M pool,
sampled BY OBSERVATION not photo, and especially fuse GPS/season metadata.

**WiSE-FT (Wortsman et al., CVPR 2022, arXiv 2109.01903)** — read in full 2026-07-23:
- Problem: naive fine-tuning raises in-distribution accuracy but DEGRADES OOD
  robustness (exactly our risk). Validated on WILDS-iWildCam (wildlife), analogous to
  birds.
- Method: (1) standard fine-tune the zero-shot model; (2) weight-space ensemble
  `θ = (1−α)·θ_zeroshot + α·θ_finetuned` (element-wise weight average, not outputs). A
  few lines, zero extra train/infer cost. α=0.5 recommended with no domain knowledge.
- CRITICAL for us: WiSE-FT interpolates a fine-tuned model with ITS OWN zero-shot start
  (must share an optimization basin). Our "zero-shot start" is the DISTILLED STUDENT,
  so (a) fine-tune FROM the distilled checkpoint, (b) ensemble = distilled-student ↔
  its-fine-tuned-version. Keeps the teacher-embedding geometry.
- Cited by MobileCLIP2 as THE reference for specializing CLIP encoders.

## Observation-level leakage + dedup (verify early)

iNat groups multiple photos per **observation** (burst frames, same perch). Manifest
carries `observation_uuid`.
- **(A) EVAL leakage — MEASURED, real but bounded:** the 2% val split in
  `train_student.py` splits by photo. 2,503,107 photos / 1,588,150 obs = avg 1.58
  photos/obs; 45.6% singletons; no huge bursts (max 165). With a by-photo split ~54% of
  val photos have a train sibling → `val_cos_sim` is optimistically biased. Impact is
  limited because the SHIP metric (NABirds) is leakage-IMMUNE, val_cos is just a
  progress monitor, and for retention the bias partly cancels. **The ground-truth
  held-out eval MUST be split by `observation_uuid`** (it is).
- **(B) TRAINING variety — MEASURED:** even the 3,871 capped species are
  observation-diverse (avg 323 distinct obs, min 78). Cheap reselection dedup NOT worth
  it (just shrinks capped species 500→~460, loses data). Backfill dedup (drop 17.7%
  burst-excess AND download+embed fresh distinct obs to refill) is a real-but-costly
  option, only if common species underperform.

## Licensing (SHIP GATE) — full analysis

**Context (2026-07-23):** (1) The <25MB target is a WEB constraint (Cloudflare static
asset), NOT iOS (apps are routinely 100s of MB; iOS only cares about SPEED, and
BioCLIP-2 ViT-L int8 307MB already runs fine on the Neural Engine). The small model is
fundamentally a WEB play. (2) WingDex is non-commercial (no revenue), which may or may
not clear Apple's "Research Purposes" terms.

1. **BioCLIP-2 teacher — CLEAN (MIT).** ✅
2. **Training data — CLEAN.** Openly-licensed iNat; ShareAlike EXCLUDED for MIT
   release; `ATTRIBUTIONS.md` bundled. ✅
3. **MobileCLIP-S2 — the only issue (and now cancelled):**
   - Architecture/code (`LICENSE`): MIT. ✅
   - Pretrained weights (`LICENSE_MODELS`): "Research Purposes" only; "Model
     Derivatives" (retraining/fine-tuning) inherit it. `datacompdr` = Apple's restricted
     init. **No non-Apple MobileCLIP-S2 checkpoint exists.**
   - Does non-commercial status clear Apple's terms? AMBIGUOUS (the terms exclude
     "product development" and "use in any product" separately from "commercial"). A
     shipped App Store app with a trademark reads like "product use". Genuine
     legal-interpretation call — de-risk by emailing Apple ML, or avoid entirely.

**What it takes to build a LAION MobileCLIP-S2 ourselves** (analysis 2026-07-23):
real research-scale effort — Apple's efficient recipe is ~1 A100-week/model (~$200–500
rented), and the data pipeline (synthetic captions + 2×ViT-L teacher-ensemble
embeddings, or plain LAION which is 10–1000× less sample-efficient) is GPU-DAYS of
preprocessing. **Key insight:** if you're spending that compute training FastViT from
random anyway, fold bird distillation INTO that run (train FastViT directly toward
BioCLIP-2's bird embeddings) — same cost, ONE run, a bird model directly. Not worth it
unless <25 MB is non-negotiable. (This is what TinyCLIP now sidesteps: MIT weights, no
from-scratch training.)

**Open-weights small-arch scout (2026-07-23):** quantization can't rescue a big model
(int8 is the sweet spot; int4 breaks fine-grained margins and only gives ~1.2x beyond
int8; web needs 12x). Scouted open_clip small archs with clean weights: ViT-B/16 (86.2M,
the fallback), ViT-B/32 (87.8M, same size, weaker), convnext_base_w (88.2M), **RN50
(OpenAI, 38.3M, ~38MB int8 — the only off-the-shelf clean option meaningfully smaller
than ViT-B**, older CNN, likely weaker), SigLIP (only ≥400M). **No open-weights CLIP
<25MB exists** — the floor is RN50 (~38MB) or Apple weights (license) or from-scratch.
(TinyCLIP, found 2026-07-31, changes this: MIT, 38.3M → 19.2 MB int4.)

## Pipeline scripts (`ml/distill/`, run in order)

- `fetch_metadata.py` — resumable HTTPS pull of iNat Open Data taxa/observations/photos
  `csv.gz` dumps (S3 `inaturalist-open-data`, no 60 req/min API cap).
- `build_manifest.py` — DuckDB join (photos→observations→taxa), filter to target bird
  taxa + open licenses, per-species floor/cap → `manifest.parquet` + `target_taxa.csv`
  + `manifest_stats.txt`. (`target_taxa.csv` is the PRE-filter list of all 11,167
  taxonomy species, not the post-filter list — this caused a sampler-bug misdiagnosis.)
- `pull_images.py` — parallel S3 fetch (32 workers, resumable) →
  `corpus/<inat_taxon_id>/<photo_id>.<ext>` + `download_manifest.jsonl` + `failures.log`.
- `build_cooccurrence.py` — grid-cell (~27km) species co-occurrence from corpus GPS,
  for training-time hard-example weighting. Built + tested, NOT yet wired into
  `train_student.py`.
- `precompute_embeddings.py` — batched GPU forward of the frozen teacher →
  `embeddings/shard_*.npz` (photo_ids int64, embeddings fp16 [N,768], L2-norm).
- `prep_training_set.py` — emit `train_manifest.parquet` (ShareAlike EXCLUDED by
  default; `--keep-sharealike` research variant) + `ATTRIBUTIONS.md`.
- `train_student.py` — the distillation trainer. `--arch` (default `ViT-B-16`),
  `--pilot-species 500` (`0` = full 7,555), `--wds`, `--smoke`, `--patience`, `--batch`,
  checkpoints `best.pt`/`last.pt`. `Student.forward()` = visual → proj → normalize.
- `pack_webdataset.py` — corpus JPEGs + cached embeddings → `.tar` shards (verbatim jpg
  bytes + `.emb` fp16 768-d + `.cls` inat_taxon_id). `--pilot-species N` for a scattered
  top-N pilot set. Writes directly to the NAS.
- `verify_shards.py` — shard integrity (`--max-dup-gap` tolerates the manifest's
  duplicate photo_ids).
- `wds_loader.py` — our cosine-loss webdataset dataloader (Apple's `dr/` NOT adopted —
  it replays per-augmentation params for the reinforced-dataset scheme we don't use).
  Includes a deterministic blake2b hash train/val split (fixed the last-shard-only bug).
- `build_groundtruth_split.py` — obs-split leak-free ground-truth set (`--per-species`,
  `--min-per-species`; now intersects with trained species after the sampler fix).
- `finetune_groundtruth.py` — the ground-truth fine-tune (FROZEN text tower).
- `eval_student.py`, `eval_heldout.py` (`--wds`), `eval_nabirds.py` (`--onnx`,
  `--pilot-species`) — eval harnesses.
- `fit_occurrence.py`, `ablate_priors.py`, `emit_calib_candidates.py`,
  `build_prior_blob.py`, `verify_prior_blob.py`, `temporal_holdout.py`,
  `make_calib_fixtures.py` — occurrence-rerank fitting/build/verify.
- `export_onnx.py`, `quant_accuracy.py`, `quant_sweep.py` — export + quantisation.
- `select_species.py`, `download_inat.py`, `lic_query.py`, `nabirds_map.py`,
  `bench_fastvit.py`, `run_experiments.py` — API-era / license / mapping / bench /
  experiment-matrix helpers.
- `ml/scripts/` — `pipeline-experiment.mjs` (the JS harness, `--truth`), `list-cells.mjs`,
  `download-range-cells.mjs`, `js-cells-check.mjs`, `t1_coverage_split.py`,
  `t3_wise_verify.py`.

Corpus (2026-07-22): floor 50 / cap 500 → 7,555 species, 2,646,057 manifest rows,
~2.645M imgs (~262 GB). 2,503,107 kept after ShareAlike exclusion (the 142,950
difference = CC-BY-NC-SA 79,411 + CC-BY-SA 63,539, exact — NOT a second cap). Resumable
everywhere; license-audit ready.

**Tooling note (no W&B/Optuna/Hydra):** one GPU + a 5-run grid, so `run_experiments.py`
is a plain sequential loop over a JSON spec. Borrowed the good parts: structured
per-run results, resumability, a gpu-busy guard, a hard stop after N failures.

**Environment: uv.** `ml/distill/pyproject.toml` + `uv.lock` (58 packages), venv at
`ml/distill/.venv` (gitignored). Gotcha: torch cu124 wheels are NOT on PyPI, so
`tool.uv.index` + `tool.uv.sources` pin torch/torchvision to the pytorch cu124 index
(without that, uv silently resolves the CPU build and CUDA disappears).

## Where things live (✅ consolidated 2026-07-25)

**ONE directory: `~/wingdex/ml/distill/` on tomahawk.** No sibling copy, no symlink
farm, no drift. Heavy work runs on tomahawk (RTX 3080).

- **Code + docs:** this git repo, branch `bioclip-distill`. GitHub (`jlian/wingdex`) is
  the durable record — readable even when tomahawk sleeps.
- **Env:** `ml/distill/.venv` (uv). Rebuild with `uv sync`.
- **Data (~40GB, gitignored):** `runs/`, `embeddings/` (3.9GB, 366 shards, ~12.4M
  BioCLIP-2 teacher embeddings 768-d fp16), `nabirds/` (9.5GB), `nabirds_meta/`, the
  manifests, `taxonomy.json`, attributions, `logs/`, `ml/groundtruth/corpus/` (19GB,
  178,804 photos / 5,908 species — the fine-tune set), `calib_untouched.parquet`.
- **Training data (NAS — the DOCUMENTED design, not a discovery):**
  `/mnt/nas/WingDex-Distill/wds/` (251–252 shards, 252GB, 2,502,898 samples) and
  `/mnt/nas/WingDex-Distill/wds-pilot500/` (25–26 shards, 25GB, 247,400 samples; the
  name says 500 but it packs **496 species** — see the tie-break bug below). The
  **262GB loose `corpus/` was DELETED 2026-07-25** (gated on exp1 reproducing the pilot
  baseline off shards, 0.9447 vs 0.9465); every image lives in the shards
  byte-identically and is re-downloadable via `pull_images.py`. Freed 261GB.
- **Backup:** `/mnt/nas/WingDex-Distill-Backup/20260724/`.
- **GeoPackage (BirdLife):** `/mnt/nas/WingDex-Distill/birdlife-shp/BOTW_2025.gpkg`
  (9.31GB) + crosswalk/attribute docs. Only needed if the BirdLife blobs are ever
  regenerated (which occurrence-only shipping avoids).
- **Phase-0 spike artifacts:** `ml/spike/` — 16 scripts + 162 embedding fixtures
  (provenance for the spike findings).

> ⚠️ SSOT accuracy lesson (2026-07-31): the NAS corpus location was ALREADY documented
> here; it is the intended design, not a recovery. **Grep this file before treating
> anything as missing.**

## Target runtime is undecided — and the int8 format was chosen before the target

The app has NO on-device inference infrastructure yet: no `onnxruntime-web`,
transformers.js, WebGPU, or Core ML. Inference today is a server-side GPT-5.4-mini call
from `functions/`. So "what are we shipping" has no settled answer, and dynamic int8
(built first) implicitly assumes a CPU runtime:

| target | wants | dynamic int8 right? |
|---|---|---|
| iOS Core ML | fp16 / palettisation (coremltools from torch, does its own) | no |
| Web WebGPU | fp16 (GPU ignores dynamic int8) | no |
| Web WASM/CPU | dynamic int8 | **yes** |

Only the third matches the artifact built — but CPU/WASM is genuinely viable at 144 ms
(see latency), so int8 is retroactively justified. The `quant_sweep.py` measures all
formats through identical logic (preprocesses once into a memmapped cache, ~40 s/variant
vs ~30 min). Note `quant_accuracy.py` was reverted to STREAMING (preprocess batch →
embed → discard, 3 GB RAM, 22 s/variant) after the whole-dataset cache OOM-killed twice
(7.4 GB stacked, `torch.stack` briefly doubles it) and was actually slower than
re-decoding.

## In-browser adaptive-router demo (`ml/demo/`)

Proof of the **adaptive router**: one shared pipeline with a swappable front-end
(on-device BioCLIP-2 when available, GPT fallback otherwise). Both emit
`{species, confidence}[]`; the whole post-processing path is shared; the router only
swaps which model produces candidates.

```
model cached?            -> BioCLIP on-device (instant, free, offline)
not cached, fast/wifi    -> GPT now + background prefetch, switch when ready
not cached, slow/metered -> GPT; optionally offer "download ~300MB for offline"
```

Loads ViT-L int8 (307 MB) via onnxruntime-web + WebGPU (WASM fallback); background
prefetch; persistent Cache API; softmax gate (<0.6 → manual crop); text embeds shipped
as 8.6 MB int8 matrix. Files: `index.html`, `router.js`, `serve.mjs` (COOP/COEP
headers), `models/` (not committed). **Verified** (`validate_node.js`): int8 ONNX loads
+ faithful embeddings; raw 74/83 pre-range matches PyTorch; CPU ~335 ms/img.
**Pending** (needs a real WebGPU browser session): actual WebGPU latency, download+cache
timing. (The demo currently loads BioCLIP ViT-L at 307MB; swapping in our own 43/87 MB
WingCLIP makes the flex pleasant.)

## Teacher + future improvement passes

**Teacher = BioCLIP-2 ViT-L/14** (`hf-hub:imageomics/bioclip-2`) — only variant that
exists. Teacher size is a train-time cost only. **Ensemble / multi-teacher = deferred**
(first student is single-teacher for a baseline + confusion matrix; then targeted
GPT-label the confused hard pairs and blend). For TinyCLIP, the teacher is WingCLIP-0.1
(which beats BioCLIP-2 on NABirds), not BioCLIP-2.

## Phase 4 eval anchors

Run the student through the same gated+range pipeline (`pipeline-experiment.mjs`) on the
27-image set + a larger held-out set; compare top-1/5 vs GPT (83/87, golden-set-only)
and ViT-L (87/96). Anchors:
- **NABirds** (HF `zguo0525/nabirds-dataset`, ~48K imgs / 555 NA species, expert labels
  + boxes) — primary labeled anchor.
- **CUB-200-2011** (HF `syedashfaq/CUB_200_2011`, 11,788 imgs / 200 sp) — quick FGVR
  sanity.
- **RealBirdID** (arXiv 2603.27033, CVPR'26, MIT) — headline abstention-aware
  benchmark. NOT RELEASED as of 2026-07-21; watched by cron `realbirdid-release-watch`.

## Detection / localization + offline range data (open integration problems)

- GPT returns `birdCenter` / `birdSize` / `multipleBirds`; a pure classifier doesn't.
  Substitutes: iOS Vision framework animal detection (boxes + count, free); web manual-
  crop UX (`crop-math.ts`, model-agnostic) + the softmax gate. ⚠️ The softmax gate is
  NOT a crop trigger (Spearman 0.032; see abstention) — this earlier framing was DESIGN
  INTENT, never validated, and is now disproven for the range NABirds covers.
- Offline range data: 27km Equal Earth grid (1276×618). Ship the occurrence blob
  (5.41 MiB), not the full BirdLife store. Lookup = grid index + vector op.

## Cosine vs retention (mental model)

- **`val_cos_sim` is NOT "% as good as the teacher"** — it's geometric alignment of
  768-d unit embeddings, nonlinear/saturating. Read the RESIDUAL `(1-cos)`: pilot 0.9464
  → 0.054; congeneric species sit <0.02 apart in text-embedding space, so the last
  hundredths of cosine are where fine-grained discrimination is won.
- **RETENTION IS a real "% as good as the teacher"** — a ratio of measured accuracies
  on clean OOD NABirds. Cosine = fuzzy progress proxy; retention = trustworthy ship
  metric.

---

# Historical log (chronological, superseded detail)

Kept for the full record and the instructive mistakes. **Numbers here may be superseded
by the sections above** — where a value was later corrected, the top sections hold the
current truth. Correction chains are called out.

## Corpus + baseline (2026-07-22 → 23)

- **Pilot: 500 species, ViT-B/16, 15 ep, ~3h.** Final val_cos 0.946. Held-out
  (in-distribution): teacher 53.9/77.9, student 56.1/78.5 → retention 104%/101%.
  NABirds (OOD, 282 imgs ∩ pilot): teacher 91.5/99.7, student 90.8/97.2 → retention
  99.2%/97.5%. Abstention: @0.7 keep 34% @91%; @0.9 keep 16.6% @97%.
  (⚠️ The 91.5 teacher / 98–99% retention here is the `--pilot-species 500` default —
  the honest full-taxonomy teacher is 86.41, retention 94.7%.)
- **Full run: 7,555 species, ViT-B/16** (launched 2026-07-22): 2,502,898 imgs, max 20
  ep, ~316 img/s. val_cos monotonic ep1→6 0.9313→0.9505 → final **0.9650** (this is
  WingCLIP-0.1-alpha, NABirds 94.7% / 81.83).
- **Leakage MEASURED 2026-07-23:** avg 1.58 photos/obs, 54% from multi-photo obs, no
  big bursts. val_cos ~54%-leakage-biased (progress monitor only); NABirds immune.

## WebDataset migration (2026-07-24 evening)

- **Pack completed:** 2,502,898 rows → 251 shards, 252GB, 62.6 min (666 samples/s),
  209 skipped (no embedding), 0 missing. Pilot: 247,400 samples / 25 shards / 25GB.
- **Throughput:** loader alone ~640 img/s (vs ~306); end-to-end still ~302–320 img/s →
  **GPU-bound, not I/O-bound.** Reframes the original I/O-bottleneck hypothesis.
- **BUG FIXED:** the val split held out the LAST shard, but shards are in TAXON ORDER,
  so it covered ~15 of 500 species — every sweep's val_cos was on ~3% of species.
  Fixed to a deterministic blake2b hash split (val_frac 0.0202, 496/496 species, 4,948
  val samples — matches the local-corpus pilot, so numbers are comparable again).
- **⚠️ THE PILOT IS 496 SPECIES, NOT 500** (found 2026-08-01). `pack_webdataset.py`
  selected the pilot set with `... GROUP BY 1 ORDER BY count(*) DESC LIMIT 500`. There
  is a TIE at exactly 492 images spanning more taxa than the remaining slots, and
  duckdb breaks that tie ARBITRARILY — running the query three times returned three
  DIFFERENT species sets. The shards that were actually packed contain **496 distinct
  classes / 244,736 records** (ground truth read back from the `.cls` members, cached
  to `pilot500_classes.json` → `pilot500_taxo_idx.json`).
  - `eval_nabirds.py` recomputed the same nondeterministic query, so checkpoints in one
    sweep were scored on DIFFERENT NABirds subsets (observed n=282 / 255 / 245) and
    their top-1 numbers were NOT comparable. Fixed: it now loads the cached index set
    and only falls back to the (now id-tie-broken) query with a loud warning.
  - Directory name, the `-pilot` registry suffix and "500sp" labels are kept for
    continuity but are all approximate. **Read them as ~496.**
- **DATA QUALITY:** 1,368 duplicate photo_ids in the manifest (same photo under >1
  taxon; 0.05% of 2.5M, trained under two labels — negligible, dedup before any re-pack).
- **Env: uv replaces the old venv** (absolute-path shebangs blocked moving it).

## Pilot sweep (2026-07-25) — recipe DECIDED (later lost at full scale)

Six runs, ~16h, one-factor-at-a-time on the 500-sp pilot shards:

| run | best val_cos | peak ep | drift | notes |
|---|---|---|---|---|
| exp3 newrecipe + aug light, 15ep | **0.9512** | 15 | no | still climbing at ep15 |
| exp5 lr 7e-5, 8ep | 0.9483 | 8 | no | LR sweep winner |
| exp6 lr 5e-5, 8ep | 0.9475 | 8 | no | |
| exp2 newrecipe, 15ep | 0.9464 | 12 | YES | |
| exp4 lr 1e-4, 8ep | 0.9463 | 8 | no | LR sweep control |
| exp1 baseline old recipe, 15ep | 0.9447 | 12 | YES | foundation check |

- exp1 VALIDATED THE FOUNDATION (0.9447 vs 0.9465 local-corpus pilot → shards
  reproduce the known result → local corpus safe to delete).
- RECIPE (exp1→exp2): +0.0016 (the MobileCLIP2 bundle, marginal; wd 0.1→0.2 untested in
  isolation — worth one run).
- AUG (exp2→exp3): +0.0048, the biggest single lever; exp3 STILL CLIMBING at ep15,
  higher train_loss + better val = textbook regularization, drift gone.
- LR (exp4/5/6, 8ep): 7e-5 wins (0.9483 vs 0.9463@1e-4, 0.9475@5e-5).
- ⚠️ Caveats: these are val_cos deltas 0.002–0.005 on a leakage-biased metric; ship
  metric is NABirds; aug light × lr 7e-5 interaction untested (exp3 used lr 1e-4, LR
  sweep used aug none).

## exp7/exp8/exp9 — the pilot recipe converges (2026-07-25 → 27)

- **exp7 (aug light + lr 7e-5, 25ep) — confirmation:** best val_cos **0.9540** @ep25,
  monotonic, no decline; held-out retention 104.1%; NABirds 93.26%. Still climbing at
  ep25. (Note the earlier "LR is a wash, epochs are the lever" call was over-generalized
  from a single ep15 crossing.)
- **exp8 (lr 1e-4, 40ep) — FALSIFIED "epochs are the lever".** best val_cos 0.9503 (peak
  ~ep37, FLAT since ep33); lost exp7 on all three metrics and 15 extra epochs never
  reached exp7's ep25 mark. 1e-4 converges fast to a LOWER ceiling; 7e-5 climbs to a
  BETTER optimum. LR is the lever, not epochs.
- **exp9 (aug strong, RRC [0.08,1.0] + 5-view teacher caching) — LOST, CANCELLED.**
  Strong aug regularizes best (held-out 105.9% vs 104.1%) but costs val_cos (0.9434 vs
  0.9540) and, crucially, LOSES NABirds (92.55 vs 93.26). The ~56 GPU-h full-corpus
  5-view precompute is NOT justified — the cheap pilot saved those hours. Light aug
  stays locked.
- **LOCKED PILOT RECIPE:** `--lr 7e-5 --wd 0.2 --beta2 0.95 --warmup 500 --grad-clip 1.0
  --min-lr 1e-7 --aug light --batch 96 --epochs 25`. (This is the recipe that LATER LOST
  at full scale — see below.)

## Ground-truth held-out set + WiSE-FT sweep flip (2026-07-26 → 27)

- **Ground-truth held-out BUILT:** originally `groundtruth_heldout.parquet` — 178,852
  photos / 5,908 species (median 40/species). Later found to include 2,058 data-starved
  species via the sampler bug (see Decisions); the CLEAN set is 3,850 species / 151,042
  photos.
- **WiSE-FT sweep FLIPPED between 500 and 7,555 species.** At `--pilot-species 500` the
  distilled model is already near-teacher, so low alpha won (0.25 best). At the full
  7,555 the fine-tune's true-label knowledge helps far more, so the optimum shifted hard
  toward the fine-tuned weights. ⚠️ **`eval_nabirds.py` DEFAULTS to `--pilot-species
  500`** — the same checkpoint reads 98.1% retention (500-sp) vs 94.7% (all 7,555). The
  original alpha-0.25 sweep was on the 500-sp subset by accident. Always pass
  `--pilot-species 0`.
- **Weight-movement analysis:** the fine-tune moved weights only 4.718% globally
  (11.8% projection, 8.5% last blocks, ~0.4% early layers) — configured conservatively
  (lr 1e-5, 12ep, aug light, wd 0.1). So alpha=1.0 is already a mild interpolation.
  Interpolation verified bit-exact (|W−W_prev| = 0.2012 identical across alpha steps).

## FULL RETRAIN with the locked recipe (2026-07-27 → 30): it LOST

Full 7,555-sp distillation with the locked pilot recipe → `full7555_locked_ep25`. RESULT:
val_cos 0.9618 (vs 0.1-alpha 0.9650) and **NABirds full-species retention 90.7% (78.4)
vs 0.1-alpha's 94.7% (81.83)** — a 4-point OOD REGRESSION. At 7,555 sp / 2.5M imgs the
regularization (aug light + wd 0.2) has little overfitting to prevent and costs
representation quality → **scale dominates recipe**. **WingCLIP-0.1-alpha stays the
distillation base; 0.2-alpha is retired.** The ~62 GPU-h turned an assumption into a
disproven claim. (See Decisions for the six-confounded-variables correction.)

## INV-1..INV-4 (2026-07-30) — the sampler-bug batch

- **INV-1 (coverage):** all 24,633 NABirds test images are distilled species, ZERO from
  the 2,058 never-distilled. The fine-tune gain is RECOGNITION (+7.61 on distilled
  species), not coverage. Independently reproduced the 81.83/89.45 sweep numbers.
- **INV-2 (sampler fix + A/B):** clean set = 3,850 sp / 151,042 photos. in-dist val
  63.39→77.61 (base 01) and 61.75→76.28 (base 02). A weaker distillation base stays
  weaker after identical fine-tuning (0.2 stays ~1.3–1.5 pts behind 0.1 at every alpha).
- **INV-3 (WiSE-FT):** interpolation bit-exact; peak alpha=0.90 on both bases (not the
  paper's ~0.5, not 1.0); a non-bird eval shows fine-tuning costs ~8 pts of general
  capability NABirds is blind to.
- **INV-4 (abstention):** at alpha=0.90 / thr 0.5 only 2.4% of non-bird photos pass vs
  88.4% of birds → no separate detector needed (Imagenette = easy negatives).
- ⚠️ UNEXPLAINED: base 02's general-OOD curve runs BACKWARDS (10.4→14.0) while base 01
  collapses (17.4→9.4). Same eval, opposite signs. No explanation.
- ⚠️ NUMBERING: an earlier queue used T0–T5; the 2026-07-30 work also used T1–T4 for its
  own investigation. Tasks are now named, not numbered, to stop the collision. The
  T1–T4 / INV-1–4 writeups here are the 2026-07-30 batch.

## T3/T4 detail (2026-07-30)

- **T3.1:** interpolation CORRECT (alpha=1.0 reproduces the fine-tune bit-for-bit,
  alpha=0.5 = analytic midpoint, 154/154 tensors moved).
- **T3.2:** WiSE-FT DOES help (the earlier "useless" call was WRONG); the 3-point sweep
  missed the peak. Filling in 0.25/0.90: alpha=0.90 = 89.93 (base 01), the new ship
  candidate, beats the old dirty-run 89.45.
- **T3.3:** bird-only eval was hiding catastrophic forgetting (Imagenette; base 01
  collapses −8.0 pts monotonically). ⚠️ base 02 backwards (unexplained). n=500 → ±1.7pt
  noise; the RELATIVE collapse is the signal, absolute values are not.
  Method note: for a general-space eval use `model.visual(x)` directly, not
  `Student.forward()` (which projects 512→768 and gives a shape mismatch).
- **T4:** the confidence gate rejects non-birds (2.4% pass at alpha=0.90/thr 0.5;
  mean non-bird conf 0.109). Fine-tuning slightly worsens rejection (0.8%→2.4%).

## Phase 4 first run (2026-07-30) — failed, root-caused to calibration

- **FALSE START recorded:** the first run scored 78/78 but was INVALID —
  `.tmp/range-priors/cells/` did not exist so `RANGE_AVAILABLE` was false and every
  range lookup silently returned nothing (the harness does not warn). Always confirm the
  cells directory is populated. **Getting cells without R2 keys:** the Pi has a live
  `wrangler` OAuth login; the Cloudflare REST API accepts it (key prefix `range-priors/`,
  NOT `cells/`; `list-cells.mjs` prints the 104 needed cells, 1.7 MB). Later the FULL
  681,023-cell set was pulled via rclone over the S3 endpoint (the REST API throttles at
  ~8 req/s and returns 429s that look like missing cells).
- **CONTROL:** teacher reproduces 87/96 exactly → harness + cells + golden set faithful.
- **Results (golden set):** BioCLIP-2 teacher F_gated 87/96; GPT-5.4-mini 83/87;
  WingCLIP-0.1 @0.90 F_gated **78/91**, D_tiered 74/**96**. **Phase 4 does NOT pass yet
  (78 vs 83 vs 87).**
- **Diagnosis: RANKING/CALIBRATION, not recognition.** top-5 MATCHES the teacher (96%)
  under D; the answer is in our list as often, we rank it worse at #1. Confidence
  distributions differ sharply: teacher median top-1 0.915 (14/27 >0.9), ours 0.715
  (0/27 >0.9). Strategy F's dominance gate fires constantly for the teacher, almost
  never for us. This contradicts NABirds (89.93) because NABirds scores raw argmax
  (ordering), which distillation preserved, while nobody checked the softmax
  confidence distribution survived — it didn't (cosine distillation has no term for
  score scale). See "argmax-vs-softmax" above.
- **Phase 4 addendum: 0.2 BEATS 0.1 through the pipeline** (0.2 @0.90 = 83/87 pipeline
  vs 0.1's 78/91) because pipeline top-1 tracks confidence sharpness (0.915→87%,
  0.807→83%, 0.715→78%), not argmax accuracy. ⚠️ 83 vs 78 is ONE image on n=23 — do not
  treat the 0.1-vs-0.2 pipeline ordering as settled.

## Bayesian rerank: plan → fitted → Strategy I (2026-07-30)

- **Plan (the 5–7 parameter design):** `score = sim/T + w[status] + beta·log P(species|cell)`.
  Prior art: iNaturalist Geomodel (Cole et al. 2023, ICML); eBird/Merlin conceptually
  the same. Two datasets, two jobs: build the prior from the ENTIRE raw iNat dump
  (metadata only), fit the scalars on the 11k leak-free calibration set (photos).
  ⚠️ The shipped model has only TWO params (T, beta) — see the "PLAN vs SHIPPED"
  reconciliation in the ranker section; alpha dropped (fitted 0.0), w[4] dropped
  (BirdLife not shipped).
- **Fitted (BirdLife, Strategy H):** T=0.007809, w[present]=0 (reference),
  w[near-range]=−0.5726, w[no-data]=**0.0** (do NOT punish ignorance like absence — the
  old 1.0× was accidentally right), w[out-of-range]=−3.8552 (~47× downweight, far
  harsher than the hand-set 0.25× ≈ −1.39). Range-status tally on 25 candidates × 11,070
  photos: out-of-range 84%, present 13%, near-range 3%, no-data ~0% (validates pulling
  the full cell set). H beat F by +2.48 top-1 / +1.05 top-5 on 3,140 held-out (86.62 vs
  84.14 conditional) and is less parameter-sensitive. ⚠️ Strategy D (tiering, no gate)
  is nearly worthless (77.42 vs 77.17 raw) — essentially ALL of F's gain comes from the
  dominance gate deciding when to IGNORE the tiering.
- **Strategy I (empirical iNat occurrence) — the big win.** Absolute numbers and the
  BirdLife/GBIF ablations, geographic + temporal holdouts, and the projection-bug catch
  (spherical vs WGS84 Equal Earth, now 12/12 cell matches) are in "Measured results".
  Seattle cell 96,273 sanity check: Mallard, Great Blue Heron, Sword Fern, American
  Crow, Salmonberry — unmistakably Seattle (and the ferns confirm it's all-taxa iNat,
  not birds-only).
- **STOP HAND-ROLLING THE GATE:** the literature has proven tools — temperature scaling
  (Guo et al. 2017; provably cannot change argmax → NABirds untouched; DO FIRST), a
  Bayesian range prior instead of hard tiering, and conformal prediction for abstention
  (guaranteed coverage, what RealBirdID benchmarks). The occurrence log-sum is the
  temperature+prior combination.
- **Rasterizer memory note (only if the GeoPackage is ever regenerated):** the 60GB
  peak is the accumulator `dict[(row,col)→dict[code→[presence,origin,seasonal]]]` (~120
  bytes/pair over hundreds of millions of pairs), NOT the geometries. Fix: append flat
  rows to Parquet, aggregate in DuckDB (`min(presence), bit_or(origin), bit_or(seasonal)
  GROUP BY row,col,code`), which spills to disk. Occurrence-only shipping makes this
  DEAD (only needed for the merged-blob option).

## The "what ships today" mislabelling chain (2026-07-31) — resolved

Recorded because it took three passes to get right:
1. The 11k table first labelled `F_gated_dom0.5` as "WHAT SHIPS TODAY". **Wrong** —
   F_gated is post-LLM *ranking* logic, not a vision model, and it scores WingCLIP
   candidates production has never seen.
2. Correction 1 said "live production = the GPT reference row, 83/87, real gain +6".
   **Still wrong** — that placed a 23-image golden-set number beneath 11,070-photo rows
   as if peers.
3. Correction 2 (final): the GPT 83/87 was golden-set-only and was being PRINTED as a
   hardcoded string on every run regardless of fixture set. Harness fixed to print the
   reference only when n≤30, else `GPT-5.4mini reference: n/a at this scale`. **No GPT
   number exists at 11k and none is planned.** The +9 (80→89) is an internal ablation
   (old ranker vs new ranker on identical candidates); the production delta is
   UNMEASURED at scale. On the same 23 golden images: GPT 83/87 vs Strategy I 83/100
   (equal top-1, better top-5) — a smoke test, NOT evidence.

**Standing rule:** never print a baseline measured on one set beside results from
another (different n, photos, difficulty).

## Export + quantisation track (2026-07-31)

The current numbers are in "Measured results" (quantisation is nearly free; int4 = 43
MB; fp16 trivial in torch; int3/int2 collapse). Recorded lessons:
- The ONNX detour produced two WRONG tool artifacts ("int4 = 75.3 MB", "fp16 cannot be
  built") and cost hours — measure precision cost in torch on GPU (~6 s/variant).
- The `apply_weight_quant` bug skipped `attn.in_proj_weight` (21.2M params, 24.5% of the
  model) — every attention projection was silently fp32 while reported int4. Fixed to
  sweep all 2-D weights; int4 cost moved −0.55 → −0.75, size unchanged (43 MB is
  `params × bits/8`, independent of which layers quantise).
- OOM gotcha: caching all 24,633 preprocessed images (7.4 GB, `torch.stack` doubles it)
  OOM-killed twice on a 31 GB box; reverted to streaming (3 GB RAM, faster).
- "Core ML needs fp16" is imprecise — Core ML prefers fp16 but supports int8/int4
  palettisation via `coremltools.optimize`, and converts from torch directly (never
  touches ONNX), so the blocked ONNX fp16 export does NOT block iOS.

## TinyCLIP research (2026-07-31)

Details in "Decisions" and "Next steps". Key facts: TinyCLIP (Wu et al., ICCV 2023,
MSR), MIT, ships basis weights (HF/timm), ViT→ViT weight inheritance applies,
`vit_medium_patch16_clip_224.tinyclip_yfcc15m` = 38.3M params / 512-d / int4 19.2 MB,
load via timm. Headline numbers are coarse zero-shot ImageNet (shrink ViT-B/32 50% with
comparable zero-shot; 8M model beats ViT-B/16 by 3.5% on ImageNet with 8.9% of params;
weight inheritance speeds training 1.4–7.8×) — NOT fine-grained, so the operating regime
is unproven for us. Progressive distillation (86.6M→~60M→39M) is TinyCLIP's own scheme
if the direct jump loses too much. ~~WingCLIP-0.1 is the better teacher (beats BioCLIP-2
on NABirds); the BioCLIP-2 cache stays the control.~~ ⚠️ **That teacher claim was
FALSIFIED 2026-08-01 — see the pilot results below.** Watch the second-fine-tune
redundancy trap (the 178k GT photos were already absorbed by WingCLIP-0.1).

## TEACHER SETTLED: WingCLIP-0.1 beats BioCLIP-2 as a distillation target (2026-08-02)

Decided on the NABirds-401 pilot with the **full 24,633-image / 401-species**
eval. Identical recipe (0.2 basis, lr 7e-5, batch 96, 25 ep, 185k samples/ep);
**only the teacher differs.**

| run | teacher | NABirds top1 | top5 | val_cos |
|---|---|---|---|---|
| **TEACH-W** | **WingCLIP-0.1** | **89.09** | 96.59 | 0.9612 |
| TEACH-B | BioCLIP-2 | 83.44 | 95.08 | **0.9616** |

**WingCLIP-0.1 wins by +5.65 top-1.** At n=24,633 that is far outside noise.
This CONFIRMS the original "Next steps" step-2 plan and RETRACTS the 2026-08-01
"+3.90 for BioCLIP-2" claim, which was measured on the 7-species/282-image eval
and was void.

### val_cos is DISQUALIFIED for teacher selection

TEACH-B scored **higher** val_cos (0.9616 vs 0.9612) while **losing NABirds by
5.65 points**. Third time val_cos pointed the wrong way. The reason is
structural, not noise: val_cos measures how well a student mimics ITS OWN
teacher targets, so each run is graded against a different target set. A student
can mimic a worse teacher more faithfully and score better. **Never rank teachers
by val_cos.** Use it only to watch a single run converge.

### The chain, and what actually beat what

All three on the SAME eval (24,633 imgs, all mapped species):

```
BioCLIP-2  (grandteacher)   86.41   <- the frozen ViT-L teacher
WingCLIP-0.1 (teacher)      89.93   <- distill + GT fine-tune + WiSE-FT, 86.6M
TEACH-W    (student)        89.09   <- 38.3M, 2.26x smaller
```

WARNING: **TEACH-W did NOT beat its direct teacher.** It is 0.84 BELOW
WingCLIP-0.1. It beat the GRANDteacher by +2.68, which is a different and much
weaker claim. Do not repeat "the student beat its teacher" about this run. The
103.1% retention figure printed by `eval_nabirds.py` is measured against
**BioCLIP-2** (the cached teacher), not against WingCLIP-0.1, which makes it
easy to misread.

**Why a student can exceed the grandteacher at all:** WingCLIP-0.1 is not a pure
distillation of BioCLIP-2. It is distill -> **ground-truth fine-tune on 178k
labeled photos** -> WiSE-FT blend. That fine-tune injects supervised signal
BioCLIP-2 never had, and is where the +3.52 over BioCLIP-2 comes from. TEACH-W
inherits it by mimicking embeddings that already encode it. Distillation itself
still cannot exceed its own teacher here: the embedding IS the target.

**The real headline: 99.1% of WingCLIP-0.1 at 2.26x fewer params** (38.3M vs
86.6M), for 0.84 top-1.

### Abstention

| thr | TEACH-W cov / acc | TEACH-B cov / acc |
|---|---|---|
| 0.3 | 93.7% / 92.75 | 92.9% / 88.07 |
| 0.5 | **85.7% / 95.61** | 82.6% / 92.41 |
| 0.7 | 69.3% / 97.48 | 69.7% / 96.21 |
| 0.9 | 9.8% / 98.64 | 48.0% / 98.22 |

TEACH-W is better at the useful thresholds. The 0.9 row inverts sharply
(9.8% vs 48.0% coverage), a calibration difference rather than a quality one.
Re-tune thresholds per model; all existing ones are for WingCLIP-0.1 @ a=0.90.

### LR: settled, and it is at the floor

Full 0.2-basis sweep (old 500-sp pilot): 3e-5 = 0.9546, **5e-5 = 0.9563**,
**7e-5 = 0.9560**; on the 0.1 basis 1e-4 = 0.9438, 2.5e-4 = 0.8917,
5e-4 = 0.8837. 5e-5 and 7e-5 are indistinguishable (+0.0003); everything above
1e-4 collapses. **Keep lr 7e-5.** LR is no longer a useful lever.

### Next

1. **Ground-truth fine-tune + WiSE-FT on TEACH-W.** WingCLIP-0.1 gained +3.52
   from this step; TEACH-W has not had it. Could plausibly reach ~89.9 at 2.26x
   smaller. Mind the REDUNDANCY TRAP already documented in "Next steps": the
   178k GT photos were ALREADY absorbed by WingCLIP-0.1, so re-teaching the same
   photos double-counts the signal. Evaluate first, or use a disjoint slice.
2. Batch 128 + lr 8.1e-5 (sqrt-scaled) vs batch 96 + lr 7e-5. Batch has NEVER
   been swept; every run in project history used 96.
3. Full 7,555-species distill with the WingCLIP-0.1 teacher, now that teacher
   and LR are both settled.

## TinyCLIP-39M pilot results (2026-07-31 → 08-01)

> 🚨 **EVERY NABirds NUMBER IN THIS SECTION IS VOID.** The pilot species set and
> NABirds overlap on **7 species**, so all "NABirds top-1" figures below were
> measured over 7 species / 282 images, not the 496 species claimed. See
> "The 7-species trap" immediately after the table. The val_cos column is
> unaffected (in-distribution, hash-split across all pilot species).
>
> The teacher question this section failed to answer was RE-RUN properly and is
> now SETTLED: see "TEACHER SETTLED" above. WingCLIP-0.1 beats BioCLIP-2 by
> +5.65 top-1 on the full 24,633-image eval.

Eight pilot runs on the ~496-species shards, TinyCLIP-39M
(`vit_medium_patch16_clip_224.tinyclip_yfcc15m`, 38.3M params), batch 96, 244k
samples/epoch, ~7.8 min/epoch.

| run | ~~top1~~ VOID | ~~top5~~ | val_cos | config |
|---|---|---|---|---|
| runB | ~~92.55~~ | ~~98.23~~ | **0.9560** | 0.2 basis, lr 7e-5, WingCLIP |
| exp3 | ~~92.55~~ | ~~98.58~~ | 0.9423 | 0.1 basis, lr 1e-4, **BioCLIP-2** |
| runA | ~~88.65~~ | ~~96.45~~ | 0.9438 | 0.1 basis, lr 1e-4, WingCLIP |
| exp4 | ~~74.47~~ | ~~82.98~~ | 0.9047 | 0.1 basis, 61M **patch32** |
| exp2 | ~~50.00~~ | ~~56.38~~ | 0.8917 | 0.1 basis, lr 2.5e-4 |
| exp1 | ~~39.01~~ | ~~44.68~~ | 0.8837 | 0.1 basis, lr 5e-4 |

**What survives:** the val_cos ranking, and the fact that exp1/exp2 (lr 2.5e-4 and
5e-4 on the 0.1 basis) are catastrophic by any measure. **What does not:** the
"+3.90 for BioCLIP-2" teacher result and the "+3.90 for the 0.2 recipe" result,
both of which were 7-species measurements.

### 🚨 The 7-species trap (found 2026-08-01)

The pilot was selected as **the top-500 species by GLOBAL iNat photo count** — a
worldwide ranking, full of Greater Rhea, Hawaiian Duck, Swan Goose, piping-guans.
**NABirds is North American.** The two sets intersect on exactly **7 species**:
Rufous Hummingbird, Nuttall's Woodpecker, Yellow-billed Magpie, Oak Titmouse,
Juniper Titmouse, California Thrasher, Abert's Towhee.

So `eval_nabirds.py --pilot-species 500` found 282 images spread over **7**
species (~40 each), while reporting "500 species" in its own header. The Wilson
CIs quoted alongside those numbers were also **understated**, since they assume
282 independent samples rather than 7 clustered groups.

This reaches back further than the TinyCLIP work: `nabirds_ps500` was the metric
used to rank the **2026-07-25 pilot sweep** too.

**Why it was easy to miss:** the 7 overlap species sit at the very TOP of the
global count ranking (Baeolophus ridgwayi 499 imgs, Melozone aberti 496,
Toxostoma redivivum 495 ...), so they were the most-photographed species in the
corpus and slipped into the top-500 naturally. The eval never errored; it just
silently measured a tiny, unrepresentative slice.

**Fix:** align the pilot species set TO NABirds. All 401 NABirds taxa exist in the
corpus with 184,958 images (min 284/species), so the pilot stays roughly the same
size (185k vs 244k) while the OOD eval grows from 282 images to the full
**24,633-image / 401-species** NABirds test split — an ~87x bigger eval on the
metric that decides things. Built by `build_nabirds_species.py` (species list,
checksum-stable) + `shard_subset.py` (extracts from the packed shards, since the
loose `corpus/` was deleted 2026-07-25) into
`/mnt/nas/WingDex-Distill/wds-nabirds401/`.

⚠️ **Tradeoff, recorded deliberately:** a NABirds-aligned pilot is
North-American-biased and is NO LONGER a random slice of the 7,555-species corpus,
so recipe conclusions drawn on it may not transfer perfectly to the full run. We
accept that to get a trustworthy teacher/OOD signal. Do not silently treat the
new pilot as representative.

**Only the TEACHER question needs re-running** (2 runs, WingCLIP vs BioCLIP-2 at
identical recipe). LR and recipe questions ride on in-distribution val_cos, which
the species mismatch does not affect.

### ⚠️ Two further methodology traps from this sweep

1. **The LR sweep was run on the recipe we are abandoning.** EXP1–EXP4 were ALL 0.1
   basis (`--aug none --wd 0.1`, only `--lr` varied), while the winner (runB) is 0.2
   basis. runB also changed FOUR variables at once vs runA (lr, aug, wd, plus beta2
   0.95 / warmup 500 / grad-clip 1.0), so **"lr 7e-5 is optimal" was never tested on
   the shipping recipe.** The 0.2-basis sweep (5e-5, 3e-5) runs 2026-08-01.
   Lesson: sweep the basis you intend to ship, and change one variable at a time.
2. **exp4 ("61M backbone") is CONFOUNDED and proves nothing about capacity.**
   `vit_betwixt_patch32_clip_224` is **patch32 = 49 tokens**; the 39M
   `vit_medium_patch16` is **patch16 = 196 tokens**. The "bigger" model has 4x less
   spatial resolution, which is why it trained faster (355s vs 465s/epoch) and scored
   worse. It does NOT show 61M < 39M, and does NOT rule out progressive distillation —
   that needs a **patch16** intermediate.

**⚠️ Never compare pilot top-1 against WingCLIP-0.1's 89.93 or the teacher's 86.41.**
Those are FULL-SET numbers (24,633 images, 401 species). A species-restricted eval
is a different, easier exam — the same teacher scores 91.49 on the 282-image
subset. Compare **retention over a common teacher**, on which WingCLIP-0.1 (104.1%)
still leads every pilot student (101.2%), because it has the ground-truth fine-tune
+ WiSE-FT that TinyCLIP has not received yet.

## Throughput: where the loader ceiling actually is (measured 2026-08-02)

Do NOT buy a faster GPU or pre-resize the shards to fix training speed until
this section is re-measured. Both were proposed on 2026-08-02 and both were
argued down BY MEASUREMENT, not opinion.

### `nvidia-smi` utilization is a liar for this workload

A single sample showed **92%** and was quoted as "the GPU is busy". Sampling 20x
over 20s during real training told a different story:

```
86 84 77 76 73 72 70 69 67 66 64 51 41 25   (% util)
```

That swing from 25% to 86% is the sawtooth of a GPU **waiting on the data
loader** between batches. `utilization.gpu` means "percent of time at least one
kernel was resident", NOT "percent of compute used", so a single reading catches
a peak and looks saturated. **Always sample repeatedly.** Meanwhile 7 processes
sat at ~105% CPU each (`pt_data_worker` x6 plus the trainer), i.e. ~7.5 of 16
cores doing JPEG decode.

### But decode is NOT the binding constraint either

Benchmarked on real shard data (`jobs/bench_decode.py`, 300 jpegs from
`wds-nabirds401/shard-00000.tar`), Pillow 12.2.0 with **libjpeg_turbo already
enabled**:

| decode path | throughput | vs today |
|---|---|---|
| full size (what we do today) | 440.8 img/s | 1.00x |
| `Image.draft("RGB",(256,256))` | 445.0 img/s | **1.01x (nothing)** |
| pre-resized to 384px | 898.5 img/s | 2.04x |

**The source images are already only ~500px** (500x333, 500x375, ...; avg 80.6
KB). They were downsampled at corpus-build time, so the "pre-resize to cut
decode cost" premise is far weaker than it looks, and `draft()` -- the free
option -- buys literally nothing because there is nothing left for libjpeg to
skip.

Arithmetic that settles it: one core does ~441 img/s, we run **12 workers**, so
decode capacity is ~5,300 img/s theoretical against a measured loader ceiling of
**~1,012 img/s** and actual training throughput of **~655 img/s**. Decode has
~5x headroom over the ceiling. **The gap between 5,300 and 1,012 is tar I/O over
SMB, tensor transforms, and collation -- not JPEG decode.**

### Therefore

- **Pre-resizing the shards is REJECTED for now.** ~1.1x realistic gain, and it
  costs a re-pack, permanent loss of the higher-res fine-tune lever (README
  calls it LAST resort for exactly this reason), and it would change the input
  pixels mid-experiment -- making the teacher comparison non-comparable to RUN B.
  Adding an uncontrolled variable is the specific mistake that voided two
  experiments earlier the same day.
- **Pillow-SIMD is pointless here**: libjpeg-turbo is already active.
- **DALI / nvJPEG would move decode to the GPU**, but decode is not the wall, so
  expect little. Revisit only after the real ceiling is identified.
- **NEXT STEP (queued): profile what actually sets the ~1,012 img/s ceiling.**
  Prime suspect is sequential tar reads over SMB from the NAS. Measure the
  loader alone (no training, no decode: read raw tar members and discard) vs
  loader+decode vs full training. That isolates I/O from decode from compute.
  `jobs/bench_loader.py` does not exist yet; `bench_loader.py` in the repo root
  is the older variant.

### Loader ceiling PROFILED (2026-08-02) -- it is the TRANSFORMS, not SMB

Ran `jobs/profile_loader.py` with the GPU idle, 2,000 images per stage, to
isolate each layer. This REFUTES the earlier guess (recorded above) that
sequential tar reads over SMB set the ceiling.

| stage | 1 process | x12 workers (ideal) |
|---|---|---|
| A raw tar read over SMB | **2,005 img/s** (244 MB/s) | 24,064 |
| B + JPEG decode | 706 img/s | 8,471 |
| C + training transforms | **245 img/s** | 2,944 |

measured loader ceiling ~1,012 img/s, training ~655 img/s

**Findings:**
1. **SMB is NOT the bottleneck.** 2,005 img/s single-threaded at 244 MB/s is
   ~24x more headroom than we use. Stop blaming the NAS.
2. **Transforms cost MORE than decode.** Decode takes 65% off stage A
   (2,005 -> 706); transforms take another 65% off stage B (706 -> 245). The
   resize/crop/normalize path is the single most expensive layer, not JPEG.
3. **No single layer explains the ceiling.** Even stage C x12 workers should
   give ~2,944 img/s but we measure ~1,012, a ~3x gap. That residual is
   DataLoader overhead: worker IPC/pickling of tensors, collation, and the GIL
   in the main process. Load average was ~7.5 of 16 cores, so we are NOT
   CPU-starved either.

**Revised advice on GPU decode:** DALI/nvJPEG is worth MORE than the earlier
note implied, because it moves BOTH decode and transforms onto the GPU (the
65% + 65% stack), not just decode. But fix the cheap things first.

**Already set** in `wds_loader.py` and `train_student.py`: `pin_memory=True`,
`persistent_workers=True`. **Not set: `prefetch_factor`** (defaults to 2). That
is the one remaining free knob; try 4-6 before touching the transform path.

Re-run anytime: `./.venv/bin/python jobs/profile_loader.py --limit 2000`

### GPU-BOUND, not loader-bound -- the decisive measurement (2026-08-02)

Everything above about decode, transforms and SMB was chasing the wrong side.
`jobs/bench_bound.py` measures the GPU step on synthetic GPU-resident data, the
loader with no model, and the real combined loop, on the same batch shape:

| what | img/s |
|---|---|
| GPU step only (synthetic, no loader) | **700** |
| loader only (no model) | 1,383 |
| combined (real training) | 652 |

**The loader delivers 2.1x more than the GPU can consume**, and combined (652) is
93% of the GPU-only ceiling (700). Perfectly-serial would predict 465; we measure
652. So the loader and GPU are **already well overlapped** and training is
**GPU-BOUND**.

Consequences, all confirmed by measurement rather than argument:
- Pre-resizing shards: **pointless.** Loader already 2x too fast.
- DALI / nvJPEG: **pointless** for the same reason.
- `prefetch_factor`: **pointless.** Sweeping 2/4/6/8 moved nothing outside noise.
- More/faster CPU cores: **pointless.**
- The 25-86% `nvidia-smi` sawtooth is NOT starvation; it is the normal
  fwd/bwd/optimiser cycle plus AMP scaler sync on a small 38M model.

⚠️ This also **reverses the RTX PRO 4500 verdict** recorded above. That note said
"buy for capability, not speed, a faster GPU would idle more". Backwards: the GPU
is the binding constraint and the loader has 2x headroom to feed a faster one.

### What actually worked: GPU-side knobs (measured, now default-able)

`jobs/sweep_gpu.py`, synthetic data so the loader cannot confound it:

| config | batch | img/s | vs base |
|---|---|---|---|
| baseline fp16 (what we ran all week) | 96 | 699.9 | 1.00x |
| bf16 + channels_last | 96 | 700.6 | 1.00x |
| fp16 + compile | 96 | 791.0 | 1.13x |
| fp16 + channels_last + compile | 96 | 667.5 | 0.95x |
| **bf16 + channels_last + compile** | 96 | **810.8** | **1.16x** |
| fp16 + cl + compile | 128 | 805.4 | 1.15x |
| fp16 + cl + compile | 192 | 566.4 | 0.81x (VRAM pressure) |

Note channels_last **hurts** with fp16 (0.95x) but **helps** with bf16. Do not
apply it blindly.

**Verified end to end**, not just synthetically:
- `bench_bound.py --opt`: combined **652 -> 752 img/s (1.15x)**
- real 2-epoch training run: epoch 1 = 92s (pays the compile cost), epoch 2 =
  **62s**, i.e. **1.48x** once warm; steady state ~750 img/s vs ~655 before.

New flags on `train_student.py` (all default OFF, so nothing changes silently):
```
--amp-dtype bf16 --channels-last --compile
```
bf16 needs no GradScaler on Ampere+, so the scaler is auto-disabled for it.
Also migrated the deprecated `torch.cuda.amp.*` calls to `torch.amp.*`.

**Use this for every run from now on.** The first epoch is ~50% slower while
torch.compile traces; everything after is ~1.5x faster.

### Why only 30% of peak? Roofline + what is already enabled (2026-08-02)

Measured with `jobs/roofline.py`: the student is **38.7M params** and one
forward pass costs **15.98 GFLOP/img**. Training is ~3x forward (fwd + bwd),
so ~48 GFLOP/img.

| config | img/s | achieved | % of dense bf16 peak |
|---|---|---|---|
| baseline fp16 | 700 | 33.6 TFLOP/s | 28% |
| bf16 + channels_last + compile | 811 | 38.9 TFLOP/s | **33%** |

RTX 3080 dense bf16 peak is ~119 TFLOP/s. **60-70% is typical for well-tuned
ViT training**, so ~30% means roughly another 1.5-2x may be available in the
model path. Note params are misleading here: 38.7M at 196 tokens / 224px is
compute-heavy relative to its size.

**Already enabled, so NOT the fix** (checked, do not re-investigate):
- **Flash / SDPA attention is ON.** `timm.layers.use_fused_attn()` returns True
  and every block has `fused_attn=True` (timm 1.0.28, torch 2.6.0+cu124).
- `pin_memory`, `persistent_workers`, TF32, `cudnn.benchmark`.

**Remaining candidates, cheapest first:**
1. **Fused AdamW** (`torch.optim.AdamW(..., fused=True)`). We use the default,
   which launches separate kernels per parameter tensor; a 38M model has many
   small tensors, so launch overhead is plausible. One-word change.
2. **Larger batch.** At batch 96 with 196 tokens the GEMMs may be too small to
   saturate the tensor cores.
3. **`torch.compile(mode="max-autotune")`** instead of default mode; it
   benchmarks kernel variants and often adds another 1.1-1.2x.
4. **Part of the gap is structural.** ViT training at 224px does a lot of
   LayerNorm / GELU / residual-add work that is memory-bound rather than
   tensor-core work. Do not expect to reach 70%.

`jobs/profile_gpu_kernels.py` splits fwd/bwd/optimizer time and dumps the top
kernels by self CUDA time. **Run it only when the GPU is otherwise IDLE** -- a
concurrent training job silently contaminates the result (this produced a bogus
80.5 img/s reading on 2026-08-02).

### Cloud (RunPod) economics, measured 2026-08-02

Upload from tomahawk measured at **~14 MB/s (~113 Mbit/s)**. That is the number
that decides everything, because RunPod bills while you upload.

| payload | size | upload time |
|---|---|---|
| NABirds-401 pilot (shards + embeddings + eval) | ~17 GB | ~20 min |
| full 7,555-species corpus | 252 GB | **~5 hours** |

So a naive full-corpus upload costs ~5h of GPU-rate billing before a single
training step. Two ways around it:
- **Network volume** (~$0.05-0.10/GB/month): upload once via a cheap CPU-only
  pod, then attach to GPU pods. 252GB is ~$12-25/month standing.
- **Upload from the NAS directly**, unattended, against a ~$0.10/hr CPU pod.

Rule: **never pay GPU rates for data transfer.**

Rough throughput expectations vs our 3080 (119 TFLOP/s dense bf16), discounted
because our ~30% efficiency partly travels with us:

| GPU | dense bf16 | naive | realistic |
|---|---|---|---|
| RTX PRO 4500 (32GB) | ~200 | 1.7x | 1.3-1.5x |
| A100 80GB | ~312 | 2.6x | ~2-2.5x |
| H100 80GB | ~990 | 8x | 3-4x |

⚠️ On an H100 our loader (~1,383 img/s measured) would become the bottleneck,
and only THEN would DALI / GPU decode start to matter.

Pilot-scale verdict: ~20 min upload + ~1h on an A100 is roughly **$2-3/run** at
~2.5x. Worth it for the full run; for 2.4h pilots, fixing the 30% locally is
cheaper and simpler.

### RTX PRO 4500 question (asked 2026-08-02)

32GB GDDR7 / ~896 GB/s / 5th-gen tensor cores vs our 10GB 3080. Verdict:
**buy it for CAPABILITY, not speed.** Training is loader-bound on a mobile-class
i9-9980HK (16 threads), so a faster GPU would idle MORE, not finish sooner.
It is the right purchase only if the goal is models that do not fit in 10GB
(bigger students, multi-view targets, batch >128 which currently thrashes).

## Throughput: precompute and training (settled 2026-07-31)

### precompute_embeddings.py: 144 → 626 img/s

Two fixes, both now default: `--workers 8` (parallel JPEG decode) and `--fp16`
(autocast). Measured on 10 pilot shards / 100,000 images.

| config | throughput |
|---|---|
| serial, fp32 (old) | 144 img/s |
| **8 workers + autocast fp16** | **626 img/s** (4.3x) |

Full 2.5M-image corpus: **~4.8 h → ~67 min**.

**Verified numerically identical**, not assumed. Against 50,171 overlapping
photos from the pre-existing serial-fp32 cache: cosine **1.000000** mean /
0.999973 min, max abs diff 0.00122, **0 of 3000** samples below 0.999. Consistent
with the quantisation sweep's 0.00 top-1 delta for fp16. **The existing pilot
cache does NOT need regenerating.**

Multi-view (`--views N>1`) keeps the serial path: it needs the raw PIL image to
apply a different transform per view.

**Isolated loader ceiling (inference only, 25 shards / 24k images):**

```
workers  fp32     fp16
  0      231.0    219.9
  4      344.5    642.7
  8      361.7    876.3   <- ceiling
 12      349.8    870.1
```

Shape of that table is the useful part:
- fp32 plateaus ~350 regardless of workers → GPU-bound there
- fp16 keeps scaling → a faster GPU absorbs what more workers feed it
- **fp16 is SLOWER than fp32 at 0 workers** (219.9 vs 231.0) → classic
  starved-GPU signature; a faster GPU just waits longer on one decode thread
- 12 ≈ 8 → decode saturates ~8 on this 16-core box
- **Neither lever works alone**: workers-only 361, fp16-only 220, together 876

⚠️ **876 is an INFERENCE-ONLY number** (no backward pass, nothing else competing
for CPU). Do not use it as a training target. Production `precompute` lands at
626 rather than 876 because of its per-sample manifest filtering and `.npz`
accumulation.

**Two implementation traps, both cost real time:**
1. **`batch_size=None` collapses throughput to 174 img/s even with 8 workers** —
   every image then pays its own IPC round trip between worker and main process.
   Batching *inside* the DataLoader (`batch_size=N` + a `collate_fn` returning
   `(ids, stacked)`) was worth ~3.6x on its own. IPC, not decode, was the cost.
2. **One shard starves N workers** (231 img/s with 8). Shards are assigned
   round-robin whole-file, so a single `.tar` gives one worker everything. Needs
   10+ shards to reach full rate. An early 1-shard/512-image benchmark produced a
   bogus "more workers = slower" table for exactly this reason.

### Training throughput and batch size

`train_student.py` uses AMP (`GradScaler` line 445, `autocast` 486/505). It loads
**no teacher** — targets come from the cached embeddings, so only the student is
resident in VRAM.

**Batch size is a RECIPE hyperparameter, not a throughput knob.** Batch 96 +
lr 1e-4 *is* the 0.1 recipe. Changing it alters the gradient-noise scale and
breaks comparability with WingCLIP-0.1's 89.93 and with the 0.2 A/B. Every
historical run used **batch 96** (checkpoint `args`: `full7555_vitb`,
`full7555_locked_ep25`, `exp7` — all `batch=96`, `workers=10-12`).

Measured, TinyCLIP-39M + AMP on the 10 GB RTX 3080:

| batch | peak VRAM | throughput |
|---|---|---|
| **96 (use this)** | **5.15 GB** | **655 img/s** |
| 128 | 6.62 GB | 686 img/s |
| 256 | **10.01 / 10.24 GB** | thrashes, ~0 progress |

⚠️ **At batch 256 the driver THRASHES rather than OOM-ing cleanly**, so a run
merely *looks* slow (no epoch completing) instead of failing loudly. Worth
recognising: a training run making no visible progress at ~98% GPU and ~0% CPU
is a VRAM-pressure signature, not a hang.

Note bigger batches buy almost nothing here anyway: 96 → 128 is +4.7% throughput
for 33% more memory, because we are near the loader's practical ceiling once
training competes for CPU.

**Workers: 12 is correct, do not raise it.** Measured during the live pilot: GPU
**97-98% sustained**, load average 6.46 on 16 cores, loader steady-state ~1,012
img/s. The GPU is the bottleneck — which is what you want during training — and
the loader is comfortably ahead of it. More workers would only add contention.

### TRAP: WDS shards carry BioCLIP-2 targets baked in

`pack_webdataset.py` wrote `<key>.emb` (the BioCLIP-2 target) INTO each shard.
For sequential distillation the teacher changes but the images do not, so a
`--wds` run would **silently train against the OLD teacher**. `--mv-embeddings`
does not help — it hard-rejects single-view caches.

**Fix: `--sv-embeddings <dir>`.** `SingleViewTargets` loads a normal `--views 1`
precompute and overrides the shard-baked target per sample; samples absent from
the override are dropped. It logs `TEACHER OVERRIDE ... (shard .emb ignored)` —
check for that line before trusting any sequential-distillation run.

Cost is negligible: loader does 705 img/s without the override, 695 with it
(~1.4%). The 385 MB pickle shipped to each worker sounds alarming but costs
**2.9 s once** at startup; steady-state is 1,012 img/s.

## Consolidation history

Scripts were briefly split across `bioclip-birdid`/`bioclip-distill` branches
(consolidated 2026-07-22); five ml docs merged into this file 2026-07-23; the Pi
checkout deleted + scratch scripts symlinked 2026-07-24; full consolidation into one
directory + corpus deletion 2026-07-25; this reorganization (current-truth-first)
2026-07-31.

**Convention (set 2026-07-31): NO CORRECTION STACKS.** When a claim in this file
turns out wrong, EDIT IT IN PLACE to the current truth. Do not append a
"⚠️ CORRECTION" section below it. You would never fix a bug by leaving the broken
function and adding a comment saying "actually this is wrong, see below" — the
same applies here. Git holds the history; this file holds the truth. Keep a
mistake only when the mistake itself is instructive (e.g. a failure mode that
looks like something else), and then state it as a warning in the settled text,
not as a chronological correction.

## TinyCLIP paper: what applies to us (read 2026-07-31)

Wu et al., ICCV 2023 (MSR). Read for actionable technique, not summary.
`https://openaccess.thecvf.com/content/ICCV2023/papers/Wu_TinyCLIP_CLIP_Distillation_via_Affinity_Mimicking_and_Weight_Inheritance_ICCV_2023_paper.pdf`

### ⚠️ FINDING THAT CONTRADICTS OUR PLAN: a BETTER teacher is a WORSE teacher

Their Table 4 — student TinyCLIP ViT-40M/32 (59M params), inherited from
different teachers, then trained 1 epoch on LAION-400M **without distillation**:

| teacher | teacher acc | student acc |
|---|---|---|
| *(no inheritance)* | — | 36.2 |
| CLIP ViT-B/32 | 63.2 | 52.4 (+16.2) |
| **OpenCLIP ViT-B/32** | **62.9** | **53.5 (+17.3)** |
| OpenCLIP ViT-B/16 | 67.1 | 52.8 (+16.6) |
| OpenCLIP ViT-L/14 | 75.3 | 45.1 (+8.9) |
| OpenCLIP ViT-H/14 | **78.0** | **41.1 (+4.9)** |

Their words: *"although ViT-H/14 ranks as the highest-performing teacher model,
it lags behind other models in terms of weight inheritance."* **Architectural
proximity beats teacher accuracy** — the best teacher (78.0) produced the WORST
student (41.1), 12.4 points below the weakest teacher.

**Implication for us:** this is specifically about *weight inheritance*, which we
are NOT doing (we take TinyCLIP's own pretrained weights, not surgery on
WingCLIP). So it does not directly invalidate WingCLIP-0.1 as our distillation
teacher. But it is a caution: WingCLIP-0.1 is ViT-B/16 and TinyCLIP-39M is
`vit_medium_patch16` — close enough that the concern is mild, and our teacher is
86.6M not 300M+. Worth re-reading if the pilot underperforms.

### Affinity mimicking — NOT applicable to our setup, and why

Their loss (Eq. 1-3) distills the **image-text affinity matrix**, not features:

```
L_distill = L_I2T + L_T2I
          = CE(A^s_I2T, A^t_I2T) + CE(A^s_T2I, A^t_T2I)
A_I2T(i,j) = softmax over texts of (I_i · T_j / tau)
A_T2I(i,j) = softmax over images of (I_i · T_j / tau)
```

Ablation (Table 2, ViT-40M/32, 1 epoch LAION-400M, zero-shot IN-1k):

| mode | loss | top-1 |
|---|---|---|
| contrastive (CLIP baseline) | `CE(<Is,Ts>, I)` | 53.4 |
| **affinity mimicking** | `CE(<Is,Ts>, <It,Tt>)` | **55.5** |
| cross-modality | `CE(<Is,Tt>, <It,Tt>)` | 55.3 |
| **single modality** | `CE(<Is,It>, I)` | **19.2** |

**+2.1 pts over contrastive.** The headline is real but **requires a TEXT TOWER
and paired captions in the batch** — it distills relationships between negative
pairs across modalities. We do **feature distillation** (cosine to a cached 768-d
target) with **no text tower at training time and no captions**, so affinity
mimicking is not available to us without re-architecting Phase 3 entirely.

⚠️ Note their "single modality" row (19.2) is NOT our setup either — that is
`CE(<Is,It>, I)`, an identity-matrix target on student-vs-teacher image features.
Ours is cosine regression onto the teacher embedding, which is closer to their
"cross modalities" family. Do not read 19.2 as evidence our approach fails; it is
a different loss.

### Hyperparameters they used

- Ablations: **1 epoch, lr 5e-4**, 32x V100/A100, PyTorch + OpenCLIP + timm +
  gradient cache.
- Teacher for distillation: OpenCLIP ViT-B/32 on LAION-2B (65.6% IN-1k) —
  chosen for *high throughput*, not for being the strongest model available.
- Note lr 5e-4 is **5x our 1e-4**. Ours is a much smaller dataset with cached
  targets, so not directly transferable, but flags that our LR may be
  conservative for a 39M model. Cheap to test after the A/B.

### Multi-stage progressive distillation — the applicable lesson

One-shot extreme compression causes **"divergence failure ... most weights of the
large model are directly discarded, including those that are important for
ensuring model quality and convergence."** Their fix: **~25% compression per
stage**, each stage = inherit + distil.

**Applicable to us as a fallback:** if TinyCLIP-39M underperforms from a single
86.6M→38.3M jump (2.26x), the paper's own remedy is to go in smaller steps. We
have `vit_betwixt_patch32` (61.1M) available as an intermediate: 86.6 → 61.1 →
38.3 is ~30% per step. Only worth the extra GPU-days if the direct jump fails.

### Redundancy finding (informative, we cannot act on it directly)

Fig. 4/5: **the text encoder is redundant in DEPTH (layer-wise), the image
encoder is redundant in WIDTH (channel-wise).** So they prune text by dropping
layers and image by dropping channels/heads. We ship no text tower and do not
prune, so this is background — but it explains why TinyCLIP's *image* variants
keep depth and shrink width, which is what `vit_medium` is.

### Net: what we should actually adopt

1. **Nothing changes for the running pilot.** Affinity mimicking needs a text
   tower we do not have; weight inheritance is already baked into the pretrained
   TinyCLIP checkpoints we load from timm.
2. **Keep progressive distillation (86.6 → 61.1 → 38.3) as the documented
   fallback** if the direct 2.26x jump loses too much.
3. **Consider testing lr 5e-4** (or at least 2-3e-4) for the 39M student after
   the A/B settles — smaller models often want higher LR, and 1e-4 was tuned for
   the 86.6M ViT-B.
4. **Do NOT assume a stronger teacher is better.** Their Table 4 is the opposite
   for inheritance, and it is a live question for distillation too. If TinyCLIP
   from WingCLIP-0.1 disappoints, the BioCLIP-2 cache is a ready control.
