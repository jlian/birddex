# WingDex on-device bird ID: distillation → WingCLIP → occurrence rerank

**Single source of truth** for the on-device / offline bird-ID effort. Tracks issue
[#260](https://github.com/jlian/wingdex/issues/260). Branch: `bioclip-distill`.
Working location: `~/wingdex/ml/distill/` on tomahawk (repo + data + uv venv).
Training data = WebDataset shards on the NAS.

---

## How to edit this file

**NO CORRECTION STACKS.** When a claim here turns out wrong, EDIT IT IN PLACE. Do
NOT append a "CORRECTION" section below it. You would never fix a bug by leaving the
broken function and adding a comment saying "actually this is wrong, see below".
**Git holds the history; this file holds the truth.**

**Phase tables use ONE schema: ID | Title | Description | ● | Findings.**

- **Phases are letters** (Phase A, Phase B). **Item IDs are letter + number** (A1,
  B3). Never number a phase, or it reads like an item.
- **ID** is permanent. Next ID = highest ever assigned in that phase + 1. Never
  reuse, never renumber. Rows may move; the ID travels with the row.
- **Title** is short and scannable. **Description** says what the work is AND why we
  are doing it. Both are write-once.
- **Findings** is the ONLY mutable cell. Write a claim, not a diary entry.
- **●** is one status emoji, nothing else.

**Always state the CONDITIONS a result holds under.** "It LOST" is not a fact; "it
lost on ViT-B with BioCLIP-2 targets" is. Unscoped verdicts get misapplied to
experiments they do not cover.

**Status:** ✅ settled · 🔬 running · ⬜ next · ❓ open · ⚠️ contested · 🗑️ rejected

**The tables ARE the work queue.** There is no separate status section to go stale.
Unfinished work keeps its row in the phase where it arose, marked ❓. When we commit
to doing it, move it into the phase that will do it and mark it ⬜.

**Writing style: simplified technical English.** One idea per sentence. Active voice.
Present tense for current truth. Short common words. Long prose goes in an appendix.

---

## Standing rules

These are decisions, not findings. Do not re-litigate them without asking.

- **Never run two GPU jobs at once on tomahawk.** Concurrent jobs wedged the host on
  2026-07-25 and cost training progress. Every queue script is sequential and
  marker-gated for this reason.
- **Train locally on the 3080.** Cloud rental was evaluated and rejected: upload runs
  at ~14 MB/s and RunPod bills during the upload. Do not re-pitch it.
- **Do NOT ship BirdLife range data.** Its only unique job is the narrow "out of range
  AND no occurrence record" case. Users in uncovered areas get vision-only ID, and
  that is explicitly acceptable.
- **WingDex is strictly non-commercial.** Data agreements with BirdLife, iNat and
  eBird depend on it, and the licence analysis assumes it.
- **Corpus floor 50, cap 500.** John chose maximum species coverage over disk and
  time, and wants class imbalance handled at train time instead.
- **Generate Python, never hand-write it to disk.** Build the file as a list of lines,
  join with `chr(10)`, pass it through `bin/safepy`, then `py_compile` remotely. A
  literal backslash-n leaking into source has broken working files more than once.
## Phase A — Feasibility

The app used a hosted VLM for every identification. That costs money per photo, needs
a network round-trip, and cannot work offline. The question was whether a bird-ID
model could run on the device at all.

**Why not an on-device general LLM:** iOS Foundation Models gained vision but is a
generalist and weak at fine-grained species ID. Apple's own guidance routes species
ID to a specialist via tool calling. **Why not Merlin:** the gold standard is a
purpose-built Visipedia/Cornell CNN trained on eBird's private corpus, and is not
obtainable.

**Why BioCLIP-2** (`imageomics/bioclip-2`, NeurIPS 2025): a CLIP ViT-L/14 retrained
on TreeOfLife-200M (200M organism images, 952K taxa). MIT-licensed, exports to both
ONNX and Core ML, and it is the SOTA open bird encoder. One model serves web, iOS
and Android.

| ID | Title | Description | ● | Findings |
|----|-------|-------------|---|----------|
| A1 | Run BioCLIP-2 in a browser | Measure the real download and memory cost of the teacher, to see if we can skip distillation entirely | ✅ | Not possible. 307 MB is inseparable from the accuracy. Distillation is the only path to on-device. |
| A2 | Choose what to distil | Copy the teacher's logits, or its embeddings? Logits lock the class list at training time | ✅ | Distil into the teacher's 768-d embedding space. Classification stays zero-shot against text embeddings, so species can be added by changing prompts, not retraining. |
| A3 | Choose the input resolution | Teacher runs at 224 but source photos are 500px, so a bigger student input might carry more detail | ✅ | Use 224 for both. Matching the teacher's own view is what makes the cached targets valid. |
| A4 | Adopt an upstream training path | The first hand-rolled training loop ran at 40 img/s, which made every experiment too slow to iterate on | ✅ | Adopted the open_clip / DataCompDR reference structure instead of hand-rolling. Now ~720 img/s. |

## Phase B — Corpus and first student

With the method settled, we needed data and a working baseline to measure everything
else against.

| ID | Title | Description | ● | Findings |
|----|-------|-------------|---|----------|
| B1 | Build the training corpus | Pull iNat photos with a ≥50/species floor (too few and the species is unlearnable) and a 500/species cap (common species would otherwise dominate) | ✅ | 7,555 species, 2.64M images. |
| B2 | Move to WebDataset shards | Loose files over SMB spent most of their time on per-file stat calls rather than reading pixels | ✅ | 251 shards on the NAS. Sequential reads removed the stall. |
| B3 | Train the first ViT-B student | LAION ViT-B/16 init with a 512→768 projection into the teacher's space | ✅ | val_cos 0.9650, NABirds 81.83 = 94.7% retention. This checkpoint is WingCLIP-0.1-alpha. |
| B4 | Check observation-level leakage | iNat users upload several photos of the same bird, so a naive split puts near-duplicates on both sides and inflates every held-out number | ✅ | Dedup by observation id before any held-out claim. |

## Phase C — Recipe search on ViT-B

The baseline worked, so the question became how much a better training recipe was
worth. We swept one factor at a time on a cheap 500-species pilot, then tried the
winning combination at full scale.

| ID | Title | Description | ● | Findings |
|----|-------|-------------|---|----------|
| C1 | Sweep the learning rate | 5e-5 through 5e-4, everything else held fixed | ✅ | 7e-5 wins on pilot. 2.5e-4 and above are catastrophic by any measure. |
| C2 | Test the MobileCLIP recipe bundle | wd 0.2, beta2 0.95, warmup 500, grad-clip 1.0, borrowed wholesale from the MobileCLIP2 paper | ✅ | Worth +0.0016 val_cos on pilot. Marginal on its own. |
| C3 | Test light augmentation | RRC 0.65-1.0 + hflip. Mild on purpose: the cached teacher target is a centre crop, so a heavy crop would train the student toward a target that no longer describes the image | ✅ | +0.0048 val_cos on pilot, the biggest single lever, three times the rest of the bundle combined. |
| C4 | Test strong augmentation | RRC 0.08-1.0 with a 5-view teacher cache, which is the only sound way to use heavy crops since each view gets its own target | 🗑️ | Rejected. Regularizes best on held-out (105.9% vs 104.1%) but LOSES NABirds (92.55 vs 93.26). The cheap pilot saved a ~56 GPU-h full-corpus precompute. |
| C5 | Test more epochs | 40 epochs against 25, to see if the pilot was simply undertrained | 🗑️ | Rejected. 40 does not help. |
| C6 | Run the locked recipe at full scale | Combine C1-C3 and retrain on all 7,555 species, expecting the pilot gains to carry over | 🗑️ | LOST on ViT-B with BioCLIP-2 targets: 90.7% retention vs the old recipe's 94.7%. At 2.5M images the extra regularization has little overfitting left to prevent and instead costs representation quality. 0.1-alpha stays the base; 0.2-alpha is retired. |
| C7 | Isolate which knob lost C6 | C6 changed SIX variables at once, so "aug light + wd 0.2 caused it" is a guess across confounded variables | ❓ | Untested at full scale on any model. Aug light is the prime suspect: it is the largest lever and a regularizer, while beta2, warmup and grad-clip are near-universal defaults that do not trade representation quality. A pilot A/B cannot settle it.[^augscale] Scoped as F9 if the current run misses the bar. |

## Phase D — Beat the teacher

Distillation caps the student at roughly the teacher, because the teacher's embedding
IS the training target. To go past it the student needs information the teacher never
had: true species labels.

| ID | Title | Description | ● | Findings |
|----|-------|-------------|---|----------|
| D1 | Build a ground-truth held-out set | Real iNat species labels, deduped by observation so the fine-tune cannot be graded on photos it trained on | ✅ | 3,850 species / 151,042 photos after the D2 fix. |
| D2 | Fix the species sampler bug | The split never intersected with the species distillation actually trained on, so it pulled species the student had never seen | ✅ | 2,058 data-starved species (5-49 photos worldwide) were pure dilution. Removing them RAISED NABirds 89.45 → 89.93. |
| D3 | Fine-tune on true labels | Train on real labels while keeping the BioCLIP-2 text tower frozen as fixed class weights, so the model stays open-vocab and every existing eval stays valid | ✅ | In-distribution val 63.39 → 77.61 (+14.22). |
| D4 | Sweep the WiSE-FT alpha | Fine-tuning damages out-of-distribution accuracy, so interpolate back toward the distilled weights: θ = (1-α)·distilled + α·finetuned | ✅ | alpha 0.90 peaks on both bases → **89.93 NABirds**, beating the 86.41 teacher. Retention 104.1%. |
| D5 | Check what the fine-tune gained | Did it add new species (coverage) or sharpen known ones (recognition)? | ✅ | Recognition. All 24,633 NABirds test images are distilled species; zero come from the 2,058 starved ones. |
| D6 | Measure catastrophic forgetting | NABirds is all birds, so it cannot see general-knowledge loss. Imagenette can | ⚠️ | Base 01 collapses 8.0 pts across the alpha sweep, exactly as WiSE-FT theory predicts. Base 02 runs BACKWARDS on the same eval with no explanation. Do not build on base-02 general numbers. |

## Phase E — Integrate, and fix the ranker

With a model that beat its teacher, we wired it into the app pipeline and benchmarked
it. It scored worse than expected, which turned out to be a ranking problem rather
than a recognition problem, and fixing it produced the project's largest single gain.

| ID | Title | Description | ● | Findings |
|----|-------|-------------|---|----------|
| E1 | Run the golden-set benchmark | 27 hand-labelled photos through the full gated + range pipeline, against GPT and the teacher | ✅ | Scored 78/91 and looked like a recognition failure. Root cause was softmax CALIBRATION: top-5 matched the teacher at 96%, so the right answer was in the candidate list, just ranked below position 1. This failure started all of Phase E. |
| E2 | Replace the hand-rolled range rerank | The old logic was a stack of hand-tuned heuristics: a confidence floor, a tier table and a dominance gate | ✅ | Replaced by `score = sim/T + beta·log P(species\|cell)`. Two fitted parameters, no gates. Strong visual evidence now overcomes a bad prior on its own, which is what the dominance gate was hand-faking. |
| E3 | Choose the occurrence data source | iNat observations, BirdLife range maps, or GBIF, and whether we need more than one | ✅ | iNat occurrence alone is worth +15.05. BirdLife adds only +0.30 on top, so it is redundant rather than useless. GBIF adds exactly nothing: the fit drove its weight to 0.0 and naive count-summing HURTS by 1.44. |
| E4 | Set the absent-species floor | What probability to assign a species with no record in the cell. 87.2% of candidate slots have no record, so this value dominates | ✅ | log(1e-9) ≈ -20.7 is optimal and the curve plateaus there. A soft floor is catastrophic: at -2 or -4 the optimiser drives beta to 0 and abandons geography entirely. Absence must count as strong evidence. |
| E5 | Validate in the shipping JS pipeline | All prior agreement between the Python reference and the shipping code was on n=23, which proves nothing | ✅ | 11,070 photos through `pipeline-experiment.mjs`: 89 top-1 / 94 top-5, agreeing with the 88.29 Python reference. |
| E6 | Stress-test the prior | A geographic prior could be memorising the training regions, and it goes stale as birds move | ✅ | Transfer penalty on unseen geography is only 0.87 pts, so it generalises. A 2-year-stale prior costs 2.88 pts (~2.04 genuine drift, ~0.84 density), so freshness matters ~2.4x more than volume. Refresh quarterly. ⚠️ `temporal_holdout.py` prints an auto-verdict saying "yearly refresh is plenty" that compares the DENSITY delta, not the staleness delta. Ignore it; the staleness number is the pre-2024 row. |
| E7 | Build the shippable prior blob | One binary sliced client-side, rather than per-cell CDN objects or map tiles | ✅ | 5.41 MiB gzipped, 99,900 cells, 5-bit quantised, which is free (−0.03 pts). Verified against DuckDB with 0 species mismatches. The BirdLife layer it replaces is 260 MiB. |
| E8 | Test external sources where iNat is sparse | Every calibration photo IS an iNat observation, so its cell is covered by construction | ❓ | Unmeasured, and this eval set structurally cannot answer it. E3's conclusions hold only for photos taken where iNat users go. Needs a different eval set to close. |

## Phase F — Shrink the model to clear the size gate

WingCLIP-0.1 is accurate but 86.6M params. Quantisation alone cannot make it small
enough for the web, so this phase swaps in a smaller backbone. Changing the student
also re-opened the teacher question, because the best teacher for an 86.6M student is
not automatically the best teacher for a 38.3M one.

**Ship bar for this phase:** after fine-tune and WiSE-FT, beat BioCLIP-2's **86.41**
NABirds top-1 on the full 24,633-image eval. Grade the distill-only stage against
**81.83**, which is what 0.1-alpha scored before its own fine-tune added ~8 points.

| ID | Title | Description | ● | Findings |
|----|-------|-------------|---|----------|
| F1 | Measure what quantisation costs | Fake-quantise weights in torch and run the normal eval, to find the smallest format that keeps the accuracy | ✅ | fp16 is exactly free. int8 costs 0.05 pts at 87 MB. int4 costs 0.88 pts at 43 MB. int3 and int2 COLLAPSE to 0.00% top-1: the embedding is destroyed, not merely noisy. |
| F2 | Decide the size target | Sub-25 MB came from a MobileCLIP-era assumption and may no longer be the right goal | ✅ | ViT-B cannot reach 25 MB by quantisation alone. Clearing it requires a smaller backbone. int4 at 43 MB stays an excellent trade for iOS. |
| F3 | Pick the smaller backbone | Needs a permissive license, published basis weights, and an output dim that fits the existing projection | ✅ | TinyCLIP-39M. MIT-licensed, ships weights on timm, 512-d output matches ViT-B-16, 19.2 MB at int4. MobileCLIP-S2 is research-license only. ViT-B-32 saves nothing: patch size changes token count, not param count. |
| F4 | Re-pick the teacher for the new student | WingCLIP-0.1 now beats BioCLIP-2 on birds, so the original teacher may no longer be the best target | ✅ | WingCLIP-0.1 wins by **+5.65** NABirds top-1 (89.09 vs 83.44) at n=24,633, identical recipe, only the teacher differs. A student of WingCLIP-0.1 can beat BioCLIP-2 because WingCLIP-0.1 is not a pure distillation: it carries a ground-truth fine-tune BioCLIP-2 never had. Distillation still cannot exceed its OWN teacher, since that embedding is the target. |
| F5 | Test val_cos as the teacher selector | val_cos is cheap and available every epoch, so it would be a convenient proxy for the expensive eval | ✅ | Disqualified. It ranked the LOSING teacher higher. It measures agreement with the teacher on in-distribution data, so it cannot see a teacher that is itself wrong. |
| F6 | Choose the recipe basis for TinyCLIP | Phase C settled the recipe for ViT-B, but a 2.2x capacity cut may move back into the regime where regularization helps | ✅ | 0.2 basis wins on the pilot: val_cos 0.9560 vs 0.9438. This is the opposite of the C6 result at full scale on ViT-B, which is the expected direction for a smaller model. |
| F7 | Run the full 7,555-species distill | TinyCLIP-39M, 0.2 basis, WingCLIP-0.1 teacher, 25 epochs | 🔬 | Running since 2026-08-02. ~720 img/s, ~29 h. |
| F8 | Fine-tune and sweep alpha | Same chain as D3/D4 applied to the new student, queued to run unattended when F7 finishes | ⬜ | Queued in `jobs/phase2.sh`, with a 5-point alpha sweep. Do NOT reuse alpha 0.90: it came from a gentle fine-tune on a 2.26x larger model, and a smaller model likely wants a lower alpha. |
| F9 | Retrain at full scale without aug light | Only if F8 misses the ship bar. Tests C7's suspect directly by changing ONE variable against F7 | ⬜ | Not started, and deliberately conditional: it costs ~29 h for the student, plus ~62 GPU-h if the ViT-B teacher is retrained too. If F8 clears 86.41 this stays unrun and the question stays open.[^augscale] |

## Phase G — Ship

Nothing here is blocking yet, but the runtime decision gates the export format, and
the format was chosen before the target, which is backwards.

**Decided: ship WORLDWIDE, occurrence-only, one blob.** Regional bundling saves only
~0.4 MiB and costs region detection plus travel fallback logic. One binary sliced
client-side also avoids a file-count ceiling: Cloudflare Pages caps at 20,000 files
and 4x4 tiling would have needed 14,721.

| ID | Title | Description | ● | Findings |
|----|-------|-------------|---|----------|
| G1 | Choose the on-device runtime | onnxruntime-web, transformers.js, WebGPU, or Core ML. Each wants a different artifact | ❓ | Undecided, and no client code exists yet. The int8 format was picked before the target runtime. |
| G2 | Export to ONNX | Needed for any web runtime; Core ML converts from torch directly and skips this | ⚠️ | fp32 export is bit-exact (worst cosine 1.00000000). **fp16 export is BLOCKED** by converter bugs and must be solved before any WebGPU work. |
| G3 | Measure CPU latency | Decides whether WASM/CPU is a real target or only a fallback | ✅ | int8 at 4 threads = 143.6 ms, ~1.7x faster than fp32. Imperceptible beside the network round-trip it replaces, so CPU is a viable target. |
| G4 | Clear the license gate | The app is public, so weights, corpus and derived artifacts all need clean licenses | ✅ | LAION ViT-B and TinyCLIP are both clean. Apple MobileCLIP weights are research-only, which is why F3 rejected them. |
| G5 | Ship one artifact per runtime | Same weights, different precision per platform | ⬜ | Plan is iOS int8, web int4. TinyCLIP changes these numbers, so re-measure after F7. |
| G6 | Replace GPT bird detection and framing | GPT returns `birdCenter` / `birdSize` / `multipleBirds`; a pure classifier returns none of that, so the app loses features unless we substitute | ❓ | Candidates: iOS Vision framework animal detection (boxes and count, free) and the existing web manual-crop UX, which is model-agnostic. The softmax gate CANNOT stand in for this: Spearman 0.032 against bird area. The earlier "low confidence means crop" framing was design intent, never validated, and is disproven for the range NABirds covers. |
| G7 | Ship the range data offline | On-device ID is pointless if the ranker still needs a network call for geography | ✅ | Ship the 5.41 MiB occurrence blob, not the 260 MiB BirdLife store. Lookup is a grid index plus a vector op on the 27 km Equal Earth grid (1276x618). |
| G8 | Refresh the occurrence prior | The prior goes stale as bird distributions shift | ✅ | Quarterly. E6 measured 2.88 pts lost over 2 years, and freshness matters ~2.4x more than data volume. Version-stamp the blob filename and add an immutable Cache-Control entry. |
| G9 | Prove the adaptive router in a browser | One pipeline, swappable front end: on-device model when cached, hosted VLM otherwise | ⚠️ | `ml/demo/` loads BioCLIP-2 ViT-L int8 (307 MB) via onnxruntime-web with a WASM fallback. Verified by `validate_node.js`: int8 ONNX loads, embeddings are faithful, raw 74/83 pre-range matches PyTorch, CPU ~335 ms/img. **WebGPU latency and download/cache timing are still unmeasured** and need a real browser session. Swapping in WingCLIP at 19-43 MB is what makes it pleasant. |

---

## Eval methodology

Read this before trusting any number in this file. These traps produced wrong results
that looked exactly like right ones.

**Always pass `--pilot-species 0`.** The default is 500, and on the old global-ranked
pilot that scored **7 species while printing "500 species"** in its own header. Every
OOD number from that sweep was void. Full forensics in Appendix A.

**Read weights, not `args`.** A checkpoint's `args` dict records the flags of the
invocation that created it and is never updated afterwards. `wise_a0.90.pt` says
`alpha 0.5` while the real blend is 0.90. `full7555_locked_ep25` says
`pilot_species 500` while being a genuine full run, because `pick_rows()` is never
called in the `--wds` path.

**Check output-file mtimes.** A failed eval leaves the previous JSON in place and it
looks identical to a fresh one. A stale file reading 28.42 was nearly reported as a
real result.

**Use one teacher cache per teacher.** The cache is keyed by image path only and its
hit test is `all(path in cached)`, so a mismatched cache falls through to a silent
recompute instead of erroring. `runs/full7555_vitb/` holds a 282-row cache from the
void 7-species era; the correct one has 24,633 rows.

**val_cos does not decide anything that matters.** It has pointed the wrong way three
times: teacher choice (F5), the batch-128 comparison, and the 0.2 recipe at full
scale (C6). NABirds decides.

**Never compare a golden-set number to a large-set number.** The GPT-5.4-mini 83/87
baseline is n=23, self-labelled, where one image is worth 4.3 points. No GPT baseline
exists at scale and none is planned.

**Report ABSOLUTE accuracy, not conditional.** Conditional numbers (accuracy over
photos where the true species is in the top-K) once made a figure appear to exceed
the recall ceiling.

**Compare retention over a COMMON teacher.** A student distilled from WingCLIP-0.1
but reported against BioCLIP-2 is a real number with a misleading label.
`eval_nabirds.py` now emits `retention_vs_bioclip2_*` and `retention_vs_teacher_*`
separately.

---

## Reference

### Architecture

The student is a visual tower whose output is projected into BioCLIP-2's 768-d
embedding space and L2-normalised. `Student.forward()` IS the exportable graph.
Input resolution 224.

Classification is zero-shot cosine similarity against an **11,167 × 768 matrix of
BioCLIP-2 text embeddings**, computed once at build time and shipped frozen. **The
text encoder never runs on device.**

| component | shape | fp32 | int8 | int4 |
|---|---|---|---|---|
| ViT-B visual tower | 86.6M params | 346.3 MB | 87 MB | 43 MB |
| TinyCLIP-39M visual tower | 38.3M params | 153.3 MB | 38.3 MB | 19.2 MB |
| text classifier | 11,167 × 768 | 34.3 MB | ~8.6 MB | — |
| occurrence prior blob | 99,900 cells | — | 5.4 MB gzipped | — |

### The ranker (Strategy I, the shipped math)

```
score(species) = sim/T + beta · log P(species|cell)
```

- `T` fitted **0.007809**. It moves with the joint fit, so always state which fit
  produced a number.
- `beta` fitted ~0.6-1.33 depending on the fit.
- Fitted params live in `calibration_occ_01.json` and are specific to WingCLIP-0.1 @
  alpha=0.90. **A model swap REQUIRES a refit.**

`P(species|cell)` is empirical iNat occurrence: 157M research-grade observations →
3,176,965 bird (species,cell) pairs over 99,900 cells. Grid is 27 km Equal Earth on
the WGS84 ellipsoid, verified 12/12 against production `range-adjust.js`.

**Do NOT build the prior from `train_manifest.parquet`.** It is post-floor and
post-cap, so abundance ratios are flattened. Use the raw dump.

**Prior-dominance regimes**, tied to this fit's T:

| vision confidence | behaviour |
|---|---|
| > 0.9 | prior is decorative. Skip the range lookup on ~34% of traffic. |
| 0.6-0.9 | normal collaboration. |
| < 0.6 | prior flips 40-70% of answers. Change the wording; flag life-list entries as a guess. |

### Abstention

Ship the existing confidence gate at threshold 0.5. No separate bird detector is
needed: 2.4% of non-bird photos pass versus 88.4% of real birds, from a model never
trained to detect birds.

- Measured on Imagenette, which has EASY negatives. 2.4% is a floor, not a guarantee.
- **The gate is not a framing detector.** Correlation of top-1 confidence against
  relative bird area is Pearson 0.051. Low confidence means species ambiguity, not
  bad framing, so prompting the user to crop will mostly not help.

### Model registry

| name | what | run | result |
|---|---|---|---|
| `WingCLIP-0.1-alpha` | full ViT-B distill, 0.1 recipe | `full7555_vitb` | val_cos 0.9650 · NABirds 81.83 |
| `WingCLIP-0.1-beta` | 0.1-alpha + ground-truth fine-tune | `ft_clean_01` | GT-val 77.61 |
| **`WingCLIP-0.1`** | **0.1-beta + WiSE-FT alpha 0.90** | `ft_clean_01` | **NABirds 89.93** |
| `WingCLIP-0.2-alpha` | full ViT-B distill, 0.2 recipe | `full7555_locked_ep25` | NABirds 78.4 · retired, see C6 |
| `WingCLIP-0.3-alpha` | full TinyCLIP-39M distill | `full7555_tiny39` | running, see F7 |

### Measured results

**The chain:** 81.83 distill → 77.61 in-dist after fine-tune → **89.93 NABirds** at
WiSE-FT alpha 0.90. Teacher BioCLIP-2 = 86.41.

**Alpha sweep**, clean set, both bases, peak at 0.90 on both:

```
base 01:  0.25→85.86  0.50→88.42  0.75→89.69  0.90→89.93  1.00→89.77
base 02:  0.25→83.20  0.50→86.40  0.75→88.19  0.90→88.46  1.00→88.26
```

**Reranking**, absolute top-1 over 3,322 leak-free photos, recall ceiling 94.52:

| strategy | ABS top-1 |
|---|---|
| raw argmax, vision only | 72.94 |
| F: gated tiering, the old logic | 79.53 |
| H: log-sum + BirdLife | 81.87 |
| **I: log-sum + iNat occurrence** | **88.29** |

**Quantisation**, NABirds, all 24,633 images:

| variant | ~MB | top-1 | Δ |
|---|---|---|---|
| fp32 | 346 | 89.94 | — |
| fp16 | 173 | 89.94 | +0.00 |
| int8 | 87 | 89.89 | −0.05 |
| int4-blk128 | 43 | 89.06 | −0.88 |
| int3-blk128 | 32 | 0.00 | −89.95 |

**Method lesson, and it cost the most time in the project:** to answer "what does
precision cost", fake-quantise weights in torch and run the normal eval, about 6 s
per variant. Only involve ONNX when the deliverable is the artifact itself. The ONNX
detour produced two wrong numbers.

### Cosine vs retention: the mental model

val_cos measures how closely the student reproduces the teacher's embedding on data
like the training set. Retention measures how much of the teacher's ACCURACY the
student keeps on a different task. They are not the same axis, and a student can
gain one while losing the other. Retention above 100% is normal once ground-truth
fine-tuning adds knowledge the teacher never had.

### CPU latency

Measured on Ryzen/WSL under contention, so optimistic for a phone:

| threads | fp32 | int8 |
|---|---|---|
| 1 | 612.2 ms | 472.2 ms |
| 2 | 388.1 ms | 245.4 ms |
| 4 | 247.5 ms | 143.6 ms |

int8 is ~1.7x faster than fp32 on CPU. onnxruntime's CUDA provider does NOT
accelerate dynamically-quantised weights, so this measures the format that would
actually ship.

### The occurrence blob format (`WDOP`)

```
magic     4B   "WDOP"
version   1B   1
qbits     1B   5
reserved  2B
n_cells   4B   uint32
index     n_cells * 8B, sorted by cell_id:
            cell_id  u32  = row * 1276 + col
            offset   u32  = byte offset into payload
sentinel  8B   (0xFFFFFFFF, payload_len)
payload   per record: varint(delta of sorted species index) + 1B quantised logprob
```

Species are keyed by a 2-byte taxonomy index, which beats the 8-byte eBird code
(9.1 vs 27.3 MiB raw). The client recovers `log(p) = -q / 2.5`. The sentinel row
means cell length is always `index[i+1].offset - index[i].offset`.

**Keep sparse cells.** Cells with under 10 observations are 47.5% of cells but only
4.0% of pairs, so dropping them saves almost nothing and creates a fallback path.

### Papers we actually use

- **WiSE-FT** (Wortsman et al., CVPR 2022) is the handbook for D4. Fine-tuning
  damages out-of-distribution accuracy; interpolating back toward the pre-finetune
  weights recovers it. Our optimum sits at 0.90 rather than their ~0.5 because our
  fine-tune is gentle: 4.7% global weight movement, concentrated in the projection
  and last few blocks. A more aggressive fine-tune should move alpha DOWN.
- **MobileCLIP2** supplied the C2 recipe bundle. Their dataset-reinforcement scheme
  (multiple augmented-view embeddings per image) is what C4 tested and rejected.
- **TinyCLIP** (Wu et al., ICCV 2023) supplied the F3 backbone. See Appendix B.

### Pipeline scripts

Run in order from `ml/distill/`:

| script | job |
|---|---|
| `select_species.py` | species list from iNat taxonomy |
| `pull_images.py` | download the corpus |
| `pack_webdataset.py` | pack shards for training |
| `precompute_embeddings.py` | cache teacher targets |
| `train_student.py` | distillation |
| `finetune_groundtruth.py` | ground-truth fine-tune + WiSE-FT merge |
| `eval_nabirds.py` | the deciding OOD eval |
| `fit_occurrence.py` | fit T and beta |
| `build_prior_blob.py` | build the shippable occurrence blob |
| `jobs/full_run.sh` | the full 3-step distill run |
| `jobs/phase2.sh` | unattended fine-tune + alpha sweep |

**Teacher targets are baked into the shards.** `pack_webdataset.py` wrote the
BioCLIP-2 target into each shard, so a `--wds` run with a NEW teacher would silently
train against the OLD one. Pass `--sv-embeddings <dir>` to override, and check the
log for `TEACHER OVERRIDE` before trusting any sequential-distillation run.

---

## Appendix A — The 7-species trap

The pilot was **the top-500 species by GLOBAL iNat photo count**, a worldwide ranking
full of Greater Rhea, Hawaiian Duck and Swan Goose. **NABirds is North American.**
The two sets intersect on exactly **7 species**: Rufous Hummingbird, Nuttall's
Woodpecker, Yellow-billed Magpie, Oak Titmouse, Juniper Titmouse, California
Thrasher, Abert's Towhee.

So `eval_nabirds.py --pilot-species 500` scored 282 images over 7 species while
printing "500 species". The Wilson CIs quoted alongside were understated too, since
they assume 282 independent samples rather than 7 clusters. It reached back to the
2026-07-25 sweep as well.

**Why it hid:** those 7 species sit at the very top of the global count ranking
(Baeolophus ridgwayi 499 images, Melozone aberti 496), so they entered a top-500
naturally. Nothing errored. The eval silently measured a tiny slice.

**Fix:** align the pilot species set TO the eval. All 401 NABirds taxa exist in the
corpus with 184,958 images, so `wds-nabirds401` keeps the pilot the same size while
the eval grows from 282 images to the full 24,633.

**Accepted tradeoff:** a NABirds-aligned pilot is North-American-biased and is no
longer a random slice of the corpus, so recipe conclusions from it may not transfer
perfectly to the full run.

## Appendix B — TinyCLIP paper notes

Wu et al., ICCV 2023 (MSR), "CLIP Distillation via Affinity Mimicking and Weight
Inheritance".

**A better teacher can be a worse teacher.** Their Table 4, student TinyCLIP
ViT-40M/32 inherited from different teachers:

| teacher | teacher acc | student acc |
|---|---|---|
| CLIP ViT-B/32 | 63.2 | 52.4 |
| OpenCLIP ViT-B/32 | 62.9 | **53.5** |
| OpenCLIP ViT-L/14 | 75.3 | 45.1 |
| OpenCLIP ViT-H/14 | **78.0** | **41.1** |

Architectural proximity beats teacher accuracy. **This is about weight inheritance,
which we do NOT do**, so it does not invalidate WingCLIP-0.1 as our teacher. It is a
caution worth re-reading if F7 underperforms.

**Affinity mimicking does not apply to us.** Their loss distils the image-text
affinity matrix, which needs paired text per image. We distil features into a fixed
embedding space and have no per-image text.

**Multi-stage progressive distillation** (86.6M → ~60M → 39M) is their answer if a
direct jump loses too much. Any intermediate must be **patch16**; see Appendix C.

## Appendix C — Rejected and confounded experiments

**exp4 proves nothing about capacity.** `vit_betwixt_patch32_clip_224` is patch32 =
49 tokens, while the 39M `vit_medium_patch16` is patch16 = 196 tokens. The "bigger"
model has 4x less spatial resolution, which is why it trained faster and scored
worse. It does NOT show 61M < 39M.

**The LR sweep was run on the recipe we abandoned.** exp1-exp4 were all 0.1 basis
with only `--lr` varying, while the winner is 0.2 basis. Re-run on the 0.2 basis
afterwards: 3e-5 = 0.9546, 5e-5 = 0.9563, 7e-5 = 0.9560, so 7e-5 stands.

**Two ONNX numbers that were WRONG, and why.** "int4 = 75.3 MB" came from
`MatMulNBitsQuantizer`, which quantises only MatMul weights and leaves embeddings,
LayerNorm, bias and (in an earlier torch bug) all attention `in_proj_weight` at
fp32. Quantising every weight in torch gives the true 43 MB. "fp16 cannot be built"
is true only of the ONNX converters, not of accuracy: fp16 in torch is one `.half()`
call and works perfectly. Export-format problems are DEPLOYMENT problems, not
accuracy problems.

**Two aug facts that were repeatedly confused**, corrected from checkpoint `args`
rather than prose: the 0.1 DISTILLATION used `aug none`, the 0.2 distillation used
`aug light`, and the 0.1 FINE-TUNE used `aug light`. Distillation and fine-tuning are
different stages. Conflating them once produced the wrong conclusion that "both
recipes use aug light, so wd 0.2 is the differentiator".

## Appendix D — Throughput and hardware

Real work, but not a link in the shipping chain.

**The loader ceiling is the TRANSFORMS, not SMB.** Decode is not the binding
constraint either.

**`nvidia-smi` utilization is a liar for this workload.** It reports whether any
kernel is resident, not whether the SMs are busy.

**We run at 61% of the real GPU ceiling.** The RTX 3080 ceiling for AMP training is
~60 TFLOP/s, not the 119 on the spec sheet: 119 assumes fp16 accumulate, while AMP
accumulates in fp32, which runs at half rate on GeForce Ampere. Measured directly
with `jobs/gemm_peak.py`: bf16 N=8192 = **63.7 TFLOP/s**. We achieve 38.9, so 61%,
which is normal for ViT training. **Never quote 119 for this card under AMP.**

**GPU-side tuning is DONE.** bf16 + channels_last + torch.compile captured ~1.17x.
Backward is ~64% of step time and the optimizer only ~4.6%, so fused AdamW measures
+0.4%. What remains is architectural or hardware, not configuration.

**Batch size is a free knob**, not a speed lever.

**`torch.compile` checkpoints.** Compiling wraps the module, so every state_dict key
gains an `_orig_mod.` prefix and will not load into a plain module. This cost a full
2-hour run. Fixed on both sides: training saves unwrapped, eval strips the prefix.

**Run profiling only on an IDLE GPU.** A concurrent job silently contaminates the
result. CPU-side work also contends with the dataloader: an eval run on CPU during
training dropped throughput from 715 to 537 img/s.

**Better hardware is worth MORE than it looks, not less.** We are near practical peak
on a card whose practical peak is half its headline number, so the remaining gains are
in the hardware rather than in configuration. This is the context for the RTX PRO 4500
question; no purchase has been made or recommended.

**Cloud economics.** Upload from tomahawk measures ~14 MB/s and RunPod bills during
upload, which dominates the decision.

## Appendix E — Consolidation history

Scripts were split across two branches, consolidated 2026-07-22. Five ml docs merged
into this file 2026-07-23. Pi checkout deleted 2026-07-24. One directory + corpus
deletion 2026-07-25. Current-truth-first reorganization 2026-07-31. Converted to the
phase-table schema 2026-08-03.

[^augscale]: The entire non-aug bundle (wd 0.2, beta2 0.95, warmup 500, grad-clip
    1.0) was worth +0.0016 on pilot, and those are near-universal optimizer defaults.
    Aug light alone was +0.0048. The stated explanation for C6's loss is that 2.5M
    images leave little overfitting to prevent, so regularization costs representation
    quality — an argument that applies to the regularizers (aug, wd), not to beta2 or
    warmup. A pilot A/B cannot settle it, because the hypothesis is that aug's sign
    DEPENDS on scale: measuring at pilot scale, where we already believe it helps,
    is not evidence about full scale.
