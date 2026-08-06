# WingDex on-device bird ID: distillation → WingCLIP → occurrence rerank

**Single source of truth** for the on-device / offline bird-ID effort. Tracks issue
[#260](https://github.com/jlian/wingdex/issues/260). Branch: [`bioclip-distill`](https://github.com/jlian/wingdex/tree/bioclip-distill).
Working location: `~/wingdex/ml/distill/` on tomahawk (repo + data + uv venv).
Training data = WebDataset shards on the NAS.

---

## How to edit this file

**NO CORRECTION STACKS.** When a claim here turns out wrong, EDIT IT IN PLACE. Do
NOT append a "CORRECTION" section below it. In code you delete the bad function.
Do the same here. **Git holds the history. This file holds the truth.**

**Phase tables use ONE schema: ID | Title | Description | ● | Findings.**

- **Phases are letters** (Phase A, Phase B). **Item IDs are letter + number** (A1,
  B3). Never number a phase, or it reads like an item.
- **ID** is permanent. The next ID is the highest ever used in that phase, plus 1.
  Do not reuse an ID. Do not renumber. A row can move. Its ID moves with it.
- **Title** is short. **Description** gives the work AND the reason for it. Write
  both one time only.
- **Findings** is the ONLY mutable cell. Write a claim, not a diary entry.
- **●** is one status emoji, nothing else.

**Always give the CONDITIONS for a result.** "It LOST" is not a fact. "It lost on
ViT-B with BioCLIP-2 targets" is a fact. A result without conditions gets applied
to experiments that it does not cover.

**Status values:**

- ✅ settled
- 🔬 running
- ⬜ next
- ❓ open
- ⚠️ contested
- 🗑️ rejected

**The tables are the work queue.** There is no separate status section, because a
status section goes stale. Open work keeps its row in the phase that found it.
Mark it ❓. When you commit to the work, move the row to the phase that will do
it. Then mark it ⬜.

**Write in simplified technical English.** Use one idea in each sentence. Use the
active voice. Use the present tense for current truth. Use short common words.
Keep sentences to 20 words or less. Put long text in an appendix.

---

## Standing rules

These are decisions, not findings. Do not re-litigate them without asking.

- **Never run two GPU jobs at once on tomahawk.** Two jobs locked up the host on
  2026-07-25. We lost training progress. Each queue script therefore runs one step
  at a time. Each step has a marker file as a gate.
- **Train locally on the 3080.** We examined cloud rental and rejected it. Upload
  runs at ~14 MB/s, and RunPod charges during the upload. Do not propose it again.
- **Do NOT ship BirdLife range data.** It does one job that occurrence data cannot
  do. That job is the "out of range AND no occurrence record" case. Users in those
  areas get vision-only ID. That result is acceptable.
- **WingDex is strictly non-commercial.** The data agreements with BirdLife, iNat and
  eBird depend on this. The license analysis also assumes it.
- **Corpus floor 50, cap 500.** John selected maximum species coverage. Disk space
  and time are less important. Correct the class imbalance at train time.
- **Generate Python. Never hand-write it to disk.** Build the file as a list of lines.
  Join them with `chr(10)`. Send the result through `bin/safepy`. Then run
  `py_compile` on the remote host. A literal backslash-n in the source has broken
  working files more than one time.
## Phase A: Feasibility

The app sends every photo to a hosted VLM. This costs money for each photo. It also
needs a network connection, so it cannot work offline. The first question was
simple: can a bird-ID model run on the device at all?

**Why not a general LLM on the device.** iOS Foundation Models can read images, but
it is a generalist. It is weak at fine-grained species ID. Apple sends species ID
to a specialist model through tool calling.

**Why not Merlin.** Merlin is the gold standard. It uses a purpose-built CNN from
Visipedia and Cornell, trained on the private eBird corpus. We cannot get it.

**Why BioCLIP-2** ([`imageomics/bioclip-2`](https://huggingface.co/imageomics/bioclip-2), NeurIPS 2025). It is a CLIP ViT-L/14,
trained again on TreeOfLife-200M: 200M organism images and 952K taxa. It has an
MIT license. It exports to ONNX and to Core ML. It is the best open bird encoder
available. One model serves web, iOS and Android.

| ID | Title | Description | ● | Findings |
|----|-------|-------------|---|----------|
| A1 | Run BioCLIP-2 in a browser | Measure the real download and memory cost of the teacher, to see if we can skip distillation entirely | ✅ | Not possible. 307 MB is inseparable from the accuracy. Distillation is the only path to on-device. |
| A2 | Choose what to distil | Copy the teacher's logits, or its embeddings? Logits lock the class list at training time | ✅ | Distil into the teacher's 768-d embedding space. Classification stays zero-shot against text embeddings, so species can be added by changing prompts, not retraining. |
| A3 | Choose the input resolution | Teacher runs at 224 but source photos are 500px, so a bigger student input can carry more detail | ✅ | Use 224 for both. Matching the teacher's own view is what makes the cached targets valid. |
| A4 | Adopt an upstream training path | The first hand-rolled training loop ran at 40 img/s, which made every experiment too slow to iterate on | ✅ | Adopted the open_clip / DataCompDR reference structure instead of hand-rolling. Now ~720 img/s. |

## Phase B: Corpus and first student

The method was now clear. Next we needed data, and a baseline to measure all later
work against.

| ID | Title | Description | ● | Findings |
|----|-------|-------------|---|----------|
| B1 | Build the training corpus | Pull iNat photos with a ≥50/species floor (too few and the species is unlearnable) and a 500/species cap (without a cap, common species dominate) | ✅ | 7,555 species, 2.64M images. |
| B2 | Move to WebDataset shards | Loose files over SMB spent most of their time on per-file stat calls rather than reading pixels | ✅ | 251 shards on the NAS. Sequential reads removed the stall. |
| B3 | Train the first ViT-B student | LAION ViT-B/16 init with a 512→768 projection into the teacher's space | ✅ | val_cos 0.9650, NABirds 81.83 = 94.7% retention. This checkpoint is WingCLIP-0.1-alpha. |
| B5 | Explain the species funnel | 11,167 in the taxonomy, 7,555 distilled, 3,850 fine-tuned. The numbers look arbitrary and get questioned every time | ✅ | Two of the three cuts are scarcity, not policy. **11,167 to 7,555:** the corpus needs 50 photos per species and 3,612 species do not have 50 research-grade open-licensed photos on iNat worldwide. **7,555 to 3,850:** the ground-truth set needs 5 photos the distillation never saw, and species that were scarcity-limited already gave up everything they had. Lowering the floor repeats the [D2](#phase-d-beat-the-teacher) bug. It admits species with a median of 24 photos worldwide, which cannot be learned and dilute the classifier. **Coverage is not affected.** Classification is zero-shot cosine against the 11,167-row text matrix, so a species needs a NAME, not training images. All 11,167 stay predictable. Fine-tuning sharpens 3,850 of them. |
| B4 | Check observation-level leakage | iNat users upload several photos of the same bird, so a naive split puts near-duplicates on both sides and inflates every held-out number | ✅ | Dedup by observation id before any held-out claim. |

## Phase C: Recipe search on ViT-B

The baseline worked. The next question was the value of a better training recipe. We
changed one factor at a time on a cheap 500-species pilot. Then we ran the best
combination at full scale.

| ID | Title | Description | ● | Findings |
|----|-------|-------------|---|----------|
| C1 | Sweep the learning rate | 5e-5 through 5e-4, everything else held fixed | ✅ | 7e-5 wins on pilot. 2.5e-4 and above are catastrophic by any measure. |
| C2 | Test the MobileCLIP recipe bundle | wd 0.2, beta2 0.95, warmup 500, grad-clip 1.0, borrowed wholesale from the MobileCLIP2 paper | ✅ | Worth +0.0016 val_cos on pilot. Marginal on its own. |
| C3 | Test light augmentation | RRC 0.65-1.0 + hflip. Mild on purpose: the cached teacher target is a center crop, a heavy crop trains the student toward a target that no longer describes the image | ✅ | +0.0048 val_cos on pilot, the biggest single lever, three times the rest of the bundle combined. |
| C4 | Test strong augmentation | RRC 0.08-1.0 with a 5-view teacher cache, which is the only sound way to use heavy crops since each view gets its own target | 🗑️ | Rejected. Regularizes best on held-out (105.9% vs 104.1%) but LOSES NABirds (92.55 vs 93.26). The cheap pilot saved a ~56 GPU-h full-corpus precompute. |
| C5 | Test more epochs | 40 epochs against 25, to see if the pilot was undertrained | ⚠️ | [exp8](#experiment-register) ran 40 epochs and peaked at epoch 38 with val_cos 0.9503. [exp7](#experiment-register) got 0.9540 in 25 epochs. But exp8 also used lr 1e-4 against exp7's 7e-5, so the learning rate is a second variable. The result holds for the 500-species pilot only. |
| C6 | Run the locked recipe at full scale | Combine C1-C3 and retrain on all 7,555 species. We expected the pilot gains to carry over | 🗑️ | LOST on ViT-B with BioCLIP-2 targets: 90.7% retention vs the old recipe's 94.7%. At 2.5M images the extra regularization has little overfitting left to prevent and instead costs representation quality. 0.1-alpha stays the base. 0.2-alpha is retired. |
| C8 | Test the epoch budget at full scale | A run that peaks at its LAST epoch can be budget-limited rather than converged | ⚠️ | **Partly wrong as first written, corrected here.** Best-epoch alone does not show convergence. The per-epoch GAIN does. `full7555_vitb` peaked at 20 of 20 but its last four epochs gained +0.0005, +0.0003, +0.0001, +0.0001, so it DID converge and more epochs buy nothing. `full7555_locked_ep25` peaked at 25 of 25 and was still gaining +0.0017/epoch at epoch 21, so it was cut short. `full7555_tiny39` is the extreme case: it RE-ACCELERATED late, gaining +0.0047, +0.0039 and +0.0030 at epochs 17 to 19 after slowing to +0.0012 at epoch 9, and finished at 0.9641 still climbing. So one of three converged, not none. |
| C9 | Find the real epoch ceiling | C8 shows `full7555_tiny39` was still climbing at its final epoch. You cannot just add epochs: `--epochs` sets the LENGTH of the cosine anneal, because `steps = steps_per_epoch * epochs` feeds the LR lambda | ⬜ | Resume with the SAME `--epochs` and the LR is already at zero, so extra epochs do nothing. Resume with a LARGER value and the scheduler recomputes against the new length, so the LR jumps back up. That is an accidental warm restart, and `train_student.py` warns about it. Two valid methods: **A, retrain from scratch at `--epochs 35`**, one smooth anneal, directly comparable, ~41 h. **B, a deliberate SGDR warm restart** ([Loshchilov and Hutter, ICLR 2017](https://arxiv.org/abs/1608.03983)) from `last.pt`, ~11 h. Scope B carefully: SGDR is validated for from-scratch training against a single anneal at EQUAL budget, while B appends a restart to a finished run, so it answers only whether THIS model improves with more steps. TinyCLIP gives no support for B, because their multi-stage method is progressive PRUNING, not a restarted schedule. ⚠️ **LR and epochs are confounded, so test them together.** Every full-scale run that decelerated smoothly used a HIGHER LR than ours: `full7555_vitb` at 1e-4 converged, `full7555_locked_ep25` at 7e-5 nearly did, ours at 8.1e-5 did not. But both references are 86.6M models, so size is confounded too. The 0.2-basis LR sweep was also a three-way tie (3e-5 = 0.9546, 5e-5 = 0.9563, 7e-5 = 0.9560) in which ALL THREE stopped at their budget. A flat LR response where every arm is still improving indicates undertraining, not a well-chosen LR, and pilot optima are biased low for a schedule with about 10x more steps. |
| C7 | Isolate which knob lost C6 | C6 changed SIX variables at once, so "aug light + wd 0.2 caused it" is a guess across confounded variables | ❓ | Untested at full scale on any model. Aug light is the prime suspect: it is the largest lever and a regularizer, while beta2, warmup and grad-clip are near-universal defaults that do not trade representation quality. A pilot A/B cannot settle it.[^augscale] Scoped as F9 if the current run misses the bar. |

## Phase D: Beat the teacher

Distillation holds the student at approximately the level of the teacher. This occurs
because the embedding of the teacher IS the training target. To do better, the
student needs data that the teacher never had: true species labels.

| ID | Title | Description | ● | Findings |
|----|-------|-------------|---|----------|
| D1 | Build a ground-truth held-out set | Real iNat species labels, deduped by observation so the fine-tune cannot be graded on photos it trained on | ✅ | 3,850 species / 151,042 photos after the [D2](#phase-d-beat-the-teacher) fix. |
| D2 | Fix the species sampler bug | The split never intersected with the species distillation actually trained on, so it pulled species the student had never seen | ✅ | 2,058 data-starved species (5-49 photos worldwide) were pure dilution. Removing them RAISED NABirds 89.45 → 89.93. |
| D3 | Fine-tune on true labels | Train on real labels while keeping the BioCLIP-2 text tower frozen as fixed class weights, so the model stays open-vocab and every existing eval stays valid | ✅ | In-distribution val 63.39 → 77.61 (+14.22). |
| D4 | Sweep the WiSE-FT alpha | Fine-tuning damages out-of-distribution accuracy, so interpolate back toward the distilled weights: θ = (1-α)·distilled + α·finetuned | ✅ | alpha 0.90 peaks on both bases → **89.93 NABirds**, beating the 86.41 teacher. Retention 104.1%. |
| D5 | Check what the fine-tune gained | Did it add new species, or did it improve the species it knew? | ✅ | Recognition. All 24,633 NABirds test images are distilled species. None come from the 2,058 starved ones. |
| D6 | Measure catastrophic forgetting | NABirds is all birds, so it cannot see general-knowledge loss. Imagenette can | ⚠️ | Base 01 collapses 8.0 pts across the alpha sweep, exactly as WiSE-FT theory predicts. Base 02 runs BACKWARDS on the same eval with no explanation. Do not build on base-02 general numbers. |

## Phase E: Integrate, and fix the ranker

The model now scored higher than its teacher. We connected it to the app pipeline and
measured it. The score was lower than we expected. The cause was the ranking step,
not the recognition step. The correction gave the largest single gain in the
project.

| ID | Title | Description | ● | Findings |
|----|-------|-------------|---|----------|
| E1 | Run the golden-set benchmark | 27 hand-labelled photos through the full gated + range pipeline, against GPT and the teacher | ✅ | Scored 78/91 and looked like a recognition failure. Root cause was softmax CALIBRATION: top-5 matched the teacher at 96%, so the right answer was in the candidate list, just ranked below position 1. This failure started all of [Phase E](#phase-e-integrate-and-fix-the-ranker). |
| E2 | Replace the hand-rolled range rerank | The old logic was a stack of hand-tuned heuristics: a confidence floor, a tier table and a dominance gate | ✅ | Replaced by `score = sim/T + beta·log P(species\|cell)`. Two fitted parameters, no gates. Strong visual evidence now overcomes a bad prior on its own, which is what the dominance gate was hand-faking. |
| E3 | Choose the occurrence data source | iNat observations, BirdLife range maps, or GBIF, and whether we need more than one | ✅ | iNat occurrence alone is worth +15.05. BirdLife adds only +0.30 on top, so it is redundant rather than useless. GBIF adds exactly nothing: the fit drove its weight to 0.0 and naive count-summing HURTS by 1.44. |
| E4 | Set the absent-species floor | What probability to assign a species with no record in the cell. 87.2% of candidate slots have no record, so this value dominates | ✅ | log(1e-9) ≈ -20.7 is optimal and the curve plateaus there. A soft floor is catastrophic: at -2 or -4 the optimizer drives beta to 0 and abandons geography entirely. Absence must count as strong evidence. |
| E5 | Validate in the shipping JS pipeline | All prior agreement between the Python reference and the shipping code was on n=23, which proves nothing | ✅ | 11,070 photos through `pipeline-experiment.mjs`: 89 top-1 / 94 top-5, agreeing with the 88.29 Python reference. |
| E6 | Stress-test the prior | A geographic prior can memorize the training regions. It also goes stale as birds move | ✅ | Transfer penalty on unseen geography is only 0.87 pts, so it generalizes. A 2-year-stale prior costs 2.88 pts (~2.04 genuine drift, ~0.84 density), so freshness matters ~2.4x more than volume. Refresh quarterly. ⚠️ `temporal_holdout.py` prints an auto-verdict saying "yearly refresh is plenty" that compares the DENSITY delta, not the staleness delta. Ignore that verdict. The staleness number is the pre-2024 row. |
| E7 | Build the shippable prior blob | One binary sliced client-side, rather than per-cell CDN objects or map tiles | ✅ | 5.41 MiB gzipped, 99,900 cells, 5-bit quantized, which is free (−0.03 pts). Verified against DuckDB with 0 species mismatches. The BirdLife layer it replaces is 260 MiB. |
| E8 | Test external sources where iNat is sparse | Every calibration photo IS an iNat observation, so its cell is covered by construction | ❓ | Unmeasured, and this eval set structurally cannot answer it. The [E3](#phase-e-integrate-and-fix-the-ranker) conclusions hold only for photos taken where iNat users go. Needs a different eval set to close. |

## Phase F: Shrink the model to clear the size gate

WingCLIP-0.1 is accurate, but it has 86.6M parameters. Quantization alone cannot make
it small enough for the web. This phase installs a smaller backbone. A new student
also opens the teacher question again. The best teacher for an 86.6M student is not
always the best teacher for a 38.3M student.

**Ship bar for this phase.** After the fine-tune and WiSE-FT, the model must score
more than **86.41** NABirds top-1. That is the BioCLIP-2 score on the full
24,633-image eval. Compare the distill-only stage against **81.83** instead.
0.1-alpha scored 81.83 before its fine-tune added approximately 8 points.

| ID | Title | Description | ● | Findings |
|----|-------|-------------|---|----------|
| F1 | Measure what quantization costs | Fake-quantize weights in torch and run the normal eval, to find the smallest format that keeps the accuracy | ✅ | fp16 is exactly free. int8 costs 0.05 pts at 87 MB. int4 costs 0.88 pts at 43 MB. int3 and int2 COLLAPSE to 0.00% top-1: the embedding is destroyed, not merely noisy. |
| F2 | Decide the size target | Sub-25 MB drove the whole backbone swap. Verify what the number actually is before designing around it | ✅ | **It is a PER-FILE cap, not a total budget.** [Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits/): "The maximum file size for a single Cloudflare Pages site asset is 25 MiB", plus a separate 20,000-file limit. So the rule is that no single asset exceeds 25 MiB, and total download is a UX concern rather than a hard gate. This also makes the constraint web-only: iOS ships through the App Store and never touches Cloudflare. Treating a per-asset cap as a total payload budget is what motivated the int4 work in [F10](#phase-f-shrink-the-model-to-clear-the-size-gate) and [F11](#phase-f-shrink-the-model-to-clear-the-size-gate). |
| F3 | Pick the smaller backbone | Needs a permissive license, published basis weights, and an output dim that fits the existing projection | ✅ | [TinyCLIP-39M](https://huggingface.co/timm/vit_medium_patch16_clip_224.tinyclip_yfcc15m). MIT-licensed, ships weights on timm, 512-d output matches ViT-B-16, 19.2 MB at int4. MobileCLIP-S2 is research-license only. ViT-B-32 saves nothing: patch size changes token count, not param count. |
| F4 | Re-pick the teacher for the new student | WingCLIP-0.1 now beats BioCLIP-2 on birds, so the original teacher can be the wrong target now | ✅ | WingCLIP-0.1 wins by **+5.65** NABirds top-1 (89.09 vs 83.44) at n=24,633, identical recipe, only the teacher differs. A student of WingCLIP-0.1 can beat BioCLIP-2 because WingCLIP-0.1 is not a pure distillation: it carries a ground-truth fine-tune BioCLIP-2 never had. Distillation still cannot exceed its OWN teacher, since that embedding is the target. |
| F5 | Test val_cos as the teacher selector | val_cos is cheap and available every epoch, so it makes a convenient proxy for the expensive eval | ✅ | Disqualified. It ranked the LOSING teacher higher. It measures agreement with the teacher on in-distribution data, so it cannot see a teacher that is itself wrong. |
| F6 | Choose the recipe basis for TinyCLIP | Phase C settled the recipe for ViT-B, but a 2.2x capacity cut can move back into the regime where regularization helps | ✅ | 0.2 basis wins on the pilot: val_cos 0.9560 vs 0.9438. This is the opposite of the [C6](#phase-c-recipe-search-on-vit-b) result at full scale on ViT-B, which is the expected direction for a smaller model. |
| F7 | Run the full 7,555-species distill | TinyCLIP-39M, 0.2 basis, WingCLIP-0.1 teacher, 25 epochs | 🔬 | Running since 2026-08-02. ~720 img/s, ~29 h. |
| F8 | Fine-tune and sweep alpha | Same chain as [D3 and D4](#phase-d-beat-the-teacher) applied to the new student, on a ground-truth set disjoint from BOTH the distillation corpus and the set that produced the teacher | ✅ | **SHIP BAR CLEARED: 86.90 against BioCLIP-2 at 86.41**, on the full 24,633-image eval. Best alpha is 0.60, with 0.75 tied. The optimum moved DOWN from the 0.90 that ViT-B wanted, as predicted for a 2.26x smaller model. Sweep: 0.25 86.27, 0.40 86.64, 0.50 86.82, 0.60 **86.90**, 0.75 86.90, 0.90 86.56. Fine-tune gain over the distill baseline is +1.92 (84.98 to 86.90). Retention against the WingCLIP-0.1 teacher (89.93) is 96.6% at 2.26x fewer parameters. The set is 143,890 photos over 3,662 species, excluded by photo_id and by observation_uuid. See the exclusion rule in [Eval methodology](#eval-methodology). |
| F10 | Measure quantisation on the SHIPPING ARTIFACT | Sizes were calculated, and the only measured int4 cost came from ViT-B. A WiSE-FT blend averages two weight sets, so it can carry a different outlier structure from the distill baseline | ✅ | Measured on `wise_a0.60.pt` over all 24,633 images. **int8 is the only usable format**: 86.82 at 38.9 MB, which clears the bar and preserves the embedding almost exactly (cos 0.999923, 99.27% top-1 agreement with fp32). Every int4 variant misses: blk128 81.50, blk64 84.06, blk32 84.61, mixed ffn4/blk32+sens8 85.07, mixed ffn4/blk64+sens8 85.19. Re-measuring on the blend mattered: blk128 lost 5.41 here against 8.85 on the distill baseline, so the artifact really does quantise differently. |
| F11 | Rescue int4 with block size and mixed precision | int4 at the default block of 128 collapses. Two standard fixes exist: a smaller group so fewer weights share one scale, and mixed precision that keeps sensitive layers at int8 | ✅ | **Both help and neither is enough.** Block 128 to 32 buys back 3.11 points (81.50 to 84.61) for 1.8 MB of extra scale metadata, which confirms outliers were the cause: one large weight in a block of 128 crushes the other 127 into a few levels. Mixed precision adds 0.58 more (85.19) but costs 5 MB, so it fails the size gate before accuracy matters. The best int4 variant still lands 1.2 points under the bar. **There is no configuration that is both small enough and accurate enough.** ⚠️ Also unverified: whether onnxruntime-web or Core ML accept block 32 efficiently. |
| F13 | Recalibrate the ranker for the new student | The shipped score is `sim/T + beta * log P(species\|cell)`. `T` and `beta` were fitted to WingCLIP-0.1 at alpha 0.90, so they set the wrong scale for a 38.3M student at alpha 0.60 | ✅ | Refitted: **T 0.00930 to 0.00760, beta 0.543 to 0.563**. An 18% move in T confirms the refit was needed rather than ceremonial. THREE inputs are candidate-ordered and must be rebuilt together: the candidate file holds one model's similarities, the counts matrix is indexed by candidate RANK, and the range-status file is a per-photo list in the same order. Validated in the shipping JS: `I_occurrence_SHIPPING` scores 94% top-1 and 97% top-5 over all 11,070 photos, against 81% for the old production logic. |
| F14 | Score both models head to head | The 88.29 figure was a ViT-B pipeline number. A fair comparison needs the same split, the same absolute metric, and each model using its OWN fitted parameters | ✅ | **The 38.3M student beats the 86.6M pipeline by 3.76 points.** Same 30% validation split (3,322 photos, seed 0), same code, each arm with its own `T` and `beta`. ViT-B: ceiling 94.52, vision-only 72.94, Strategy I **90.04**, using 95.3% of its headroom. TinyCLIP-39M: ceiling 97.14, vision-only 81.10, Strategy I **93.80**, using 96.6% of its headroom. The win is not only a higher ceiling: vision-only improved 8.16 points and the ranker converts more of what is reachable. Reproduction note: the original run recorded 88.29 and the JS harness recorded 89, against 90.04 here after rebuilding the counts and status files. Vision-only and the ceiling match the original EXACTLY, so the candidates and split are identical and the spread is implementation noise. |
| F15 | Check whether BirdLife status still does anything | `fit_occurrence.py` fits `w[status]` as a smoothing prior, so it LOOKS like BirdLife data is in the shipped score | ✅ | **It is mathematically inert in both arms.** The prior is `(count + alpha * exp(w[status])) / (total + alpha * sum)`, and alpha fits to 1.6e-10 for ViT-B and 3.1e-10 for TinyCLIP. At that magnitude the status term sits about ten orders of magnitude below the counts, so both arms are counts-only in practice. The fitted `w` values are therefore meaningless and differ wildly between arms (`out-of-range` -8.98 against -5.79) with no effect on the result. `I_occurrence_SHIPPING` in [`pipeline-experiment.mjs`](../scripts/pipeline-experiment.mjs) reads only the occurrence blob and never looks up range status at all. This confirms the [standing rule](#standing-rules) not to ship BirdLife data. |
| F9 | Retrain at full scale without aug light | Only if F8 misses the ship bar. Tests the [C7](#phase-c-recipe-search-on-vit-b) suspect directly. It changes ONE variable against F7 | ⬜ | Not started, and deliberately conditional: it costs ~29 h for the student, plus ~62 GPU-h if the ViT-B teacher is retrained too. If F8 clears 86.41 this stays unrun and the question stays open.[^augscale] |

## Phase G: Ship

No item here blocks the work today. But the runtime decision controls the export
format. We selected the format before the target runtime, which is the wrong order.

**Decided: ship worldwide, occurrence data only, in one blob.** A regional bundle
saves only ~0.4 MiB. It also adds region detection and travel fallback logic. One
binary, cut on the client, keeps the file count low. Cloudflare Pages permits
20,000 files, and 4x4 tiling needs 14,721 of them.

| ID | Title | Description | ● | Findings |
|----|-------|-------------|---|----------|
| G1 | Choose the on-device runtime | onnxruntime-web, transformers.js, WebGPU, or Core ML. Each wants a different artifact | ✅ | **onnxruntime-web with int8, and WASM is the default provider, not WebGPU.** Measured in headless Edge on the real served assets: WASM session setup 192 ms and 318 ms/image steady state, against WebGPU 1753 ms setup and 516 ms/image. WebGPU loses because dispatch, buffer upload and readback overhead exceed the compute for a model this small. Independently corroborated: sitepoint benchmarks from February 2026 and transformers.js issue 955 both report WASM beating WebGPU on small models. The client still lists webgpu first in `bird-id-local.ts`, which is now wrong and needs to follow this row. Core ML remains the separate iOS path, see [G18](#phase-g-ship). |
| G11 | Understand the web runtime stack | ONNX, WebGPU and WASM are often treated as alternatives. They are not | ✅ | **They are different layers, and you need all three.** ONNX is the model FORMAT. `onnxruntime-web` is the RUNTIME that reads it. WebGPU and WASM are EXECUTION PROVIDERS inside that runtime, selected at session creation. One `.onnx` file serves both: try `executionProviders: [webgpu]` and fall back to `[wasm]` when the browser lacks WebGPU. WebGPU runs on the GPU and is much faster, while WASM is the universal CPU fallback and is roughly 5x slower in published comparisons. So this is a code-level choice, not a second artifact. |
| G12 | Split the int8 tower across files | The int8 tower is 37.7 MiB, over the 25 MiB per-file cap, so shipping it needs ONNX external data | ✅ | **Solved with ONE data file, so the loader needs no manifest.** `onnx.save_model` with `all_tensors_to_one_file=True` gives a 13.72 MiB graph plus a 24.00 MiB `wingclip_visual_int8.data`, both under the cap, and the `location` string is the single stable name we choose. **`size_threshold` must stay above zero.** At zero every tensor moves out, including the small shape constants, and the load fails with "Cannot parse data from external tensors" on the `patch_embed` Slice. 1 MiB keeps constants inline. Sharding per initialiser also works and yields 24 files of about 1 MiB, but each `location` is a fresh UUID that changes on every export, so a hardcoded loader breaks. Verified by reloading the split model in onnxruntime and running it, not by inspection. ⚠️ **Margin is 1.00 MiB.** The data blob lands on exactly 24.00 MiB because ONNX pads to whole MiB, so about 1 MiB of weight growth tips it over and forces the sharded path. |
| G21 | Replace the GPT-only UX signals in the app | `AddPhotosFlow.tsx` branches on three things GPT returns and a classifier does not | ✅ | **Decided: keep the confidence gate, drop the other two.** (1) **No bird / not sure is SOLVED** by the abstention gate at threshold 0.5, which is 77% coverage at 96.02% accuracy on kept photos. Today the app infers this from an empty candidate list, which a classifier never returns, so the branch moves to a confidence test. (2) **`multipleBirds` is dropped.** Nothing in the classifier detects a second bird, and the user knows better than a threshold does. (3) **`cropBox` auto-preview is dropped.** No box comes out of a classifier, and the existing manual crop UX already covers it. ⚠️ **Prompt at most ONCE.** Confidence tracks species ambiguity, not framing (Pearson 0.051 against bird area), so a crop often does not raise it and a re-prompt loop is a real failure mode. After one crop attempt, show the ranked candidates with an honest low-confidence label and let the user pick or skip. |
| G19 | Retire the BirdLife half of `range-adjust.js` | The file is two modules wearing one name, and only half survives the cutover | ⬜ | **Blocked on the GPT cutover, not on us.** The GEOMETRY half is load-bearing and stays: `lonLatToEqualEarth`, `xyToCell`, `GRID_ORIGIN_*`, `GRID_CELL_SIZE`, `GRID_COLS/ROWS`. The occurrence blob is keyed by that exact Equal Earth grid, so `rank.ts` imports it and a naive lat/lon division mis-keys every lookup. The BIRDLIFE half dies: `presenceTrust`, `originTrust`, `seasonalTrust`, `adjustConfidence`, `parseCellBlob`, `NEAR_RANGE_TRUST`, `OUT_OF_RANGE_TRUST`, `latLonToCell`, `neighborCells`. Confirmed by grep that the new client path (`rank.ts`, `occurrence.ts`, `bird-id-local.ts`) references NONE of those, so the zombie code is inert rather than harmful. It cannot be deleted yet: `adjustConfidence` still has 16 references in `src/` and `range-filter.ts` still serves the live GPT path. After cutover, delete the trust half and move the projection math to its own module, since naming coordinate code after a data source we no longer ship is how this confusion started. |
| G18 | Ship the iOS Core ML path | The web path is settled. iOS converts from torch directly, skips ONNX, and has no 25 MiB per-file cap | ⬜ | **Not started.** Expected to be the easy runtime: no cap, so the classifier can stay fp16 or fp32, and Core ML takes fp16 natively where the ONNX converter fails. ⚠️ **The real risk is preprocessing, not conversion.** The web client had THREE separate off-by-one bugs against PIL, each shifting the crop by one pixel while every dimension still looked correct: resize floors, CenterCrop rounds, and Python round() is banker rounding. Worst tensor error was 2.596 before the fixes and 3.0e-2 after. `VNImageRequestHandler` and `CIImage` resizing have their OWN resampling behaviour, so none of that work transfers. Reuse the harness: dump reference tensors from PIL, compare on device, and gate on EMBEDDING cosine above 0.999 rather than on tensor equality. |
| G17 | Measure quantisation on the TEXT CLASSIFIER | [F1](#phase-f-shrink-the-model-to-clear-the-size-gate) and [F10](#phase-f-shrink-the-model-to-clear-the-size-gate) both measured the VISUAL TOWER only. The classifier was never in scope, and fp16 was chosen under size pressure rather than on evidence | ✅ | **int8 per-row clears the gate and cuts the download to 51.3 MiB.** Real top-1 over all 24,633 NABirds images: fp32 32.72 MiB **86.91**, fp16 16.36 MiB **86.91**, int8-global 8.18 MiB **86.88**, int8-perrow 8.22 MiB **86.96**. Per-row beats a single global scale on agreement with fp32, 99.75% against 99.46%, for 44 KB of extra scales, because one global scale has to cover 11,167 unrelated species embeddings. int8-perrow scoring 0.05 above fp32 is noise, not a gain. The real finding is that quantisation costs nothing measurable here. That is expected, since rows are L2-normalised so values are bounded and there are no activation outliers. **fp16 is confirmed exactly free**, so yesterday's choice was right but under-verified: it rested on agreement across 24 photos rather than accuracy. Client total goes 59.5 to **51.3 MiB**: 13.72 graph, 24.00 weights, 8.22 classifier, 5.41 prior. Embeddings come from the fp32 tower once and are reused for every variant, so the comparison isolates the classifier. |
| G14 | Fold the text classifier into the ONNX graph | The client multiplies a constant 11167x768 matrix in scalar JS, and the cost on a phone was unmeasured | ❌ | **Rejected after measuring.** On a Cortex-A76, a fair mid-range phone proxy: naive loop 23.51 ms, 4-way unrolled 16.22 ms, full sort 5.90 ms, partial top-K 0.16 ms. Against 318 ms/image for the tower on WASM, the whole selection step was **29 ms, about 8% of inference**. Folding the matmul into the graph saves roughly 13 ms and costs the 25 MiB per-file fight plus sharding, because the classifier adds about 16 MiB to a `.data` file already at 24.00 MiB. Took the two local wins instead: partial top-K and a 4-way unrolled dot product, together 29.41 to 16.38 ms. Verified bit-identical, max difference **0.000e+0** with identical candidate sets and order across 24 photos, since unrolling changes floating-point associativity and can reorder candidates within an ulp. |
| G15 | Decide where the Bayesian rerank runs | Server-side reranking lets calibration change without a client redownload | ❌ | **Rejected. Client keeps everything.** The work being offloaded is 29 ms, so the trade is 29 ms against losing offline support. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) also make the free plan impossible: **CPU is capped at 10 ms per request**, which the matmul alone exceeds, so this needs Workers Paid. Note that G14 and G15 pull against each other: folding the classifier into the graph leaves it on the client, so server-side reranking then moves only the 5.41 MiB prior, paying the full offline cost to save 9% of the download. The coherent server design was tower-only client at 37.72 MiB with the classifier server-side, and the measurement removes the reason to want it. Total client download stays **59.5 MiB**, one time and cacheable, replacing a photo upload per identification. |
| G20 | Fit the absent-species floor instead of hardcoding it | A candidate with no record in the cell gets a hardcoded constant, and the reference and the client disagree on its value | ⚠️ | **Real inconsistency, but it costs nothing measurable, so it is cleanup rather than a blocker.** `rank.ts` uses `log(1e-9)` = -20.72 while `fit_occurrence.py` effectively uses its clamp at `log(1e-12)` = -27.63, so `T` and `beta` were fitted against a harsher absence penalty than the client applies. Tested directly against [G16](#phase-g-ship): floor pinned at -27.63, pinned at the client -20.72, and fitted freely all score **exactly 95.00%**. The fitted value lands near -28.8, and `beta` simply rescales to compensate, 0.700 against 0.721. Fitting the floor on the pooled prior is worth +0.03, which is one photo. An earlier claim that a monthly prior makes the floor a main term is **wrong**: about 90% of slots hit the floor and it still does not matter, because it applies near-uniformly across candidates and cancels in the ranking. Still worth unifying so the reference and the artifact stop disagreeing. |
| G16 | Add month to the occurrence prior | The prior was P(species\|cell) with no time dimension, so a Rufous Hummingbird in Seattle got the same score in July and January | ✅ | **Month is worth +1.2 points. 93.8 to 95.0 absolute top-1**, paired bootstrap 95% CI [+0.81, +1.69], so the interval excludes zero. Built from the same full corpus: 157,114,209 observations to 54,665,804 (species, cell, month) triples in one DuckDB pass, and the pooled pairs reproduce exactly at 26,396,702. **The final form is simply `P(s\|c,m) = n_scm / n_cm`**, that species' share of all sightings in that cell that month. A backoff term `k` toward the pooled prior was swept and **fits to zero**: k=0 has the lowest training AND validation cross-entropy, so thin cell-months need no shrinkage at all. That contradicts the sparsity worry raised before the build. An apparent k=1 optimum at 95.00 against 94.97 was **one photo out of 3,322**, with a bootstrap CI of [+0.00, +0.09] spanning zero, so it was noise and is not used. Sparsity is visible but harmless: 9.4% of candidate slots carry a monthly count against 13.3% pooled. |
| G13 | Export the shipping student to ONNX | Any web runtime needs this, and int8 was chosen on the PyTorch artifact in [F10](#phase-f-shrink-the-model-to-clear-the-size-gate), so the export itself has to be proven neutral before that transfers. Core ML converts from torch directly and skips ONNX entirely | ✅ | `wise_a0.60.pt` from `runs/ft_tiny39_fresh` exports clean: worst cosine(pytorch, onnx) **1.00000000**, worst absolute difference **7.34e-07**, **0/16** top-1 disagreements. The script exits non-zero on mismatch, so it cannot pass silently. Artifacts: `onnx_tiny39/wingclip_visual_fp32.onnx` and `text_classifier.npy` at (11167, 768). Parameter counts reconcile: 38.33M visual plus 0.39M projection is 38.72M, and the 38.3M quoted elsewhere is the backbone only. **fp16 export is broken**: `convert_float_to_float16` emits Cast nodes whose declared output type does not match the consumer, so onnxruntime rejects the graph at load. That blocked nothing in the end, because fp16 was only wanted for WebGPU and [G1](#phase-g-ship) selects WASM with int8. fp16 now matters only to Core ML, which converts from torch. |
| G3 | Measure CPU latency | Decides whether WASM/CPU is a real target or only a fallback | ✅ | int8 at 4 threads = 143.6 ms, ~1.7x faster than fp32. Imperceptible beside the network round-trip it replaces, so CPU is a viable target. |
| G4 | Clear the license gate | The app is public, so weights, corpus and derived artifacts all need clean licenses | ✅ | LAION ViT-B and TinyCLIP are both clean. Apple MobileCLIP weights are research-only, which is why [F3](#phase-f-shrink-the-model-to-clear-the-size-gate) rejected them. |
| G5 | Ship one artifact per runtime | Same weights, different precision per platform. The web rule is 25 MiB per FILE, so the question is how many files, not how many MB | ✅ | **iOS: int8, 86.82 top-1, no size constraint.** **Web: two options, both legal.** (a) int8 tower 38.9 MB EXCEEDS the per-file cap, so it needs ONNX external data to split across two files of about 20 and 19 MB, and keeps 86.82. (b) int4 block 32 tower is 21.9 MB in ONE file and costs 2.30 points, landing at 84.61. Either way the text classifier ships as its own 8.6 MB asset. **Decision: option (a).** [G12](#phase-g-ship) proved the split works with one data file and no manifest, so the extra load step is a single `externalData` entry and int4 is not needed on web. |
| G6 | Replace GPT bird detection and framing | GPT returns `birdCenter`, `birdSize` and `multipleBirds`. A pure classifier returns none of these | ✅ | **Split the question and most of it disappears.** DETECTION is handled: the abstention gate answers "is there confidently a bird" at 2.4% false-accept on Imagenette negatives against 88.4% of real birds passing. FRAMING is not, and cannot be, from this model: confidence against relative bird area is Pearson 0.051 and Spearman 0.032, so low confidence means species ambiguity rather than a badly framed shot. The earlier "low confidence means crop" framing was design intent, never validated, and is disproven for the range NABirds covers. COUNTING is also unavailable. Resolution per [G21](#phase-g-ship): ship detection through the gate, drop counting and auto-framing on web, and revisit iOS Vision animal detection for boxes and count on the Core ML path in [G18](#phase-g-ship), where it is free. |
| G7 | Ship the range data offline | On-device ID is pointless if the ranker still needs a network call for geography | ✅ | Ship the 5.41 MiB occurrence blob, not the 260 MiB BirdLife store. Lookup is a grid index plus a vector op on the 27 km Equal Earth grid (1276x618). |
| G8 | Refresh the occurrence prior | The prior goes stale as bird distributions shift | ✅ | Quarterly. E6 measured 2.88 pts lost over 2 years, and freshness matters ~2.4x more than data volume. Version-stamp the blob filename and add an immutable Cache-Control entry. |
| G9 | Prove the adaptive router in a browser | One pipeline, swappable front end: on-device model when cached, hosted VLM otherwise | ⚠️ | **Superseded, and `ml/demo/` is deleted.** It loaded BioCLIP-2 ViT-L int8 (307 MB) via onnxruntime-web with a WASM fallback. Verified by `validate_node.js`: int8 ONNX loads, embeddings are faithful, raw 74/83 pre-range matches PyTorch, CPU ~335 ms/img. Both open questions are now answered by the real client rather than the demo: [G1](#phase-g-ship) measured WASM at 318 ms/image against WebGPU 1753 ms setup, and the shipping payload is 61.66 MiB behind an explicit gate with persistent caching. |

---

## Follow-ups after the cutover

Recorded so they do not become folklore.

**iOS must make the same move, and it is the reason the API deletion is safe
only for now.** `ios/WingDex/Services/DataService.swift` calls
`POST /api/identify-bird` and `AddPhotosViewModel` calls it twice. That endpoint
is deleted in this branch, so iOS 0.7.3 on TestFlight loses identification the
moment this merges and deploys. That is acceptable ONLY because TestFlight has
two users, both the maintainer. iOS needs the same port the web client just got:
Core ML inference, the confidence gate, and the geo/month prior, after which the
shared `openapi.yaml` contract is consistent again. Until then, treat a merge as
breaking the iOS ID flow.

**Core ML conversion does NOT need a Mac.** `coremltools` publishes Linux wheels
(`manylinux1_x86_64` on PyPI), so `torch` to `.mlpackage` runs on the training
box like every other export. macOS is needed only to RUN prediction for
verification, and Xcode to build the app. Given that [G18](#phase-g-ship) names
preprocessing as the real risk rather than conversion, that verification step is
the part that actually needs Apple hardware: the web client hit three separate
off-by-one bugs against PIL, each shifting the crop one pixel while every
dimension still looked correct.

**Weights are not in the repo, and should not be.** `ml/distill/runs/` is 52 GB
of checkpoints and stays untracked. What ships is the derived inference
artifacts: `wingclip_visual_int8.onnx`, its `.data` sidecar, and
`text_classifier_int8.bin`. Publishing `WingCLIP-0.3` to Hugging Face is worth
doing on its own merits, since it beats BioCLIP-2 on NABirds at 11x fewer
parameters, but it is a release task and not a precondition for shipping.

**`range-adjust.js` is now `src/lib/equal-earth.ts`.** It was JavaScript under
`functions/` because Node build scripts imported it directly and there is no
`allowJs`. Those scripts were BirdLife-era and are deleted, so the only
consumers are `src/lib/rank.ts` and `src/lib/occurrence.ts`: it is client
geometry, not a server range filter. Typing it caught a latent contract the
untyped file hid, `xyToCell` returns null outside the grid.
## Fixtures and reproduction

Parity fixtures are generated artifacts and are gitignored. A fresh clone cannot
run the parity harnesses until they are rebuilt. That was already true for the
two sets behind the shipping numbers, `fixtures-tiny39-a060` and
`fixtures-calib11k` at 11,070 files each; the four obsolete 27-file sets used to
be committed, which meant the repo tracked the fixtures that did not matter and
ignored the ones that did.

Every harness takes the fixture directory as an argument, so no path is baked in:

```bash
node --experimental-strip-types ml/parity/jobs/rank_parity.ts \
  . ml/fixtures-tiny39-a060 ml/truth-tiny39.json \
  ml/distill/calibration_month_tiny39.json
```

The scratch directory `ml/spike/` was deleted. It held the exploratory scripts
from the first quantisation and ranking passes, superseded by `ml/distill/jobs/`
and `ml/parity/jobs/`, and nothing imported it.
## Next: getting to a PR preview deploy

Steps 1 to 5 are done. What ships today, 61.66 MiB total, every file inside the
25 MiB Workers per-file cap:

| asset | size |
|---|---|
| `wingclip_visual_int8.onnx` | 13.72 MiB |
| `wingclip_visual_int8.data` | 24.00 MiB |
| `text_classifier_int8.bin` | 8.22 MiB |
| `occurrence.1fb61779.bin.gz` | 15.71 MiB |

The prior is named by CONTENT HASH, not schema version, because `_headers`
serves these immutable for a year, and a fixed name hands a stale blob to
every existing user after a rebuild.

**Done:** month-aware prior wired end to end at 95.0% through the TypeScript
client, WASM as the default execution provider, the three GPT-only UX branches
replaced by the post-rerank confidence gate, cache-first asset loading behind an
explicit download screen, and the hard swap to on-device inference with no GPT
fallback.

**What is left before merge:**

**1. Open the PR and deploy the preview.** CI builds a per-PR aliased preview at
`pr-<N>-wingdex-app-preview.<subdomain>.workers.dev`.

**2. Try it on real photos.** Everything so far is verified in Node or headless
Edge against local files. It has never seen a real upload, a real EXIF payload,
or a phone. That is the gap the preview exists to close.

**3. Delete the GPT server path.** `functions/lib/bird-id.ts` and its prompt
still exist and are now unreachable from the app. Removing them also unblocks
[G19](#phase-g-ship), since `range-filter.ts` is what keeps the BirdLife trust
code alive.

**Not blocking:** [G18](#phase-g-ship) Core ML for iOS, and [G20](#phase-g-ship)
unifying the absence floor, which is measured at zero cost.

## Experiment register

Every training run, from the checkpoint `args` and not from prose. Smoke tests and
gate runs are in [Appendix F](#appendix-f-smoke-and-gate-runs).

**best** is the epoch of the best val_cos. When **best** equals **ep**, the run stopped
at its budget and not at a plateau. That run can improve with more epochs.

⚠️ **Do NOT compare val_cos across these tables.** val_cos measures agreement
with the teacher on that run's own validation split. The runs use different
species counts, different teachers and different data, so the values sit on
different scales. A 500-species pilot at 0.9560 and a 7,555-species run at 0.9618
are two different measurements, not a ranking. Compare val_cos only inside one
group, and use NABirds for any decision.

### ViT-B pilot sweep, 500 species (Phase C)

| run | ep | best | lr | wd | aug | val_cos | note |
|---|---|---|---|---|---|---|---|
| `exp1_baseline_oldrecipe_ep15` | 15 | 12 | 1e-4 | 0.1 | none | 0.9447 | foundation check |
| `exp2_newrecipe_ep15` | 15 | 12 | 1e-4 | 0.2 | none | 0.9464 | recipe bundle, +0.0016 |
| `exp3_newrecipe_auglight_ep15` | 15 | **15** | 1e-4 | 0.2 | light | 0.9512 | aug, +0.0048 |
| `exp4_lr1e4_ep8` | 8 | **8** | 1e-4 | 0.2 | none | 0.9463 | LR control |
| `exp5_lr7e5_ep8` | 8 | **8** | 7e-5 | 0.2 | none | 0.9483 | LR winner |
| `exp6_lr5e5_ep8` | 8 | **8** | 5e-5 | 0.2 | none | 0.9475 | |
| `exp7_combined_lr7e5_auglight_ep25` | 25 | **25** | 7e-5 | 0.2 | light | **0.9540** | the locked recipe |
| `exp8_locked_ep40` | 40 | 38 | 1e-4 | 0.2 | light | 0.9503 | plateaued, but lr differs from exp7 |
| `exp9_strongaug_mv5_ep25` | 25 | **25** | 7e-5 | 0.2 | strong | 0.9434 | 5-view cache, rejected |

### TinyCLIP pilot sweep, 500 species (Phase F)

| run | ep | best | lr | wd | aug | teacher | val_cos |
|---|---|---|---|---|---|---|---|
| `tiny39_lr5e4` | 20 | **20** | 5e-4 | 0.1 | none | WingCLIP | 0.8837 |
| `tiny39_lr25e5` | 20 | **20** | 2.5e-4 | 0.1 | none | WingCLIP | 0.8917 |
| `tiny61_r01` | 20 | 14 | 1e-4 | 0.1 | none | WingCLIP | 0.9047 |
| `tiny39_bioclip_teacher` | 20 | 15 | 1e-4 | 0.1 | none | BioCLIP-2 | 0.9423 |
| `tiny39_r01` | 20 | 16 | 1e-4 | 0.1 | none | WingCLIP | 0.9438 |
| `tiny39_r02_lr3e5` | 25 | **25** | 3e-5 | 0.2 | light | WingCLIP | 0.9546 |
| `tiny39_r02` | 25 | **25** | 7e-5 | 0.2 | light | WingCLIP | 0.9560 |
| `tiny39_r02_lr5e5` | 25 | **25** | 5e-5 | 0.2 | light | WingCLIP | **0.9563** |

⚠️ **`tiny61_r01` is not a capacity test.** It uses
`vit_betwixt_patch32_clip_224`, which is patch32 and gives 49 tokens. The 39M model is
patch16 and gives 196 tokens. See [Appendix C](#appendix-c-rejected-and-confounded-experiments).

⚠️ **The 0.2-basis LR sweep is a three-way tie.** 5e-5 (0.9563), 7e-5 (0.9560) and
3e-5 (0.9546) are within 0.0017. All three stopped at their budget. We kept 7e-5.

### NABirds-401 pilot, teacher decision (Phase F)

| run | ep | best | lr | bs | teacher | val_cos | NABirds top-1 |
|---|---|---|---|---|---|---|---|
| `nb401_teach_bioclip` | 25 | **25** | 7e-5 | 96 | BioCLIP-2 | 0.9616 | 83.44 |
| `nb401_teach_wingclip` | 25 | 24 | 7e-5 | 96 | WingCLIP-0.1 | 0.9612 | **89.09** |
| `nb401_batch128` | 25 | **25** | 8.1e-5 | 128 | WingCLIP-0.1 | 0.9614 | eval failed, see F5 |

⚠️ **This is the clearest case against val_cos.** BioCLIP-2 scores higher on val_cos
(0.9616 against 0.9612) and loses NABirds by 5.65 points.

### Full corpus, 7,555 species

| run | arch | ep | best | lr | wd | aug | teacher | val_cos | NABirds |
|---|---|---|---|---|---|---|---|---|---|
| `full7555_vitb` | ViT-B-16 | 20 | **20** | 1e-4 | 0.1 | none | BioCLIP-2 | **0.9650** | 81.83 |
| `full7555_locked_ep25` | ViT-B-16 | 25 | **25** | 7e-5 | 0.2 | light | BioCLIP-2 | 0.9618 | 78.4 |
| `full7555_tiny39` | TinyCLIP-39M | 25 | running | 8.1e-5 | 0.2 | light | WingCLIP-0.1 | running | pending |

### Ground-truth fine-tunes

| run | base | ep | best | lr | set |
|---|---|---|---|---|---|
| `ft_full7555_gt` | 0.1-alpha | 12 | 11 | 1e-5 | dirty, 5,908 species |
| `ft_clean_01` | 0.1-alpha | 12 | 11 | 1e-5 | **clean, 3,850 species** |
| `ft_clean_02` | 0.2-alpha | 12 | **12** | 1e-5 | clean, 3,850 species |

---

## Eval methodology

Read this before you use any number in this file. Each trap below gave a wrong
result that looked correct.

**Always give `--pilot-species 0`.** The default is 500. On the old global-ranked
pilot, that setting scored **7 species** but printed **"500 species"** in the
header. Every OOD number from that sweep was void. See [Appendix A](#appendix-a-the-7-species-trap).

**Read the weights, not `args`.** The `args` dict holds the flags from the command
that made the checkpoint. Nothing updates it later. `wise_a0.90.pt` shows
`alpha 0.5`, but the true blend is 0.90. `full7555_locked_ep25` shows
`pilot_species 500`, but it is a full run. The `--wds` path never calls
`pick_rows()`.

**Check the mtime of each output file.** A failed eval keeps the JSON file from the
last run. That file looks the same as a new one. An old file with the value 28.42
almost went into a report as a true result.

**Use one cache for each teacher.** The cache key is the image path only. The hit
test is `all(path in cached)`. A cache from a different teacher therefore starts a
silent recompute. It does not give an error. `runs/full7555_vitb/` holds a 282-row
cache from the void 7-species period. The correct cache has 24,633 rows.

**Do not use val_cos for a decision.** It gave the wrong answer three times. The three are the teacher choice ([F5](#phase-f-shrink-the-model-to-clear-the-size-gate)),
the batch-128 comparison, and the 0.2 recipe at
full scale (C6). Use NABirds to decide.

**Never compare a golden-set number with a large-set number.** The GPT-5.4-mini 83/87
baseline uses n=23 self-labelled images. One image moves the score by 4.3 points.
There is no GPT baseline at scale, and we do not plan one.

**Report ABSOLUTE accuracy, not conditional accuracy.** A conditional number counts
only the photos with the true species in the top-K. One such number appeared to go
above the recall ceiling.

**Compare retention against a COMMON teacher.** Measure a student from WingCLIP-0.1
against BioCLIP-2, and the number is true but the label is wrong.
`eval_nabirds.py` now writes `retention_vs_bioclip2_*` and
`retention_vs_teacher_*` separately.

---

## Reference

### Architecture

The student is a visual tower whose output is projected into BioCLIP-2's 768-d
embedding space and L2-normalized. `Student.forward()` IS the exportable graph.
Input resolution 224.

Classification uses zero-shot cosine similarity. It compares the student embedding
against an **11,167 × 768 matrix of BioCLIP-2 text embeddings**. The build computes
that matrix one time and ships it frozen. **The text encoder never runs on the
device.**

| component | shape | fp32 | int8 | int4 |
|---|---|---|---|---|
| ViT-B visual tower | 86.6M params | 346.3 MB | 87 MB | 43 MB |
| TinyCLIP-39M visual tower | 38.3M params | 153.3 MB | 38.3 MB | 19.2 MB |
| text classifier | 11,167 × 768 | 34.3 MB | 8.6 MB | 4.3 MB |
| occurrence prior blob | 99,900 cells | - | 5.4 MB gzipped | - |

All sizes above are `params x bits/8`, so they are calculated and not measured.
Only the ViT-B int4 ACCURACY cost of -0.88 points is measured. See F10.

**Payload against the 25 MB web gate**, TinyCLIP-39M:

| combination | total | gate |
|---|---|---|
| visual int4 + text int8 | 27.8 MB | over |
| visual int4 + text int4 | **23.5 MB** | clears |
| visual int8 + text int8 | 46.9 MB | over |

### Measured payload (2026-08-04)

All numbers below are MEASURED on the shipping artifact `wise_a0.60.pt` over all
24,633 NABirds images. Sizes include the fp16 scale metadata that block-wise
quantisation needs, which the earlier calculated figures left out.

**Visual tower**, 38,719,232 parameters:

| precision | top-1 | tower MB | vs fp32 | cos(fp32) | agree |
|---|---|---|---|---|---|
| fp32 | 86.91 | 155 | - | 1.000000 | 100.00% |
| **int8** | **86.82** | **38.9** | **-0.09** | 0.999923 | 99.27% |
| mixed ffn4/blk64 + sens8 | 85.19 | 27.0 | -1.73 | 0.987932 | 90.98% |
| mixed ffn4/blk32 + sens8 | 85.07 | 27.8 | -1.84 | 0.992209 | 92.36% |
| int4 block 32 | 84.61 | 21.9 | -2.30 | 0.988648 | 91.15% |
| int4 block 64 | 84.06 | 20.7 | -2.85 | 0.982274 | 88.99% |
| int4 block 128 | 81.50 | 20.1 | -5.41 | 0.974508 | 85.97% |

int8 keeps the embedding almost exactly. int4 at block 128 changes it: 0.974
cosine and only 86% top-1 agreement is a different model, not a noisier one.

**Text classifier**, 11,167 x 768 = 8,576,256 values. Accuracy cost UNMEASURED,
see [G10](#phase-g-ship):

| precision | MB |
|---|---|
| fp16 | 17.2 |
| int8 | 8.6 |
| int4 | 4.3 |

**Against the real web rule: 25 MiB PER FILE, not a total budget.**

Cloudflare Pages caps a single asset at 25 MiB and allows 20,000 files. Total
download is a UX concern, not a hard gate. iOS ships through the App Store and has
no such limit at all.

| asset | size | files needed |
|---|---|---|
| int8 tower | 38.9 MB | 2, needs ONNX external data |
| int4 block 32 tower | 21.9 MB | 1 |
| text classifier int8 | 8.6 MB | 1 |
| occurrence prior blob | 5.4 MB gzipped | 1 |

The text classifier is not part of the ONNX graph. It is a matrix used for a cosine
comparison AFTER inference, so it always ships as its own asset and never needed
quantising to fit.

**Two legal web options:**

| option | tower | top-1 | complexity |
|---|---|---|---|
| int8, split | 38.9 MB over 2 files | **86.82** | needs `externalData` wiring |
| int4 block 32 | 21.9 MB in 1 file | 84.61 | none |

Option (a) keeps the ship bar. Option (b) costs 2.30 points and misses it, but needs
no split. See [G5](#phase-g-ship) and [G12](#phase-g-ship).
### The ranker (Strategy I, the shipped math)

```
score(species) = sim/T + beta · log P(species|cell)
```

- `T` fitted **0.007809**. It moves with the joint fit, so always state which fit
  produced a number.
- `beta` fitted ~0.6-1.33 depending on the fit.
- Fitted params live in [`calibration_occ_01.json`](calibration_occ_01.json) and are specific to WingCLIP-0.1 @
  alpha=0.90. **A model swap REQUIRES a refit.** The current student uses
  [`calibration_occ_tiny39.json`](calibration_occ_tiny39.json) instead: T=0.00760, beta=0.563.
  See [F13](#phase-f-shrink-the-model-to-clear-the-size-gate).

`P(species|cell)` uses empirical iNat occurrence data. It comes from 157M
research-grade observations. These give 3,176,965 bird (species,cell) pairs over
99,900 cells. The grid is 27 km Equal Earth on the WGS84 ellipsoid. It matches
production `range-adjust.js` on 12 of 12 checks.

**Do NOT build the prior from `train_manifest.parquet`.** That file comes after the
floor and the cap. It therefore flattens the abundance ratios. Use the raw dump.

**Prior-dominance regimes**, tied to this fit's T:

| vision confidence | behavior |
|---|---|
| > 0.9 | prior is decorative. Skip the range lookup on ~34% of traffic. |
| 0.6-0.9 | normal collaboration. |
| < 0.6 | prior flips 40-70% of answers. Change the wording. Mark life-list entries as a guess. |

### Abstention

Ship the confidence gate at threshold 0.5. We do not need a separate bird detector
for the "is this a bird" question. Measured on `WingCLIP-0.3`, all 24,633 NABirds
images:

| threshold | coverage | accuracy on kept |
|---|---|---|
| 0.0 | 100.0% | 86.90% |
| 0.3 | 91.7% | 91.39% |
| **0.5** | **77.0%** | **96.02%** |
| 0.7 | 50.4% | 98.27% |
| 0.9 | 2.4% | 99.34% |

At 0.5 the gate keeps 77% of photos and is 96% correct on them, up from 86.90%
ungated. Only 2.4% of non-bird photos pass, against 88.4% of real birds.

**Those numbers are PRE-rerank.** `eval_nabirds.py` computes
`softmax(sims * 100).max()` on raw vision-to-text similarity, with no geographic
prior, no month, and no fitted `T` or `beta`. The shipping pipeline reranks, so
its final confidences are much sharper. Measured on the 3,322-photo validation
split:

| threshold | vision-only coverage / acc | post-rerank coverage / acc |
|---|---|---|
| 0.0 | 100.0% / 81.10% | 100.0% / 94.88% |
| 0.5 | 71.4% / 94.43% | 97.8% / 96.67% |
| **0.7** | 52.1% / 97.81% | **94.9% / 97.91%** |
| 0.9 | 22.1% / 99.59% | 90.2% / 98.77% |

**Ship the gate on the post-rerank score at threshold 0.7.** That keeps 94.9% of
photos at 97.91% accuracy, so the app prompts on about 5% of uploads rather than
the 23% to 29% the pre-rerank numbers implied. The prior collapses genuine
ambiguity: two similar sparrows can split vision confidence evenly, and if only
one occurs in that cell that month the reranked distribution is decisive.

⚠️ **The post-rerank gate trusts the prior.** For a genuine vagrant the
model is confidently WRONG, which is exactly when an honest low-confidence answer
matters most. Rare by definition, but it is the failure mode to watch.

**Remaining caveats.**
- **Coverage 77% means 23% of photos fall BELOW the threshold**, not that 23% are
  rejected. Those are the photos to prompt on. And 23% is measured on NABirds,
  which is entirely birds. Real uploads include non-birds, where the gate does
  more work.
- **The gate is not a framing detector.** Top-1 confidence against relative bird
  area is Pearson 0.051, Spearman 0.032. Low confidence means species ambiguity,
  such as two similar sparrows, NOT that the bird is small or badly framed. So
  "crop and retry" helps in some of that 23% and not in the rest.

Negatives were measured on Imagenette, which has EASY negatives, so 2.4% is a
floor value rather than a guarantee.

### Model registry

| name | what | run | result |
|---|---|---|---|
| `WingCLIP-0.1-alpha` | full ViT-B distill, 0.1 recipe | `full7555_vitb` | val_cos 0.9650 · NABirds 81.83 |
| `WingCLIP-0.1-beta` | 0.1-alpha + ground-truth fine-tune | `ft_clean_01` | GT-val 77.61 |
| **`WingCLIP-0.1`** | **0.1-beta + WiSE-FT alpha 0.90** | `ft_clean_01` | **NABirds 89.93** |
| `WingCLIP-0.2-alpha` | full ViT-B distill, 0.2 recipe | `full7555_locked_ep25` | NABirds 78.4 · retired, see C6 |
| `WingCLIP-0.3-alpha` | full TinyCLIP-39M distill | `full7555_tiny39` | val_cos 0.9436 |
| `WingCLIP-0.3-beta` | 0.3-alpha + ground-truth fine-tune on fresh photos | `ft_tiny39_fresh` | see the alpha sweep |
| **`WingCLIP-0.3`** | **0.3-beta + WiSE-FT alpha 0.60. THIS IS WHAT SHIPS.** | `ft_tiny39_fresh/wise_a0.60.pt` | **NABirds 86.90**, beating teacher BioCLIP-2 at 86.41, at 38.3M params against 86.6M |

### Measured results

**The chain:** 81.83 distill → 77.61 in-dist after fine-tune → **89.93 NABirds** at
WiSE-FT alpha 0.90. Teacher BioCLIP-2 = 86.41.

**Alpha sweep**, clean set, both bases, peak at 0.90 on both:

```
base 01:  0.25→85.86  0.50→88.42  0.75→89.69  0.90→89.93  1.00→89.77
base 02:  0.25→83.20  0.50→86.40  0.75→88.19  0.90→88.46  1.00→88.26
```

**Reranking**, ABSOLUTE top-1 on the 30% validation split (3,322 photos, seed 0).
That split is a subset of the 11,070 calibration photos, not a separate dataset.
Each model uses its OWN fitted `T` and `beta`, because `T` sets the scale on which
similarity trades against the prior:

| strategy | ViT-B 86.6M | TinyCLIP 38.3M |
|---|---|---|
| recall ceiling | 94.52 | **97.14** |
| raw argmax, vision only | 72.94 | **81.10** |
| **I: log-sum + iNat occurrence** | **90.04** | **93.80** |
| headroom used | 95.3% | **96.6%** |

**Recall ceiling** is the fraction of photos whose true species appears anywhere in
the 25 candidates. The reranker only reorders that list, so the ceiling is the best
score it can reach. Read the two models by HEADROOM USED, not by raw top-1, since
they have different ceilings.

Historical rows for ViT-B, from the 2026-07-30 run: F gated tiering 79.53,
H log-sum + BirdLife 81.87, I 88.29. That 88.29 rebuilds to 90.04 today, and the
JS harness measured 89 at the time. Vision-only and the ceiling reproduce exactly,
so the candidates and the split are identical and the spread is implementation
noise. See [F14](#phase-f-shrink-the-model-to-clear-the-size-gate).

**Quantization**, NABirds, all 24,633 images:

| variant | ~MB | top-1 | Δ |
|---|---|---|---|
| fp32 | 346 | 89.94 | - |
| fp16 | 173 | 89.94 | +0.00 |
| int8 | 87 | 89.89 | −0.05 |
| int4-blk128 | 43 | 89.06 | −0.88 |
| int3-blk128 | 32 | 0.00 | −89.95 |

**Method lesson.** This error cost more time than any other in the project. To find
the cost of a precision level, fake-quantize the weights in torch. Then run the
normal eval. Each variant needs approximately 6 s. Use ONNX only when the artifact
itself is the deliverable. The ONNX work gave two wrong numbers.

### Cosine vs retention: the mental model

val_cos shows how closely the student copies the embedding of the teacher. It uses
data that is similar to the training set. Retention shows how much of the ACCURACY
of the teacher the student keeps on a different task. These are two different
measurements. A student can increase one and decrease the other. Retention above
100% is normal after a ground-truth fine-tune. The fine-tune adds knowledge that
the teacher never had.

### CPU latency

Measured on Ryzen/WSL under contention, so optimiztic for a phone:

| threads | fp32 | int8 |
|---|---|---|
| 1 | 612.2 ms | 472.2 ms |
| 2 | 388.1 ms | 245.4 ms |
| 4 | 247.5 ms | 143.6 ms |

int8 is ~1.7x faster than fp32 on CPU. onnxruntime's CUDA provider does NOT
accelerate dynamically-quantized weights, so this measures the format that we
ship.

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
payload   per record: varint(delta of sorted species index) + 1B quantized logprob
```

The key for each species is a 2-byte taxonomy index. It is smaller than the 8-byte
eBird code: 9.1 MiB against 27.3 MiB raw. The client computes `log(p) = -q / 2.5`.
The sentinel row keeps the cell length at `index[i+1].offset - index[i].offset`.

**Keep the sparse cells.** Cells with less than 10 observations are 47.5% of all
cells. They hold only 4.0% of all pairs. To remove them saves almost nothing, and
it adds a fallback path.

### Papers we actually use

- **WiSE-FT** ([Wortsman et al., CVPR 2022](https://arxiv.org/abs/2109.01903)) is the handbook for [D4](#phase-d-beat-the-teacher). A fine-tune
  decreases out-of-distribution accuracy. An interpolation back toward the
  pre-finetune weights recovers it. Our optimum is 0.90, and theirs is ~0.5. The
  reason is that our fine-tune is gentle. It moves only 4.7% of the weights, mostly
  in the projection and the last blocks. A stronger fine-tune moves alpha DOWN.
- **MobileCLIP2** ([arXiv 2508.20691](https://arxiv.org/abs/2508.20691)) gave us the [C2](#phase-c-recipe-search-on-vit-b) recipe bundle. Their dataset-reinforcement method
  stores several augmented-view embeddings for each image. C4 tested that method
  and rejected it.
- **TinyCLIP** ([Wu et al., ICCV 2023](https://openaccess.thecvf.com/content/ICCV2023/papers/Wu_TinyCLIP_CLIP_Distillation_via_Affinity_Mimicking_and_Weight_Inheritance_ICCV_2023_paper.pdf)) supplied the [F3](#phase-f-shrink-the-model-to-clear-the-size-gate) backbone. See [Appendix B](#appendix-b-tinyclip-paper-notes).

### Pipeline scripts

Run in order from `ml/distill/`:

| script | job |
|---|---|
| [`select_species.py`](select_species.py) | species list from iNat taxonomy |
| [`pull_images.py`](pull_images.py) | download the corpus |
| [`pack_webdataset.py`](pack_webdataset.py) | pack shards for training |
| [`precompute_embeddings.py`](precompute_embeddings.py) | cache teacher targets |
| [`train_student.py`](train_student.py) | distillation |
| [`finetune_groundtruth.py`](finetune_groundtruth.py) | ground-truth fine-tune + WiSE-FT merge |
| [`eval_nabirds.py`](eval_nabirds.py) | the deciding OOD eval |
| [`fit_occurrence.py`](fit_occurrence.py) | fit T and beta |
| [`build_prior_blob.py`](build_prior_blob.py) | build the shippable occurrence blob |
| [`jobs/full_run.sh`](jobs/full_run.sh) | the full 3-step distill run |
| [`jobs/phase2.sh`](jobs/phase2.sh) | unattended fine-tune + alpha sweep |

**The shards contain the teacher targets.** `pack_webdataset.py` wrote the BioCLIP-2
target into each shard. A `--wds` run with a NEW teacher therefore trains against
the OLD target, with no warning. Give `--sv-embeddings <dir>` to replace the
target. Then find `TEACHER OVERRIDE` in the log before you use the result.

---

## Appendix A: The 7-species trap

The pilot used **the top-500 species by GLOBAL iNat photo count**. That is a
worldwide list. It contains Greater Rhea, Hawaiian Duck and Swan Goose.
**NABirds is North American.** The two sets share exactly **7 species**: Rufous
Hummingbird, Nuttall's Woodpecker, Yellow-billed Magpie, Oak Titmouse, Juniper
Titmouse, California Thrasher, and Abert's Towhee.

So `eval_nabirds.py --pilot-species 500` scored 282 images from 7 species. It printed
"500 species". The Wilson CIs beside those numbers are also too narrow. They assume
282 independent samples, but the data has only 7 clusters. The same fault applies
to the sweep of 2026-07-25.

**Why we did not see it.** Those 7 species are at the top of the global count list.
Baeolophus ridgwayi has 499 images, and Melozone aberti has 496. They enter a
top-500 list normally. Nothing gave an error. The eval measured a very small
subset, with no warning.

**Correction.** Align the pilot species set TO the eval. The corpus holds all 401
NABirds taxa, with 184,958 images. `wds-nabirds401` keeps the pilot at the same
size. The eval increases from 282 images to the full 24,633.

**Accepted trade-off.** A NABirds-aligned pilot has a North American bias. It is no
longer a random subset of the corpus. Recipe results from it can therefore differ
from the full run.

## Appendix B: TinyCLIP paper notes

[Wu et al., ICCV 2023](https://openaccess.thecvf.com/content/ICCV2023/papers/Wu_TinyCLIP_CLIP_Distillation_via_Affinity_Mimicking_and_Weight_Inheritance_ICCV_2023_paper.pdf) (Microsoft Research), "CLIP Distillation via Affinity Mimicking and Weight Inheritance".

**A better teacher can be a worse teacher.** Their Table 4 shows one student,
TinyCLIP ViT-40M/32, with weights inherited from different teachers:

| teacher | teacher acc | student acc |
|---|---|---|
| CLIP ViT-B/32 | 63.2 | 52.4 |
| OpenCLIP ViT-B/32 | 62.9 | **53.5** |
| OpenCLIP ViT-L/14 | 75.3 | 45.1 |
| OpenCLIP ViT-H/14 | **78.0** | **41.1** |

A near architecture is more important than teacher accuracy. **This result applies to
weight inheritance, which we do NOT use.** It therefore does not remove
WingCLIP-0.1 as our teacher. Read it again if [F7](#phase-f-shrink-the-model-to-clear-the-size-gate) gives a low score.

**Affinity mimicking does not apply to us.** Their loss distils the image-text
affinity matrix. That method needs one text for each image. We distil features into
a fixed embedding space, and we have no text for each image.

**Multi-stage progressive distillation** (86.6M → ~60M → 39M) is their answer if a
direct jump loses too much. Any intermediate must be **patch16**. See Appendix C.

## Appendix C: Rejected and confounded experiments

**exp4 shows nothing about capacity.** `vit_betwixt_patch32_clip_224` uses patch32,
which gives 49 tokens. The 39M `vit_medium_patch16` uses patch16, which gives 196
tokens. The larger model has 4x less spatial resolution. For that reason it trained
faster and scored lower. The result does NOT show that 61M is worse than 39M.

**The LR sweep used the recipe that we then abandoned.** exp1 to exp4 all used the
0.1 basis. Only `--lr` changed. But the winner uses the 0.2 basis. A later sweep on
the 0.2 basis gives 3e-5 = 0.9546, 5e-5 = 0.9563, and 7e-5 = 0.9560. So 7e-5
remains correct.

**Two ONNX numbers were WRONG.** The first is "int4 = 75.3 MB". It came from
`MatMulNBitsQuantizer`. That tool quantizes only the MatMul weights. It leaves the
embeddings, LayerNorm and bias at fp32. An earlier torch bug also left all
attention `in_proj_weight` at fp32. Quantize every weight in torch, and the true
size is 43 MB. The second is "fp16 cannot be built". That is true only for the ONNX
converters. It says nothing about accuracy: fp16 in torch needs one `.half()` call
and works correctly. An export-format problem is a DEPLOYMENT problem, not an
accuracy problem.

**Two augmentation facts that we confused more than one time.** These come from the
checkpoint `args`, not from prose. The 0.1 DISTILLATION used `aug none`. The 0.2
distillation used `aug light`. The 0.1 FINE-TUNE also used `aug light`. Distillation
and fine-tuning are different stages. Do not mix them. That error gave the wrong
conclusion that both recipes use `aug light`, and that wd 0.2 is the only
difference.

## Appendix D: Throughput and hardware

Real work, but not a link in the shipping chain.

**The loader ceiling is the TRANSFORMS, not SMB.** Decode is not the binding
constraint either.

**Do not trust `nvidia-smi` utilization for this workload.** It shows only that a
kernel is resident. It does not show that the SMs do useful work.

**We run at 61% of the true GPU ceiling.** The RTX 3080 ceiling for AMP training is
~60 TFLOP/s. It is not the 119 TFLOP/s on the spec sheet. The 119 figure assumes
fp16 accumulation. AMP accumulates in fp32, which runs at half speed on GeForce
Ampere. `jobs/gemm_peak.py` measures bf16 N=8192 at **63.7 TFLOP/s**. We get 38.9,
which is 61%. That value is normal for ViT training. **Never quote 119 TFLOP/s for
this card with AMP.**

**GPU tuning is COMPLETE.** bf16, channels_last and torch.compile together give
~1.17x. The backward pass is ~64% of the step time. The optimizer is only ~4.6%,
so fused AdamW gives +0.4%. Further gains need a different architecture or
different hardware, not a different configuration.

**Batch size is a free knob**, not a speed lever.

**`torch.compile` and checkpoints.** `torch.compile` puts a wrapper around the
module. Each state_dict key then gets an `_orig_mod.` prefix. Such a checkpoint
will not load into a plain module. This error lost a full 2-hour run. Both sides
now agree: training saves the unwrapped keys, and the eval removes the prefix.

**Profile only on an IDLE GPU.** A second job changes the result, with no warning.
CPU work also competes with the dataloader. An eval on the CPU during training
decreased throughput from 715 to 537 img/s.

**Better hardware has MORE value than it appears to have.** We are near the practical
peak of this card. That peak is half of the headline number. The remaining gains
are therefore in the hardware, not in the configuration. This is the background to
the RTX PRO 4500 question. We have not bought or recommended anything.

**Cloud costs.** Upload from tomahawk measures ~14 MB/s. RunPod charges during the
upload. That cost controls the decision.

## Appendix F: Smoke and gate runs

These runs test the pipeline, not the model. They are here so that a reader who finds
the checkpoint knows why the score is low.

| run | ep | val_cos | purpose |
|---|---|---|---|
| `wds_smoke` | 1 | 0.6698 | WebDataset loader works |
| `wds_recipe_smoke` | 2 | 0.6888 | recipe flags parse |
| `gate2b_mainset` | 1 | 0.8003 | main shard set reads |
| `gate2_viability` | 2 | 0.9217 | shards reproduce the local-corpus result |
| `_smoke_tiny` | 1 | 0.4978 | TinyCLIP arch loads through timm |

## Appendix E: Consolidation history

Scripts were split across two branches, consolidated 2026-07-22. Five ml docs merged
into this file 2026-07-23. Pi checkout deleted 2026-07-24. One directory + corpus
deletion 2026-07-25. Current-truth-first reorganization 2026-07-31. Converted to the
phase-table schema 2026-08-03.

[^augscale]: The entire non-aug bundle (wd 0.2, beta2 0.95, warmup 500, grad-clip
    1.0) was worth +0.0016 on pilot, and those are near-universal optimizer defaults.
    Aug light alone was +0.0048. The stated explanation for C6's loss is that 2.5M
    images leave little overfitting to prevent, so regularization costs representation
    quality, an argument that applies to the regularizers (aug, wd), not to beta2 or
    warmup. A pilot A/B cannot settle it, because the hypothesis is that aug's sign
    DEPENDS on scale: measuring at pilot scale, where we already believe it helps,
    is not evidence about full scale.
