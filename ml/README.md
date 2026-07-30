# WingDex on-device bird ID: BioCLIP-2 spike → distilled student

**Single source of truth** for the on-device / offline bird-ID effort. This one
doc replaces the former `ml/README.md`, `ml/BROWSER.md`, `ml/distill/README.md`,
`ml/distill/METHOD.md`, and `ml/demo/README.md` (consolidated 2026-07-23 so the
queue and status are impossible to miss).

Tracks issue [#260](https://github.com/jlian/wingdex/issues/260). Branch:
`bioclip-distill`.

---

## STATUS + QUEUE (read this first)

🟢 **Baseline done, recipe chosen, infrastructure consolidated.** Next concrete
step is the **combined confirmation run** (see "NEXT STEP" below).

**Working location: ONE directory** — `~/wingdex/ml/distill/` on tomahawk (repo +
data + uv venv). The Pi checkout and the `~/spikes` scratch dir are both gone.
Training data = WebDataset shards on the NAS.

### Results: exp7 + ground-truth sampler (2026-07-26)

**exp7 (aug light + lr 7e-5, 25 ep, 500-sp pilot) — the confirmation run.**
- best val_cos **0.9540 @ep25**, monotonic, **no post-peak decline**
- at ep15 (apples-to-apples vs exp3): **0.9504 vs exp3's 0.9512**
- **held-out top-1 retention 104.1%** (student 59.63 vs teacher 57.30) — beats
  exp3's 100.4% and exp1's 92.2%
- **NABirds top-1 93.26%, retention 101.9%** (teacher 91.49). Note: only 282
  in-species test images, so noisy; the full-run baseline was 94.7%.
- **still climbing at ep25** (+0.0001/ep, not flattened)

**Verdict: LR is a WASH, EPOCHS are the lever.** The ep15 gap (0.0008) is inside
noise, and exp7 won on both metrics that actually matter (held-out retention and
NABirds). exp7's +0.0028 over exp3 came from epochs 16-25, not from the lower LR.
⚠️ Do NOT lock a recipe on a 0.0008 val_cos difference while ignoring the ship
metric — that was the cron's initial recommendation and it is the wrong basis.

**Locked recipe (LR either 1e-4 or 7e-5, they are equivalent):**
`--wd 0.2 --beta2 0.95 --warmup 500 --grad-clip 1.0 --min-lr 1e-7 --aug light`
with **as many epochs as budget allows — 25 was still not enough**.

**Ground-truth held-out set — BUILT.** `groundtruth_heldout.parquet` (10.9MB):
- **178,852 photos / 5,908 species / 178,852 observations** (one photo per obs)
- per-species: min 5, **median 40** (the cap), avg 30.3
- **VERIFY: 0 leaked photo_ids, 0 leaked observations** ✅
- streamed 46.4M untouched candidate photos in ~23.5 min at a 24GB DuckDB cap
- ⚠️ **5,259 of 11,167 taxonomy species dropped** for having <5 untouched photos.
  So the fine-tune set covers **5,908 species, not our full 7,555 corpus species**
  — rare species were scarcity-capped in the original pull, so there is no hidden
  reservoir for them. Any fine-tune eval must be read as "on the 5,908 species
  with spare data", not as full-taxonomy coverage.
- NOTE this is the photo LIST only. The images are not downloaded yet
  (~15-20GB via `pull_images.py`).

### WiSE-FT at FULL species (2026-07-27): the sweep FLIPPED — heavy fine-tune wins

The alpha sweep in the section below was accidentally run at the eval default
`--pilot-species 500`. Re-run at `--pilot-species 0` (all 7,555 species, the
real ship basis), the curve inverts:

| alpha | 500-sp retention | FULL-species retention | FULL student top1 |
|---|---|---|---|
| 0.00 (distilled) | 98.1% | 94.7% | 81.83 |
| 0.25 | **99.6%** (500-sp winner) | 99.2% | 85.71 |
| 0.50 | 98.8% | 102.1% | 88.19 |
| 0.60 | - | 102.9% | 88.91 |
| **0.75** | - | **103.5% (peak)** | **89.45** |
| 1.00 (pure fine-tune) | 93.4% | 103.3% | 89.30 |

**On the full taxonomy, MORE fine-tune weight is better, and the ground-truth
fine-tune BEATS THE TEACHER on OOD NABirds** (alpha>=0.50 all exceed 100%
retention; peak alpha=0.75 = 103.5%, student 89.45 vs teacher 86.41). This is
the headline result: true-label fine-tuning genuinely beats the ViT-L teacher on
out-of-distribution data, not just in-distribution.

Why the sweep flipped between 500 and 7,555 species: on the 500 pilot species the
distilled model was already near-teacher, so fine-tuning mostly added OOD noise
and low alpha won. Across all 7,555 species the fine-tune's true-label knowledge
helps far more, so the optimum shifts hard toward the fine-tuned weights. **The
500-species sweep was misleading; only the full-species curve should inform the
ship decision.** Lesson: ALWAYS pass `--pilot-species 0` for a shippable number.

**Ship candidate: alpha=0.75 WiSE-FT blend (103.5% NABirds retention).** Note
1.00 is within noise of 0.75, so the blend is barely doing anything here vs the
pure fine-tune -- at full scale the fine-tune is robust enough on its own that
WiSE-FT's OOD protection is nearly moot. Keep alpha=0.75 as a small hedge.

### How the 178k fine-tune set was chosen, and what it actually contains (2026-07-27)

**Sizing was two knobs plus scarcity, not a target.** `build_groundtruth_split.py
--per-species 40 --min-per-species 5`, taking ONE photo per observation from
photos the distillation never touched. 5,908 x 40 would be ~236k; the real
distribution came out min 5, **median 40 (the cap)**, mean 30.3 -> 178,852. Most
species hit the cap; a long tail sits near the floor. The 40 was a judgement
call (enough signal per class without a huge download) and **has never been
tested** -- it may under-fit common species or over-weight them vs rare ones.
iNat has ~49M untouched photos across our species, so 178k is ~0.4% of what is
available; raising `--per-species` to 100-200 is just a sampler re-run + bigger
pull, no new code.

Non-arbitrary constraints: one photo per observation (kills near-duplicate
leakage inside the held-out set), and exclusion of any photo whose OBSERVATION
appears in training. Verified 0 leaked photo_ids, 0 leaked observations.

**Why the fine-tune covers 5,908 species when the corpus covers 7,555 --
and why that is NOT simply "a lower floor".** The two floors apply to different
pools and are not comparable:
- corpus `--min-photos 50` = species with >=50 photos available in iNat TOTAL
- fine-tune `--min-per-species 5` = species with >=5 photos LEFT OVER after the
  distillation already took up to 500 each

A species with 60 available photos passed the 50 floor, gave all 60 to the
distillation, and has nothing left. Confirmed in the data: **dropped species max
out at 512 available photos (median 159); kept species have a median of 994.**
Nothing in the 100-500 available band survived; essentially everything above 600 did.

**⚠️ CORRECTION 2026-07-27 (John challenged this; I was wrong).** I first wrote
that the 2,058 fine-tune-only species "passed the >=50 filter but were excluded
from the 7,555". **False.** All 2,058 have `avail_photos < 50` (min 5, median 24,
max 49) -- they FAILED the corpus floor and were never distillation candidates
(confirmed: 0 of 2,058 appear in the raw pre-cap manifest). My error was assuming
`target_taxa.csv` is the post-filter species list; it is the PRE-filter list of
all 11,167 taxonomy species, 3,612 of which are under 50 photos.

**This is a BUG in `build_groundtruth_split.py`, not a property of the data.**
The sampler filters on its own `--min-per-species 5` against iNat directly and
never intersects with the species the distillation actually trained on. It
therefore silently pulled in 2,058 species with as few as 5 photos in existence.

Consequences to weigh before trusting the fine-tune numbers:
- 27,810 photos (15.5% of the fine-tune set) are species with 5-49 total photos
  worldwide -- far too few to learn a fine-grained class; likely noise or
  memorization rather than signal.
- it makes the classifier 5,908-way instead of 3,850-way, diluting gradient
  signal on the species we actually distilled.
- so the fine-tune may have been HELPED by nothing here, or actively hurt.
**Fix:** intersect the sampler with `train_manifest.parquet` species, or raise
`--min-per-species` substantially, then re-run the fine-tune and compare.

**The sets are NOT nested:**

| | species | photos |
|---|---|---|
| in BOTH (distilled + fine-tuned) | 3,850 | |
| distilled ONLY (supply consumed by the 500 cap) | 3,705 | |
| **fine-tune ONLY — NEVER distilled** | **2,058** | **27,810 (15.5%)** |

So the fine-tune trains on 5,908 classes of which only 3,850 were ever distilled.
The 2,058 extras are data-starved species that should not have been included at
all (see the correction above).

⚠️ **Follow-ups:**
1. [x] **RESOLVED 2026-07-30 (T2): sampler fixed; clean set = 3,850 species
   / 151,042 photos.** OOD went UP slightly: NABirds 89.45 (dirty, alpha=0.75)
   -> 89.93 (clean, alpha=0.90). In-distribution val 63.39 -> 77.61 (+14.22).
   The 2,058 starved classes were pure dilution, not contributors.
   CAUTION: in-dist figures are NOT comparable to the old 72.88% (5,908 vs
   3,850 classes). NABirds is the only fixed-basis comparison.

2. [x] **RESOLVED 2026-07-30 (T1): the NABirds gain is RECOGNITION, not coverage.**
   Split the NABirds test set by whether each species was in
   `train_manifest.parquet`. Result: **all 24,633 test images belong to distilled
   species; ZERO come from the 2,058 never-distilled ones.** So the coverage
   confound cannot touch the NABirds number at all.

   | model | overall | distilled sp. | never-distilled |
   |---|---|---|---|
   | WingCLIP-0.1-alpha (base) | 81.84 | 81.84 | n/a (0 imgs) |
   | WingCLIP-0.1 (WiSE-FT a=0.75) | **89.45** | **89.45** | n/a (0 imgs) |
   | delta | **+7.61** | **+7.61** | — |

   **"The ground-truth fine-tune beats the teacher on OOD data" stands as stated**
   — the entire +7.61pt gain is on species the base model already knew. (It also
   independently reproduced the sweep's 81.83/89.45, a nice cross-check.) Script:
   `t1_coverage_split.py`; results `runs/ft_full7555_gt/t1_coverage_split.json`.
   NOTE this does NOT excuse the sampler bug — follow-up 1 still matters for the
   in-distribution 72.88% figure and for any future fine-tune.

### Why the WiSE-FT curve is flat at the top: the fine-tune was GENTLE (2026-07-27)

Initially I claimed the flat alpha=0.75..1.00 top meant "WiSE-FT does not matter at
full taxonomy" and hand-waved a story about NABirds being drawn from the same iNat
pool. **Both were wrong.** NABirds is Cornell Lab / Visipedia, birder-sourced, a
genuinely different distribution -- so the fine-tune's +7.6pt OOD gain
(94.7% -> 103.3% at alpha=1.0) is real generalization, not same-pool leakage, and
is a STRONGER result than I first credited.

Measured the actual weight movement instead of theorizing:

```
global relative weight change (distilled -> finetuned): 4.718%
  11.84%  visual.proj              <- projection layers move most
  11.82%  proj.weight
   8.82%  visual.transformer.resblocks.11.attn.out_proj.weight
   8.48%  resblocks.10 / 8.47% resblocks.11.mlp   <- last blocks
   0.43%  resblocks.7/8/11 ln_*    <- early layers barely touched
```
Also verified the interpolation itself is correct: |W - W_prev| is identical
(0.2012) across every alpha step, exactly as (1-a)*A + a*B requires. Not a merge bug.

**Real explanation:** the fine-tune only nudged the model 4.7%, concentrated in
the projection + last few blocks, because it was configured conservatively
(lr 1e-5 = 7x below distillation LR, 12 epochs, aug light, wd 0.1). So alpha=1.0
is ALREADY effectively a mild interpolation, and there is little OOD damage for
WiSE-FT to repair. It is not that WiSE-FT stopped working -- **our fine-tune was
too gentle to trigger the failure mode WiSE-FT exists to fix.** (Consistent with
the 500-species sweep reproducing the textbook hump: whether the protection
matters depends on how much the fine-tune helps on the eval distribution.)

**Implication / queued experiment:** a more aggressive fine-tune (higher LR,
more epochs) may push OOD higher still, and only THEN would WiSE-FT earn its
keep. ~2h, images already on disk. Worth running after the retrain.

### FULL RETRAIN with the locked recipe (started 2026-07-27 16:05)
Kicked off the full 7,555-species distillation with the LOCKED recipe (lr 7e-5,
wd 0.2, beta2 0.95, warmup 500, grad-clip 1.0, min-lr 1e-7, aug light, 25 ep) ->
runs/full7555_locked_ep25.

**RESULT (2026-07-30): the locked recipe LOST at full scale. Keep WingCLIP-0.1-alpha
as the distillation base.** Final val_cos 0.9618 (vs 0.1-alpha 0.9650) and
crucially **NABirds full-species retention 90.7% (student 78.4 / teacher 86.41)
vs 0.1-alpha's 94.7% (81.83)** — a 4-point OOD REGRESSION, not noise. The honest
read, exactly as predicted going in: at 7,555 species / 2.5M images the recipe's
regularization (aug light + wd 0.2) has little overfitting to prevent and instead
costs representation quality, so **scale dominates recipe** and the old-recipe
0.1-alpha is the better distillation base. The +0.003 val_cos / sub-point pilot
edge did NOT transfer to full scale, and it inverted on the ship metric.

Consequences:
- **WingCLIP-0.1-alpha stays the distillation base; 0.2-alpha is retired** (not
  promoted). The ground-truth fine-tune + WiSE-FT (which already beat the teacher,
  103.5% at alpha 0.75) is applied on 0.1, not 0.2.
- The ~62 GPU-hours were not wasted: they turned "the pilot recipe is better" from
  an assumption into a measured, disproven claim at full scale. That is the value
  of running it.
- Lesson reinforced (again this week, cf. exp8): pilot deltas of a few thousandths
  val_cos do NOT reliably transfer to full scale, and val_cos is not the ship
  metric. Decide recipes on NABirds `--pilot-species 0`, not val_cos.

### Ground-truth fine-tune + WiSE-FT (2026-07-27): teacher BEATEN in-distribution; WiSE-FT alpha=0.25 best OOD

First attempt to BEAT the teacher rather than approach it. Fine-tuned the full
7,555-species distilled model on TRUE species labels from 178k leak-free photos
(build_groundtruth_split.py, obs-split, 0 leaked photos/observations), using the
FROZEN BioCLIP-2 text tower as fixed class weights so all evals stay valid and
the model stays open-vocab. finetune_groundtruth.py, 12 epochs, lr 1e-5, aug light.

**In-distribution (5,908-species ground-truth val split, absolute top-1):**
- distilled student baseline: **54.47%**
- TEACHER (BioCLIP-2) on the identical split: **57.69%** -> so the student's
  54.47% = **94.4% retention**, consistent with its 94.7% on NABirds. The model
  was NOT underperforming; the task is just hard (even the ViT-L teacher only
  hits 57.69% over 5,908 species on raw iNat photos).
- fine-tuned student: **72.88%** (+18.41 over its own baseline, and +15.2 OVER
  THE TEACHER). Plateaued by ~ep10. This is the "beat the teacher" result, but
  it is in-distribution.

**OOD (NABirds, the ship metric) -- WiSE-FT alpha sweep** theta=(1-a)*distilled + a*finetuned:

| alpha | NABirds top-1 | retention |
|---|---|---|
| 0.00 (pure distilled) | 89.72 | 98.1% |
| **0.25 (best)** | **91.13** | **99.6%** |
| 0.50 | 90.43 | 98.8% |
| 0.75 | 87.23 | 95.3% |
| 1.00 (pure fine-tune) | 85.46 | 93.4% |

**Verdict: WiSE-FT worked exactly as its theory predicts.** A light blend
(alpha=0.25) lifts OOD retention 98.1% -> 99.6% while the fine-tune banks +18pts
in-distribution; pushing past 0.25 degrades OOD monotonically to 93.4% at pure
fine-tune (the classic robustness loss WiSE-FT exists to repair). So the shipped
model is the **alpha=0.25 WiSE-FT blend**: best of both, near-teacher OOD plus
large in-distribution gains and true-label knowledge the teacher lacks.

⚠️ **RESOLVED 2026-07-27 — read this before quoting ANY NABirds number.**
The 98.1%-vs-94.7% gap was not an error in either number: **`eval_nabirds.py`
DEFAULTS to `--pilot-species 500`**, restricting the eval to the 500 pilot
species. Pass `--pilot-species 0` to score all 7,555. Verified by re-running the
same checkpoint both ways:

| eval scope | student top1 | teacher top1 | retention |
|---|---|---|---|
| `--pilot-species 500` (the DEFAULT) | 89.72 | 91.49 | 98.1% |
| `--pilot-species 0` (all 7,555) | 81.83 | 86.41 | **94.7%** |

So **94.7% is the honest full-taxonomy figure** and 98.1% is the easier
500-species subset. Consequence: the WiSE-FT alpha table above was computed on
the 500-species subset, because the default was never overridden. The sweep is
internally consistent (all five alphas used identical settings) so the SHAPE is
valid, but the alpha winner is being re-confirmed at `--pilot-species 0` before
the ship recommendation is final. **Always pass `--pilot-species 0` explicitly
for any number that goes in the writeup.**

### exp9 (2026-07-27): strong aug does NOT beat light aug. Light aug stays locked.

exp9 = exp7's recipe EXACTLY (lr 7e-5, 25ep) except `--aug strong` (RRC
[0.08,1.0]) with per-view teacher targets from a 5-view precompute. This was the
one lever with theoretical upside left (MobileCLIP's +4.8%), and the whole
multi-view machinery (`precompute_embeddings.py --views`, `MultiViewTargets`,
`--aug strong`) was built to test it. Verdict: it did not pay off.

| metric | exp7 (light aug) | exp9 (strong aug) | winner |
|---|---|---|---|
| best val_cos | **0.9540** | 0.9434 | light (+0.0106) |
| held-out retention (obs split) | 104.1% | **105.9%** | strong (+1.8) |
| NABirds top-1 (ship metric) | **93.26%** | 92.55% | light (+0.71) |

**Read:** strong aug is genuinely regularizing (best held-out retention of any
run, still climbing at ep25, higher train_loss), but it costs raw representation
quality (val_cos) and, crucially, loses on **NABirds, the ship metric**. The
held-out win is on the in-distribution obs-split set; the out-of-distribution
NABirds number is what matters, and light aug wins it. Net: not worth it.

**DECISION: light aug stays the locked recipe. The full-corpus 5-view precompute
(~56 GPU-h) is NOT justified and is cancelled.** The pilot test paid for itself
by saving those 56 hours. All distillation levers are now exhausted:
- LR: 7e-5 (exp7 > exp8's 1e-4)
- epochs: ~25 (exp8 proved 40 doesn't help)
- recipe bundle: +0.0016, keep it
- aug: **light** (exp3/exp7 > exp9's strong on the ship metric)

### ✅ FINAL LOCKED DISTILLATION RECIPE
```
--lr 7e-5 --wd 0.2 --beta2 0.95 --warmup 500 --grad-clip 1.0 --min-lr 1e-7
--aug light --batch 96 --epochs 25
```
Best pilot result: exp7 = val_cos 0.9540, held-out retention 104.1%, NABirds
93.26%. Next: apply this recipe to the FULL 7,555-species run, then the
ground-truth WiSE-FT fine-tune (images already pulled).

### exp8 (2026-07-26): epochs are NOT the lever — LR is. My hypothesis was wrong.

exp8 = the SAME recipe as exp7 except **lr 1e-4 instead of 7e-5**, run to 40 epochs
to test the "both runs were still climbing, so epochs are the binding constraint"
hypothesis. It falsified that hypothesis cleanly.

| | exp7 (lr 7e-5, 25ep) | exp8 (lr 1e-4, 40ep) |
|---|---|---|
| best val_cos | **0.9540** | 0.9503 (peak ~ep37) |
| val_cos @ep25 | **0.9540** | 0.9485 |
| curve at end | still climbing | **FLAT since ep33** |
| held-out retention | **104.1%** | 103.2% |
| NABirds top-1 | **93.26%** | 92.91% |

**exp8 lost on all three metrics, and 15 extra epochs never even reached exp7's
25-epoch mark.** Read: 1e-4 converges fast to a LOWER ceiling; 7e-5 climbs more
slowly to a BETTER optimum. 40 epochs is more than enough — the recipe, not the
epoch count, was the limiter.

**Correcting the earlier call:** on 2026-07-25 I saw exp3 (lr 1e-4) beat exp7 by
0.0008 at ep15, called it noise, and concluded "LR is a wash, epochs are the
lever." That was over-generalizing from a single crossing point — a gap at one
epoch says nothing about the *asymptote*. exp8 is a good experiment precisely
because it disproved the hypothesis it was built to confirm.

### ✅ LOCKED DISTILLATION RECIPE (as of 2026-07-26)
```
--lr 7e-5 --wd 0.2 --beta2 0.95 --warmup 500 --grad-clip 1.0 --min-lr 1e-7
--aug light --batch 96 --epochs ~25
```
Levers now considered SETTLED: LR (7e-5 > 1e-4 > 5e-5), epochs (~25; 40 does not
help), recipe bundle (+0.0016, marginal), and augmentation strength
(light > strong -- exp9 2026-07-27 tested true strong aug with multi-view
teacher caching and it LOST on NABirds; cancelled). No distillation-recipe
lever with known upside remains. Remaining ideas are unvalidated: co-occurrence
hard-example weighting (built, never wired in) and higher input resolution.

### Ground-truth set: images pulled
178,804 files / 5,908 species / 19GB at `~/wingdex/ml/groundtruth/corpus/`
(gitignored). 13 HTTP-404 failures (0.007%). 0 decode failures in a 120-file
sample, median 500x375. Leak-verified: 0 trained photo_ids, 0 trained
observations. Ready for the WiSE-FT ground-truth fine-tune.

### 🏷️ MODEL REGISTRY — **WingCLIP** versioning

**Name:** WingCLIP. It IS a legitimate CLIP variant — ViT-B/16 image tower,
CLIP-contrastive pretrained (LAION-2B), emitting embeddings in a shared
image/text space and usable zero-shot with a text tower. The model card must
state the lineage explicitly for attribution + licensing: **LAION-2B ViT-B/16
init, distilled from BioCLIP-2 ViT-L/14**. That is a card requirement, not a
naming constraint.

**Scheme: `WingCLIP-<MAJOR>.<MINOR>[-stage][-pilot]`**
- **MINOR = the training-recipe/data basis** (the expensive thing: a distillation
  generation). Bump it when the recipe or corpus changes.
- **stage suffix = where in the pipeline that basis is**, all cheap post-processing:
  - `-alpha` = raw distillation output
  - `-beta`  = + ground-truth fine-tune
  - *(no suffix)* = + WiSE-FT blend — the **complete pipeline** on that basis
- **`-pilot`** = the 500-species version of any of the above.
- **MAJOR 1.0 = earned, not automatic.** A basis becomes 1.0 only when it PASSES
  Phase 4 vs GPT (83/87). So 1.0 will most likely be a *promotion* of a 0.x, not
  a separate training run.

| version | what | run dir | key numbers |
|---|---|---|---|
| `WingCLIP-0.1-alpha-pilot` | 500sp distill, old recipe | `pilot500_vitb` | val_cos 0.9465 |
| **`WingCLIP-0.1-alpha`** | **full 7,555sp distill, OLD recipe** (no warmup/clip, beta2 .999, wd .1, aug none, lr 1e-4, 20ep) | `full7555_vitb` | val_cos 0.9650 · NABirds **94.7%** (81.83/86.41) |
| **`WingCLIP-0.1-beta`** | 0.1-alpha + ground-truth fine-tune (lr 1e-5, 12ep) | `ft_full7555_gt` | GT-val 72.88% (teacher 57.69) · NABirds 103.3% |
| **`WingCLIP-0.1`** | 0.1-beta + WiSE-FT alpha=0.75 — complete pipeline | `ft_full7555_gt/wise_a0.75.pt` | **NABirds 103.5%** (89.45/86.41) ⬅ current best |
| `WingCLIP-0.2-alpha-pilot` | 500sp distill, LOCKED recipe | `exp7_combined_lr7e5_auglight_ep25` | val_cos 0.9540 |
| `WingCLIP-0.2-alpha` | full distill, **LOCKED** recipe (lr 7e-5, wd .2, beta2 .95, warmup 500, clip 1.0, aug light, 25ep) | `full7555_locked_ep25` | val_cos 0.9618 · **NABirds 90.7%** (78.4/86.41) — LOST to 0.1-alpha's 94.7% |
| `WingCLIP-0.2-beta` | 0.2-alpha + fine-tune on the CLEANED GT set (T2) | *tbd* | *planned* |
| `WingCLIP-0.2` | 0.2-beta + WiSE-FT — complete pipeline | *tbd* | *planned* |
| `WingCLIP-1.0` | whichever basis first PASSES Phase 4 | *tbd* | *earned, not automatic* |

**Experiments** that never became a lineage are tagged under the basis they
informed and are never quoted as WingCLIP results:
`0.2-pilot-exp1..exp6` (recipe + LR sweep), `0.2-pilot-exp8` (40-epoch test),
`0.2-pilot-exp9` (strong aug + 5-view). Also non-registry: `gate*`, `*smoke*`, `pilot`.

**Publishing:** keep 0.x internal. Only push to HF at 1.0 — HF repos accumulate
confusing history fast, and a 0.x with a known sampler bug is not something to
put a card on.

**Teacher reference** (every retention number divides by this):
BioCLIP-2 ViT-L/14 `hf-hub:imageomics/bioclip-2` — NABirds **86.41** top-1 at
full species; **57.69** on the 5,908-sp ground-truth val split. (NABirds at the
`--pilot-species 500` default reads 91.49 — do not mix the two.)

### ⭐ TASK QUEUE (concrete, rewritten 2026-07-27 17:55)

Ordering principle: **unblock Phase 4 first.** Phase 4 is the go/no-go the whole
project exists to answer and it has never been run; everything else is polish
that keeps crowding it out. Tasks below are sized and have explicit exit criteria
so they can be run unattended.

---
**T0 — IN FLIGHT: build WingCLIP-0.2-alpha** (full retrain, locked recipe, ~Thu AM)
`runs/full7555_locked_ep25`, started Mon 16:05, ~2.4h/epoch x 25.
Watched by cron `full-retrain-pipeline` (reports at ep20 + on completion, then
runs full-species evals).
*Exit:* val_cos + NABirds (`--pilot-species 0`) for **0.2-alpha vs 0.1-alpha**
(0.9650 / 94.7%).
A flat or negative result means "scale dominates recipe", which is a legitimate
finding, not a failure. **Nothing below is blocked on this** — T1/T2 run against
0.1-alpha / 0.1-beta / 0.1.

---
**T1 — ✅ DONE 2026-07-30: coverage question RESOLVED — the gain is recognition**
All 24,633 NABirds test images are distilled species; zero are from the 2,058
never-distilled ones, so the +7.61pt gain (81.84 → 89.45) cannot be coverage.
"Beats the teacher on OOD" stands. Details in the fine-tune section above.

~~**T1 — Diagnose the fine-tune coverage question** (~30 min, CPU/GPU-light)~~
The fine-tune trained on 5,908 classes but only 3,850 were ever distilled; the
other 2,058 have 5-49 photos worldwide (median 24) and were pulled in by a
sampler bug, not a decision. Before trusting "fine-tune beats the teacher":
1. Split the NABirds gain by whether each species was in `train_manifest.parquet`.
   NABirds is North American so its species are well-populated — expectation is
   the 2,058 contribute ~nothing there and the +7.6pt OOD gain is real. **Verify.**
2. Report per-species top-1 for the 2,058 starved classes specifically.
*Exit:* a clear statement of how much of the gain is recognition vs coverage.
*Why first:* it is cheap and it gates how we describe the headline result.

---
**T2 — RUNNING 2026-07-30 10:20 — sampler FIXED, A/B fine-tunes launched**

✅ **Sampler fixed.** `build_groundtruth_split.py` gains `--distilled-only`
(default ON) which ANDs `inat_taxon_id IN (SELECT DISTINCT inat_taxon_id FROM
train_manifest)` into the taxa CTE. Rationale: `target_taxa.csv` is the PRE-filter
list of all 11,167 taxonomy species (3,612 under the >=50-photo floor), so
membership there proves nothing — the train manifest is the authority.

✅ **Clean set built WITHOUT re-running the 25-min 19GB join** — it is a pure
subset of the existing parquet (`filter_gt.py`, seconds):
`groundtruth_heldout_distilled.parquet` = **151,042 photos / 3,850 species**
(was 178,852 / 5,908). Dropped 27,810 photos / 2,058 species. Verified 0
undistilled species remain. Images already on disk, no re-pull needed.

⏳ **A/B fine-tunes running** (sequential, ~1.5-2h each, ~14:00 both):
identical clean data on BOTH bases, to answer whether the weaker base still
fine-tunes to the same place:
  - `runs/ft_clean_01` from 0.1-alpha (NABirds 81.83 / 94.7%)
  - `runs/ft_clean_02` from 0.2-alpha (NABirds 78.40 / 90.7%, lost the retrain)
Then WiSE-FT alpha {0.50, 0.75, 1.00} + `eval_nabirds --pilot-species 0` on each.
Watched by cron `t2-ab-finetune`. Log `/tmp/t2ab.log`.

**Expectation:** NABirds should be ~unchanged (T1 proved the 2,058 dropped
species contribute ZERO NABirds test images); the in-distribution number should
move (old 72.88% was on 5,908 classes, not comparable to the new 3,850-class one)
and may improve by removing unlearnable classes.

⏳ RESUME NOTES (written mid-task at 95% context):
- Patch drafted, NOT applied. Adds `--distilled-only` (default True) +
  `--allow-undistilled`, ANDing into the taxa CTE:
  `AND CAST(inat_taxon_id AS BIGINT) IN (SELECT DISTINCT inat_taxon_id FROM read_parquet('<train_manifest>'))`
- **Cheaper path, prefer it:** do NOT re-run the 25-min 19GB join. Just filter the
  EXISTING `groundtruth_heldout.parquet` down to distilled species — pure subset
  op, seconds. The 178k images are already on disk.
- **John's ask (2026-07-30): run the re-fine-tune on BOTH bases**, identical
  fine-tune data, for a controlled A/B:
  `full7555_vitb/best.pt` (0.1-alpha, won) vs `full7555_locked_ep25/best.pt`
  (0.2-alpha, lost at NABirds 90.7%). Answers: does the weaker base still
  fine-tune to the same place, i.e. does the fine-tune wash out the base gap?
- Expected: 5,908 classes → ~3,850. Should NOT move NABirds (T1 proved 0 test
  images come from the dropped species) but SHOULD move the in-distribution
  72.88%, possibly up, by removing 2,058 unlearnable classes.

(original plan below)

`build_groundtruth_split.py` never intersects with the distilled species. Add
that intersection AND make the floor a deliberate choice, not an accident.
Proposal: `--min-per-species 20` (a class needs enough to learn; 5 is hopeless)
and an explicit `--distilled-only` flag defaulting ON.
Then re-run the fine-tune on the clean set and re-sweep alpha.
*Exit:* does OOD retention go UP (the starved classes were diluting) or DOWN
(they were contributing)? Either answer is useful and settles T1's ambiguity.
*Note:* the distilled student inherits BioCLIP-2's open-vocab text tower, so
rare species already get a sensible zero-shot answer. Training a 20-example
classifier head on top may be WORSE than leaving them to zero-shot.

---
**T3 — PHASE 4: benchmark vs GPT (83/87) and ViT-L (87/96)** ⬅ THE ACTUAL GOAL
Run the shipped candidate through the shared gated+range pipeline on the golden
set. This is the go/no-go for the whole project and has NEVER been run.
Use the best registry model available when T3 starts: **WingCLIP-0.1** today, or
**WingCLIP-0.2** if T0/T2/T5 have landed. State which one the numbers came from.
**Passing Phase 4 is what promotes a basis to 1.0.**
*Exit:* a go/no-go writeup with the head-to-head numbers.
**Do not let T4+ delay this.**

---
**T4 — Export + web** (after T3 says go)
int8/ONNX/Core ML; then int4 on the fine-tuned ViT-B for web (~22MB, <25MB
target). Measure golden-set + NABirds AFTER quantizing — the bar is "useful
(~GPT-level ok)", not "matches BioCLIP".

---
**T5 — Build WingCLIP-0.2-beta and WingCLIP-0.2** (~2h)
Fine-tune 0.2-alpha on T2's cleaned ground-truth set, then WiSE-FT blend. Only
once T0 lands, so the artifact is internally consistent (locked recipe + clean
fine-tune). **0.2 is the intended 1.0 candidate.**

---
**BACKLOG (explicitly not blocking)**
- aggressive fine-tune sweep: ours moved weights only 4.718% (lr 1e-5, 12ep), too
  gentle to trigger the OOD damage WiSE-FT repairs. Try lr 3e-5..1e-4 / 25ep and
  re-sweep alpha. May push past 103.5% AND make WiSE-FT actually earn its keep.
- `--per-species` sweep for the fine-tune set (40 was never tuned; we use ~0.4%
  of the ~49M untouched photos available)
- shard the ground-truth corpus (178k loose JPEGs = ~9 min/epoch; sharding would
  pay for itself if the fine-tune becomes a sweep)
- stock MobileCLIP-S2 vs our student (writeup comparison only; NOT a ship path)
- co-occurrence hard-example weighting (built, never wired into training)
- cosine->accuracy curve (needs per-epoch checkpoints on a future run)

---
**SETTLED — do not re-litigate**
- distillation recipe: lr 7e-5, wd 0.2, beta2 0.95, warmup 500, grad-clip 1.0,
  min-lr 1e-7, aug light, ~25 epochs
- epochs: 40 does NOT help (exp8). strong aug does NOT help (exp9, saved 56 GPU-h)
- ship model: LAION ViT-B/16 (clean license). MobileCLIP-S2 cancelled (license gate)
- **ALWAYS pass `--pilot-species 0` to eval_nabirds.py for any shippable number**
  (it defaults to 500, which silently inflates retention 94.7% -> 98.1%)

### Queue (ordered; corrected 2026-07-23)

- [x] Phase 1 — corpus assembled (iNat AWS Open Data, 7,555 sp, 2.65M imgs / 262 GB)
- [x] Phase 2 — teacher embeddings cached (366 shards, ~2.644M × 768-d)
- [x] Pilot: 500-species ViT-B/16 (val_cos 0.946; 99% OOD retention on NABirds)
- [x] **Full 7,555-species ViT-B/16 baseline run** — 20 epochs, val_cos 0.9650, converged cleanly. **NABirds OOD retention 94.7% top-1** (student 81.83 vs teacher 86.41), held-out 100.1%.
- [ ] **Leakage check (MEASURED 2026-07-23: avg 1.58 photos/obs, 54% from multi-photo obs, no big bursts):** val_cos is ~54%-leakage-biased but that's just a progress monitor; ship metric NABirds is immune. Only hard requirement: split the ground-truth held-out eval by `observation_uuid`.
- [ ] **Pilot experimentation stage (500 sp) — BOTH recipes locked here:**
  - [x] **distillation-recipe sweep DONE 2026-07-25** (6 runs, ~16h) — LR winner **7e-5** (0.9483 vs 0.9463 @1e-4, 0.9475 @5e-5). See "Pilot sweep results".
  - [x] **adopt from MobileCLIP papers — optimizer/schedule knobs LANDED 2026-07-24** (`cb99d53`): `--beta2` (0.95), `--wd` (0.2), `--warmup` (we had NONE), `--grad-clip` (we had NONE), `--min-lr` (cosine-to-1e-6 instead of exactly 0). All default OFF so existing runs are unchanged. Warmup+min-lr compose via one LambdaLR; grad-clip calls `scaler.unscale_()` first (clipping scaled grads under AMP would make the threshold meaningless). Smoke-tested through the `--wds` path.
  - [x] **EXPERIMENT: augmentation strength — DONE 2026-07-25, light aug WON decisively.** +0.0048 val_cos (0.9512 vs 0.9464) AND the late-epoch overfit drift disappeared AND it was still climbing at ep15. Confirmed on accuracy, not just cosine: **held-out top-1 retention 100.4% (student 55.93 vs teacher 55.73) vs 92.2% for the same recipe without aug.** This is the biggest single lever found so far and it clears the gate for multi-view caching.
  - [x] **EXPERIMENT: multi-view teacher caching / TRUE strong aug -- DONE 2026-07-27 (exp9), and it LOST. CANCELLED, do not re-propose.** Tested on the 500-sp pilot exactly as planned. Strong aug (RRC [0.08,1.0] + 5-view per-view teacher targets) regularizes better (held-out retention 105.9% vs 104.1%) but LOSES the ship metric: NABirds 92.55 vs 93.26 for light aug, and val_cos 0.9434 vs 0.9540. The full-corpus 5-view precompute (~56 GPU-h) is NOT justified. See the exp9 section above. Light aug stays locked.
  - [ ] **co-occurrence hard-example weighting** wired into `train_student.py` + tested (built but NOT yet integrated)
  - [ ] **ground-truth fine-tune recipe** (see below) — same cheap-iteration harness; apply **WiSE-FT** (fine-tune from distilled ckpt, then weight-ensemble θ=(1−α)·distilled+α·finetuned, alpha=0.90 -- MEASURED 2026-07-30 T3.2, NOT 0.5) to keep OOD robustness
  - [ ] fine-tune lever to test: higher input res (256/336 via interpolated pos-emb, source is 500px)
- [ ] Build **leak-free held-out ground-truth set** (sampler script, NOT built yet — see "Ground-truth fine-tune")
- [ ] One more full ViT-B run *only if* the sweep beats baseline meaningfully
- [~] Re-benchmark **MobileCLIP-S2 (FastViT)** training speed on the 3080 (the ~17s/step figure is suspect). **DEMOTED 2026-07-25:** this existed to decide whether the 3080 could do the final MobileCLIP run. That run is cancelled, so this is now only curiosity / writeup material. Harness ready: `ml/distill/bench_fastvit.py` (warmup, cudnn.benchmark, AMP, batch sweep 64→512, channels_last both ways in synthetic mode, `--real` reuses the actual train_student dataloader for end-to-end img/s). RUN ONLY WHEN GPU IS FREE.
- [ ] **Map the cosine→accuracy curve:** eval NABirds top-1/5 at epoch 1/5/10/final checkpoints. Answers "is early already usable?" and "minimum epochs needed" — could cut the expensive final MobileCLIP run short. (Needs per-epoch checkpoints saved; add to future runs.)
  - (folded into the benchmark item above — same measurement, but now framed as a comparison rather than a "floor" for a model we intended to ship. Note the original "same arch before/after" framing no longer applies: we ship ViT-B, so this is stock-MobileCLIP-S2 vs our-ViT-B, a cross-architecture comparison.)
- [~] **Adopt Apple's WebDataset dataloader (option A) — DONE for ViT-B, hypothesis PARTLY DISPROVED.** Loader alone went ~306 → ~640 img/s from the NAS (2.1x), but end-to-end training stayed ~302-320 img/s: **we are GPU-bound, not I/O-bound**, so the random-small-file loader was NOT what capped ViT-B. The win should still matter for FastViT (cheaper per-image compute → more I/O-hungry), which is the remaining unchecked part.
  - [x] **Step 1: packing script** — `pack_webdataset.py` (added 2026-07-24). corpus JPEGs + cached teacher embeddings → `.tar` shards; each sample = `.jpg` (verbatim bytes, 500px preserved) + `.emb` (768-d fp16) + `.cls` (inat_taxon_id). Writes **directly to the NAS** so sharding and the corpus move are ONE pass (no 2x local peak; V: vhdx has only ~49GB physically free). Smoke-tested: webdataset reads back, embeddings match source npz bit-for-bit, taxon ids match manifest.
  - [x] **Step 1b: full pack DONE** → `/mnt/nas/WingDex-Distill/wds/` — **2,502,898 rows, 251 shards, 252GB, 62.6 min @ 666/s** (209 skipped for missing embeddings, 0 missing images). Pilot set also packed: `wds-pilot500/` (247,400 samples, 25 shards, 25GB).
  - [x] **Step 1c: VERIFIED + corpus DELETED 2026-07-25.** Gate 1b: all 251 shards opened, 2,502,337 complete triples, 0 embedding/taxon mismatches, 0 decode failures. Gate 2: 2 epochs on pilot shards, ep2 val_cos 0.9217 vs local-corpus baseline 0.9194. Gate 2b: full 251-shard streaming, 1,000 steps clean @ 318 img/s. Final gate: exp1 reproduced the known pilot baseline off shards (0.9447 vs 0.9465). Corpus deleted; 299GB freed.
  - [x] **Step 1d: local corpus DELETED 2026-07-25.** Freed 261GB (WSL root 391GB → 92GB used). Re-downloadable from iNat Open Data via `pull_images.py`. VHD compaction remains OPTIONAL: V: exists only to host the vhdx, and the freed ~262GB inside the ext4 filesystem is reused before the dynamic disk ever expands again, so the high-water mark stops climbing on its own.
  - [x] **Step 2 DONE:** `wds_loader.py` + `train_student.py --wds` (2026-07-24). Kept our image-only cosine loss; Apple's `dr/` loader was NOT adopted (it exists to replay per-augmentation params for their reinforced-dataset scheme, which we don't use). Includes a stratified hash val split — see the session log.
  - [~] **Step 3 partly done for ViT-B:** loader alone **~640 img/s** from the NAS (vs ~306 old) but end-to-end training is still **~302-320 img/s** → **we are now GPU-bound, not I/O-bound**, so the dataloader was not what capped ViT-B. FastViT through this path is still TODO and is where the win should actually show.
- [x] ~~Final **MobileCLIP-S2** production run~~ — **CANCELLED 2026-07-25 (John's call). LICENSE GATE RESOLVED: we are NOT shipping anything based on MobileCLIP.** Only Apple `datacompdr` weights exist for MobileCLIP-S2 and they are research-only, so it was never commercially shippable without training FastViT from random init. **The shipped model is the LAION ViT-B/16 student** (clean license, ~45MB fp16 / ~22MB int4). MobileCLIP-S2 is demoted to a **BENCHMARK**: run stock Apple weights zero-shot on our bird benchmark and report how our distilled student compares. That is a nice-to-have comparison for the writeup, not a dependency.
- [ ] **BENCHMARK (not a ship path): stock MobileCLIP-S2 vs our student.** Download Apple's research-only weights, zero-shot with its own text tower on the golden set + NABirds, and report the delta vs our ViT-B student. Inference-only, GPU-when-free. Research use of research-only weights is fine; nothing from it ships.
- [ ] Apply the proven fine-tune recipe to the shipped MobileCLIP student
- [ ] Phase 4 — benchmark vs GPT (83/87) + ViT-L (87/96) on shared gated+range pipeline; go/no-go writeup
- [ ] Export: int8 + ONNX + Core ML; demo page real WebGPU numbers
- [ ] **Test int4 on the FINE-TUNED ViT-B for web (~22MB, <25MB target):** measure golden-set + NABirds; bar is "useful (~GPT-level ok)," not "matches BioCLIP." Fine-tune int8 to ship-quality FIRST, then quantize. Levers if it drops too far: mixed precision, better calibration.
- [x] **Consolidated to ONE directory 2026-07-25** — `~/wingdex/ml/distill/` (repo + data + uv venv). Pi checkout deleted, `~/spikes` scratch dir deleted, corpus deleted, 16 Phase-0 spike scripts + 162 fixtures rescued into `ml/spike/`. Corpus did not need moving to the NAS: the WebDataset shards there already contain every image byte-identically.

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

## Input resolutions (teacher 224 / ViT-B 224 / MobileCLIP-S2 256; source 500px)

Storage res and model-input res are DIFFERENT things, don't conflate them:

- **On disk:** iNat `medium` JPEGs = longest edge 500px (`pull_images.py --size medium`). e.g. 500×334, 500×500. This is just the raw file we keep; we never train at 500px.
- **Teacher (BioCLIP-2): native 224.** `precompute_embeddings.py` ran each 500px JPEG through open_clip's BioCLIP-2 `preprocess` (resize 224 + center-crop) then embedded it. So teacher resize 500→224 was **done ONCE at precompute** and baked into the cached embeddings; teacher never runs at train time.
- **Tuning student (ViT-B/16): native 224**, resized **live** in the dataloader per step (its own open_clip `preprocess`).
- **Shipping student (MobileCLIP-S2 / FastViT): native 256** (confirmed via open_clip config: MobileCLIP S0/S1/S2/S3/S4 + MobileCLIP2 S-series are all 256; only B/L are 224). It trains at **256** live. Different input res from the 224 teacher is fine, both towers land in the same 768-d embedding space; the student just gets a bit more spatial detail at its native op point. 500px source comfortably supports both downscales (no upscaling).
- The `256` zero-tensor in `train_student.py` is only a decode-failure fallback for the CURRENT ViT-B run; it is NOT the ViT-B input res (that's 224). MobileCLIP-S2's 256 is a real native-arch fact, separate from that fallback.

**Higher-res lever for the ground-truth fine-tune:** ViT-B/16 can accept 256/336 via interpolated position embeddings, and our 500px source supports it. During *distillation* it barely helps (ceiling = teacher's 224-res embedding). During the *ground-truth fine-tune* (optimizing true labels, not teacher-matching) training at higher res on the 500px images could genuinely help — test it in the fine-tune sweep.

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
same ~17s (not a WSL issue); channels_last made it worse (UNVERIFIED — our
Jul-22 synthetic test showed channels_last slower, which contradicts the
NHWC-faster-on-Ampere textbook expectation; `bench_fastvit.py` tests it both ways);
torch.compile got ~6s.
FastViT is fast at iPhone Neural Engine *inference* after reparameterization, not
dGPU *training*; Apple trained on clusters; Apple Silicon/MPS would be slower for
training.

**Batch size: the 96 limit is ViT-B-specific, do NOT carry it to FastViT.** The
batch-128→96 fix was for the ViT-B/16 tuning arch (~86M-param transformer, 224px:
batch 128 hit the 10GB VRAM wall → thrash 48 img/s; 96 fit → 314 img/s).
MobileCLIP-S2 is a much smaller model (~35M params) at 256px, so a LARGER batch
(256, maybe 512) may well fit 10GB — but FastViT's overparameterized training
branches make its train-time memory heavier than its param count / inference
footprint suggests, and it runs at 256px (more activations than ViT-B's 224). So
neither "96" nor "256/512" is assumed: **the FastViT re-benchmark above picks the
batch size by measuring**, per the Jul-22 lesson (don't assert VRAM/throughput
without measuring).

---

### Cloud GPU rental (fallback only, if the 3080 can't do the final run)

**Almost certainly NOT needed** — the "need cloud" conclusion rests on the suspect
17s/step number; fix the dataloader (WebDataset + GPU decode) and re-bench on the
3080 first. Renting to mask a dataloader bottleneck would be wrong. Only the single
final MobileCLIP-S2 run is even a candidate; everything else stays on the 3080.

If we do rent, it's a **sub-$20 afternoon, one GPU, not a cluster:**
- **RunPod** — clean UX, per-second billing, Community (cheap) vs Secure (datacenter). Good default for a one-off.
- **Vast.ai** — cheapest (marketplace, supply/demand), slightly more variable.
- **Lambda** — pricier datacenter; **AWS/GCP** — 3-5x, don't bother.
- Rough mid-2026 on-demand: RTX 4090 24GB ~$0.30-0.70/hr; A100 80GB ~$0.67-1.99/hr; H100 80GB ~$1.50-3.29/hr. Spot/interruptible −30-50% if you checkpoint.
- Sizing: full run is ~30h on the 3080; an A100 is ~3-4x faster → ~8-10h → **~$10-20 total** (A100) or ~$3-8 (4090). Rent one GPU for an afternoon, done.

## Adopt upstream training path (option A, decided 2026-07-23)

Our `train_student.py` is hand-rolled: a simple loop + a Dataset that opens 2.6M
individual `corpus/<taxon>/<photo>.jpg` files at random. That random-small-file
I/O is the prime suspect for both the ViT-B "only 314 img/s" and the FastViT
slowness — not the arch. Per the standing rule (adopt proven prior art, don't
hand-roll), route the FINAL runs through Apple's tuned path instead.

**Apple `ml-mobileclip` reality (was cloned in the now-deleted scratch dir; re-clone from github.com/apple/ml-mobileclip if needed):**
their DataCompDR training uses `open_clip_train.main` with `--dataset-type
webdataset` over `.tar` shards, `--precision amp`, `--grad-checkpointing`, and a
`dr/` loader that pulls per-sample teacher *reinforcements* (embeddings) straight
out of the tar. Fast sequential reads, GPU-saturating. BUT their recipe is full
CLIP **contrastive** training (image+text towers, synthetic captions, a general
CLIP teacher's image AND text embeddings, global batch 8192 on 8×4 GPUs, lr 1e-3).

**Two ways to use it:**
- **Option A (CHOSEN): adopt their data FORMAT + dataloader, keep our loss.**
  Repackage corpus + cached BioCLIP-2 embeddings into WebDataset `.tar` shards
  (each sample = image bytes + our 768-d teacher embedding + app taxon idx), use
  open_clip's webdataset dataloader (or adapt Apple's `dr/` loader, which already
  knows how to read an embedding tensor from the tar), but keep our **image-only
  cosine feature-distillation** loss. Gets the big dataloader speedup + a
  better-tuned loop (`--grad-checkpointing --precision amp`) WITHOUT swallowing
  the contrastive recipe or training a text tower.
- Option B (REJECTED): fully adopt DataCompDR contrastive training. Would require
  generating synthetic captions + caching a text-capable teacher, i.e. changing
  our whole method. Wrong for us: our thesis is image-only distillation from
  BioCLIP-2 (the bird expert), and we REUSE BioCLIP-2's text tower zero-shot at
  inference — we don't want to retrain a text tower.

**Steps (all AFTER the current run frees the GPU):**
1. Repackaging script: `corpus/*.jpg` + `embeddings/shard_*.npz` → WebDataset
   `.tar` shards (image bytes + 768-d embedding + taxon idx per sample).
   **Write shards DIRECTLY TO THE NAS** to avoid a 2x local-disk peak (V: vhdx is
   cramped; a naive convert-in-place keeping both copies needs ~524GB). The corpus
   is NAS-bound anyway, so this produces the durable artifact where it's headed.
   Alternative if writing local: shard-and-delete incrementally (pack → verify →
   delete source, ~1-2GB peak overhead) AFTER the corpus is backed up to the NAS.
2. Wire our cosine loss into open_clip's webdataset dataloader (small patch, or
   adapt Apple's `dr/`).
3. Re-benchmark FastViT AND ViT-B through THAT path (true apples-to-apples; expect
   a large img/s jump for both). This supersedes the synthetic bench. **Also verify
   NAS read throughput feeds the GPU** (see below).
4. Run the final MobileCLIP-S2 on the winning batch/recipe.

### Training reads shards from the NAS (verify, don't assume)

Plan: train by STREAMING tar shards from the NAS over 10GbE, keeping only the tiny
~4GB teacher-embeddings + checkpoints local. Clean division: heavy-but-cold JPEGs
on the NAS, light-but-hot artifacts local. This is exactly what WebDataset is for
(sequential shard streaming, same as training off S3).

- **Bandwidth is a non-issue on paper:** ~300 img/s × ~100KB/img ≈ ~30MB/s of raw
  JPEG — trivial for 10GbE (~600MB-1GB/s real) + sequential RAID5 HDD reads.
- **Real risk is latency/contention/seeks, NOT bandwidth:** UNAS Pro is spinning
  rust (4×14TB Exos RAID5). A 20-epoch run reads 262GB×20 ≈ 5TB over the wire.
  WebDataset stays sequential-ish (shard order + shuffle buffer), HDD-friendly, but
  other NAS load (Stash, backups) or a bad shuffle could stall + starve the GPU.
- **The `--real` bench (step 3) MUST measure img/s reading shards from the NAS**
  before committing. If it feeds the GPU: train off the NAS, never copy 262GB
  locally again. If it stalls: fallback = keep a resized/subset of shards on local
  disk (the ~4GB embeddings are already local regardless).

Note: open_clip patch pins are in `ml-mobileclip/training/README.md`
(`open_clip_v2.patch` @ commit 7260a46; v1 @ cf86ee7 for older API).

### Image resolution + JPEG decode in the tar (don't pre-optimize)

The per-step dataloader cost per image is: read bytes → **decode JPEG** → resize →
crop → normalize. The JPEG **decode** is usually the heaviest CPU op (scales with
the encoded pixel count), NOT the resize. Three levers, in order of preference
(measure before applying each — the WHOLE point of WebDataset is fixing
random-small-file I/O, which may already saturate the GPU at full res):

1. **Sequential tar reads (free, do first).** Pack shards at **500px original** and
   benchmark. The win is sequential-vs-2.6M-random-opens, not smaller files; this
   alone may saturate the GPU. Keeps 500px → all future options open.
2. **Faster decoder (no downside, do if still CPU-bound).** Fixes decode without
   touching resolution, so it foreclosures nothing:
   - libjpeg-turbo / Pillow-SIMD backing PIL (drop-in, multi-x faster decode)
   - **GPU JPEG decode** (`torchvision.io.decode_jpeg` on CUDA / nvJPEG) — decode on
     the 3080, relieves the CPU dataloader entirely. WebDataset + GPU decode is a
     known-fast combo.
   - more `--workers` (tomahawk has cores to spare; we run 10)
3. **Pre-resize (LAST resort, permanently discards data).** Only if still
   decode-bound after 1+2. Resize to **~320-384px headroom, NEVER 256**: keeps
   random-resized-crop augmentation room, preserves the higher-res fine-tune lever
   (up to ~336), and avoids baking in a center-crop. Resizing to exactly 256 would
   lock the student input res forever and kill the fine-tune/aug headroom — an
   annoying bake-in to undo (would need re-packing from the 500px corpus, which by
   then may have moved to the NAS). Teacher embeddings are already cached at 224,
   so pre-resize only affects the student input, not target correctness.

## What MobileCLIP's papers say (recipe we can borrow), read 2026-07-23

Read both papers directly (MobileCLIP CVPR'24 arXiv 2311.17049; MobileCLIP2 TMLR'25
arXiv 2508.20691). Their full method is multi-modal *contrastive* (image+text), which
we DON'T do, but the dataset-reinforcement + aug + optimizer backbone transfers
directly to our image-only cosine distillation.

**Their loss (for context, NOT what we use):** `L = (1-λ)·L_CLIP + λ·L_Distill`, where
L_Distill is **KL between the teacher's and student's b×b image-text affinity matrix**
(row-wise softmax of `U·Vᵀ/τ`), averaged over I2T + T2I, over a K-model teacher
ensemble. λ ablation (P1 Tab.3b): **λ=1.0 optimal for ImageNet (pure distillation, no
contrastive), λ=0.7 best for retrieval**; they used λ=0.75 for MobileCLIP-B, **λ=1.0 for
the small variants (S0/S1/S2)**. MobileCLIP2 keeps leaning on pure distillation. Takeaway:
**our λ=1.0 image-only cosine setup is the validated regime for small models** — our
per-sample cosine is the unimodal analog of their affinity-KL. We are not missing the
contrastive term for our use case.

**What we SHOULD adopt (transfers to image-only):**
1. **Cache teacher embeddings once in BF16 + lossless compression** (P1 §5); verified no
   accuracy loss vs fp32. We already cache (fp16 npz) — confirms the approach.
2. **Store multiple augmented-view embeddings per image, with reproducible aug params**
   (store the RandomResizedCrop/RandAugment params, replay the exact crop so the student
   input matches the cached teacher target). **Perf saturates ~5 augmentations** (P1
   Tab.4a); DataCompDR-12M used up to 30 (for reuse across many epochs), DataCompDR-1B
   used 10. **This is a real gap, but it is GATED behind a cheap pilot experiment**
   (reframed 2026-07-24 — see queue): we cache ONE 224 embedding per image, so
   our student can't learn augmentation invariance against matching teacher targets. To
   adopt: during precompute, generate N augmented views per image, embed each, store
   (aug_params, embedding) pairs; at train time replay a stored view.
3. **STRONG augmentation in distillation** (the counterintuitive one): RandomResizedCrop
   scale **[0.08, 1.0]** + RandAugment. P1 Tab.13: **+4.8% IN-val vs vanilla CLIP's weak
   aug.** Weak aug is only needed when image-text alignment matters; in distillation the
   teacher sees the same crop, so strong aug is safe and helps. Our current pipeline uses
   open_clip's default (light) preprocess — switch to strong aug for the sweep.
4. **Optimizer:** AdamW, **β=(0.9, 0.95)**, cosine LR **1e-3 → 1e-6**, **warmup ~2k iters**,
   **weight decay 0.2**, BF16, **grad-clip norm 1.0** (MobileCLIP2). Note their LR 1e-3 is
   for from-scratch training at global batch 8192; we FINE-TUNE from LAION weights at
   batch 96, so our 1e-4 is reasonable, but the sweep should test toward their schedule
   shape (proper warmup + cosine-to-near-zero, β₂=0.95, wd 0.2, grad-clip 1.0).
5. Training scale (their ablation setup): global batch **8192**, **30-45k iters (~20-30
   epochs / ~0.24-0.4B seen samples)** on the 12.8M-pair DataCompDR-12M. Ours: 2.5M imgs,
   ~20 epochs — comparable epoch count, far smaller data.

### Augmentation: why we can't just copy their strong aug (2026-07-24)

**The finding itself is NOT MobileCLIP-specific and DOES apply to us.** Strong aug in
distillation is a property of the training *regime*, not the architecture: in contrastive
CLIP training weak aug is required because heavy crops break image-text alignment, but in
distillation the teacher sees the same crop, so aggressive aug is safe and acts as a
strong regularizer. That reasoning is arch-agnostic — it holds for our ViT-B student even
though we use neither FastViT nor their contrastive loss.

**But it is only sound IF the teacher target matches the student's view.** Their strong
aug works because they cache a teacher embedding PER AUGMENTED VIEW and replay the exact
crop. We cache ONE center-crop 224 embedding per image (`precompute_embeddings.py` uses
open_clip's default eval preprocess). So applying RandomResizedCrop [0.08, 1.0] today
would train the student to reproduce an embedding describing content it can no longer
see — a *corrupted target*, not merely harder data. This is an easy trap: the aug item
reads as immediately adoptable, but it silently depends on the caching item.

**Hence `--aug light`** (RandomResizedCrop scale 0.65–1.0 + hflip): mild enough that the
crop still contains essentially what the cached center-crop target describes, so it is
target-compatible without any re-precompute. `--aug none` remains the default and is
exactly the teacher's view.

**Two reasons the payoff may be smaller for us than their +4.8%:**
- Their gain is measured on ImageNet with models trained largely from scratch at global
  batch 8192 on 12.8M pairs. We FINE-TUNE from LAION weights on 2.5M bird images for ~20
  epochs. Strong aug's biggest wins come when you are data-limited and overfitting; our
  full run plateaued cleanly with no divergence, so we may not be in that regime.
- They cache up to 30 views precisely so a *different* view is seen each epoch. At 5
  views × 20 epochs each view repeats 4×, giving less aug diversity than true random
  cropping — so "perf saturates ~5" (their Tab.4a) is a claim about THEIR setup, not a
  guarantee for ours.

**Therefore: run the cheap pilot aug experiment first** (`--aug none` vs `--aug light` on
500 species), and only pay the ~56 GPU-hours for multi-view caching if that lever moves
the needle.

**What we DROP (multi-modal, inapplicable to single-teacher image-only):** the CLIP
contrastive term, synthetic CoCa captions, text-embedding caching, the K=2 teacher
ensemble (DataCompDR used ViT-L/14 `datacomp_xl_s13b_b90k` + `openai`, 1536-d = 2×768
concat), and per-teacher temperature tuning.

**MobileCLIP2 (2025) deltas vs v1:** better CLIP teacher ensembles trained on **DFN** (→
DFNDR dataset), improved DFN-trained CoCa captioners fine-tuned for caption diversity,
the finding that **contrastive-KD temperature tuning matters**, combining captions from
multiple generators, and new **S3/S4** architectures. +2.2% IN-1k for MobileCLIP2-B vs
MobileCLIP-B. Nearly all of this is on the multi-modal/caption/ensemble side we don't use
— the one transferable meta-lesson is "a better teacher → a better student," which for us
reinforces keeping BioCLIP-2 (SOTA bird encoder) as teacher, and is the same logic behind
the deferred multi-teacher improvement pass.

**Queue impact (fold into pilot experimentation stage):** (a) multi-augmentation embedding
caching, (b) strong aug [0.08,1.0]+RandAugment, (c) optimizer/schedule toward AdamW
β₂=0.95 / wd 0.2 / cosine-to-1e-6 / warmup / grad-clip 1.0. All cheap to test on the
500-sp pilot.

## Session log: 2026-07-24 evening (WebDataset migration + gates)

**Pack completed.** `pack_webdataset.py` wrote **2,502,898 rows -> 251 shards, 252GB**
to `/mnt/nas/WingDex-Distill/wds/` in **62.6 min (666 samples/s)**. Skipped 209
(no cached embedding), 0 missing images. A separate **pilot set** was packed for
cheap sweep iteration: `/mnt/nas/WingDex-Distill/wds-pilot500/`, **247,400 samples,
25 shards, 25GB** (matches the original pilot's usable count exactly).

**Why a separate pilot shard set:** `--pilot-species` only filters the LOCAL-corpus
path; it is silently ignored in `--wds` mode. And the top-500 species are SCATTERED
across taxon order, so train-time filtering would read all 2.5M samples to use ~10%.
`pack_webdataset.py --pilot-species N` now exists for this.

### Throughput: the dataloader was A bottleneck, but not THE ceiling
- WebDataset loader alone, reading from the NAS: **~640 img/s** (vs ~306 for the old
  random-small-file loader) = **2.1x**.
- But end-to-end *training* is still **~302-320 img/s**, i.e. unchanged.
- Conclusion: **we are now GPU-bound, not I/O-bound.** The random-small-file loader
  was real overhead but was NOT what capped ViT-B at ~314 img/s; the 3080's
  forward+backward is. This reframes the SSOT's original hypothesis. Expect the
  WebDataset win to matter much MORE for FastViT/MobileCLIP (cheaper per-image
  compute -> more I/O-hungry).
- NAS throughput is therefore a non-issue for ViT-B: spinning rust feeds the GPU fine.

### BUG FOUND + FIXED: the wds val split was measuring ~3% of species
`train_student.py` originally held out the LAST shard for validation. But shards are
packed in TAXON ORDER, so one shard covers only a handful of species -- **measured:
the held-out pilot shard had 15 of 500 species**. Every sweep run would have had its
`val_cos_sim` computed on ~3% of the species, silently invalidating the LR rankings.
**Fixed:** train and val now read the SAME shards, separated by a deterministic
blake2b hash of the sample key. Verified on the pilot set: val_frac **0.0202**,
**496/496 species covered (100%)**, **4,948 val samples** -- which exactly matches the
original local-corpus pilot's val size, so numbers are directly comparable again.
No repacking was needed; this is purely a read-time selection change.

### DATA QUALITY FINDING: 1,368 duplicate photo_ids in the manifest
`train_manifest.parquet` has **2,503,107 rows but only 2,501,739 distinct photo_ids**
= **1,368 duplicate rows** (the same photo filed under MORE THAN ONE taxon; e.g.
photo_id 4508957 appears under both taxon 4335 and 4327). Consequences:
- The packer counts rows written; a tar counts distinct keys, so duplicates collapse
  and the two counts legitimately differ. `verify_shards.py --max-dup-gap` tolerates
  this; a larger gap would be real data loss.
- Comparing a packed `.cls` row-by-row against the manifest falsely flags duplicates,
  so the check now compares against the SET of taxa valid for that photo_id.
- **These duplicates were also in the original training run**, so ~1,368 of 2.5M
  images (0.05%) were trained under two different taxon labels. Negligible in impact,
  but real -- worth deduping the manifest before any future re-pack.

### Environment: uv replaces the old venv
The old venv (`~/spikes/bioclip-birdid/.venv`) had absolute paths baked into its
shebangs, so it could not be moved -- which blocked deleting the spikes scratch dir.
Rather than sed shebangs (fragile: packages also bake absolute paths into console
scripts, `.pth` files and extension RPATHs; `virtualenv --relocatable` is
semi-deprecated for exactly this reason), it was recreated with **uv** under the repo:
`ml/distill/pyproject.toml` + `uv.lock` (58 packages resolved in 829ms), venv at
`ml/distill/.venv` (gitignored). Verified: torch 2.6.0+cu124, CUDA available, RTX
3080 detected, versions identical to the old env.
**Gotcha:** torch cu124 wheels are NOT on PyPI, so `tool.uv.index` +
`tool.uv.sources` pin torch/torchvision to the pytorch cu124 index explicitly.
Without that, uv silently resolves the CPU build and CUDA disappears.

### Tooling note (why no W&B/Optuna/Hydra)
`run_experiments.py` runs the experiment matrix as a plain sequential loop over a JSON
spec. W&B Sweeps / Optuna / Hydra / MLflow are the real prior art and are worth it for
parallel workers, distributed trials, or Bayesian search over a large space -- we have
ONE GPU and a 5-run grid, so they would add a service dependency and a failure mode to
replace a for-loop. What WAS borrowed from them: structured per-run results,
resumability (a crash on run 4 does not restart the queue), a gpu-busy guard, and a
hard stop after N consecutive failures.

## Pilot sweep results (2026-07-25) — recipe DECIDED

Six runs on the 500-species pilot shard set, ~16h unattended. Design was a chain of
one-factor-at-a-time comparisons (NOT a factorial), each pair differing by exactly
one thing. Full per-run logs in `runs/exp*/train.log`; queue state `/tmp/expq_status.json`.

| run | best val_cos | peak ep | drift | notes |
|---|---|---|---|---|
| exp3 newrecipe + aug light, 15ep | **0.9512** | 15 | no | still climbing at ep15 |
| exp5 lr 7e-5, 8ep | 0.9483 | 8 | no | LR sweep winner |
| exp6 lr 5e-5, 8ep | 0.9475 | 8 | no | |
| exp2 newrecipe, 15ep | 0.9464 | 12 | YES | |
| exp4 lr 1e-4, 8ep | 0.9463 | 8 | no | LR sweep control |
| exp1 baseline old recipe, 15ep | 0.9447 | 12 | YES | foundation check |

**exp1 VALIDATED THE FOUNDATION.** 0.9447 vs the original local-corpus pilot's 0.9465
= 0.0018 gap, within noise. The WebDataset shards + loader reproduce the known result,
so everything downstream is interpretable **and the local corpus is safe to delete.**

### The three comparisons

- **RECIPE (exp1 → exp2): +0.0016.** Real but marginal. The MobileCLIP2 bundle
  (wd 0.1→0.2, beta2 0.999→0.95, warmup 500, grad-clip 1.0, min-lr 1e-7) helps a
  little. Both still peak ~ep12 and drift after. ⚠️ This tested the BUNDLE, not
  individual knobs — an ablation isolating wd (0.1 vs 0.2) is worth one run, since wd
  is a real regularization change rather than a stability tweak and may account for
  most of the gain on its own.
- **AUG (exp2 → exp3): +0.0048 — the biggest single lever, and the shape matters more
  than the number.** exp3 was STILL CLIMBING at ep15 (+0.0002 on the final step) while
  exp1/exp2 plateaued at ep12 and declined. And exp3's train_loss is far HIGHER
  (0.0369 vs 0.0236) with BETTER val: textbook regularization, fitting the train set
  less and generalizing more. **The late-epoch overfit drift is gone.** Two direct
  implications: (a) light aug should be in the locked recipe, (b) exp3 was
  epoch-limited, so a longer run at aug light would likely gain more.
- **LR (exp4/5/6, 8ep): 7e-5 wins** (0.9483 vs 0.9463 @1e-4, 0.9475 @5e-5). Confirms
  the SSOT's long-standing hypothesis. Note 7.5e-5 is almost exactly the
  linear-scaling value for batch 96 if 1e-4 was tuned for batch 128 — i.e. the
  never-rescaled LR really was slightly hot.

### Recommended locked recipe
`--lr 7e-5 --wd 0.2 --beta2 0.95 --warmup 500 --grad-clip 1.0 --min-lr 1e-7 --aug light`
plus MORE epochs than 15 (aug light had not converged).

### ⚠️ Caveats before over-trusting this
1. **These are val_cos deltas of 0.002–0.005 on a leakage-biased metric** (~54% of val
   images come from multi-photo observations). The ship metric is NABirds retention;
   small cosine gaps can vanish downstream. **The winning checkpoints should be run
   through `eval_nabirds.py` before the recipe is truly locked.**
2. **UNTESTED INTERACTION: aug light × lr 7e-5.** exp3 used lr 1e-4; the LR sweep ran
   with aug none. Stronger aug typically wants MORE LR, not less, so the two winners
   may not simply compose. One confirmation run (aug light + 7e-5, 15+ epochs) is the
   obvious next experiment.
3. The LR sweep ran at 8 epochs while the aug/recipe comparisons ran at 15, so LR
   rankings are short-horizon and should be re-confirmed at full length.

### Follow-on queue
- [ ] confirmation run: aug light + lr 7e-5, 20–25 epochs (tests the interaction AND
      the "aug light hadn't converged" hypothesis in one run)
- [ ] NABirds eval on exp3 + the confirmation run — the real verdict
- [ ] one-run ablation: wd 0.1 vs 0.2 at otherwise-fixed new recipe
- [ ] only if light aug keeps winning: reconsider the ~56 GPU-hour multi-view
      embedding caching that would unlock TRUE strong aug ([0.08,1.0]+RandAugment)

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

### Cosine vs retention: don't confuse the two (they mean very different things)

- **`val_cos_sim` is NOT "% as good as the teacher."** It's the geometric alignment of
  768-d unit embeddings, and its relation to accuracy is nonlinear/saturating. Read the
  RESIDUAL `(1-cos)`, not cos itself: pilot final 0.9464 → residual 0.054; full-run ep1
  0.9313 → 0.069, ep10 0.9573 → 0.043. So ep1→ep10 = ~38% embedding-error reduction (not
  "2.8% better"); pilot-peak 0.9472→0.9573 = ~19% error reduction. Congeneric species sit
  <0.02 apart in text-embedding space, so the last hundredths of cosine are where
  fine-grained species discrimination is won/lost.
- **RETENTION IS a real "% as good as the teacher"** — it's a ratio of measured
  accuracies. Pilot NABirds: teacher 91.5 top-1, student 90.8 → 90.8/91.5 = **99.2%
  retention** (top-5: 97.2/99.7 = 97.5%). Caveats: it's retention OF the teacher (teacher
  itself ~91.5% correct, so student ~90.8% absolute), and the pilot number was only 282
  NABirds imgs (full run → much bigger intersection, tighter number).
- **Mental model:** cosine = fuzzy training-progress proxy; retention (on clean OOD
  NABirds) = the trustworthy ship metric. "Is epoch-1 already usable?" is UNANSWERABLE
  from cosine — only the accuracy eval answers it (see multi-checkpoint experiment in
  queue).

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

**This fine-tune is a WingDex extension, NOT prescribed by MobileCLIP** (confirmed
2026-07-23 by reading both papers). MobileCLIP v1 reports all metrics "without any
fine-tuning" — their paradigm is distill → zero-shot, done. MobileCLIP2's fine-tuning
is about their CoCa *captioner* teacher, not the CLIP student; the only student
fine-tuning is (a) a one-line acknowledgment that CLIP encoders can be specialized
via linear-probe / full fine-tune (citing Wortsman et al. 2022) and (b) dense-
prediction downstream evals (detection/segmentation), not classification accuracy.
So "distill a bird CLIP then supervised-fine-tune on species labels to beat the
teacher" is our own bet. The closest PUBLISHED handbook for it is the CLIP
fine-tuning literature, esp. **Wortsman et al. "Robust fine-tuning of zero-shot
models" (WiSE-FT, CVPR 2022, arXiv 2109.01903)** — READ IN FULL 2026-07-23:

- **Problem it solves:** naive fine-tuning raises in-distribution accuracy but
  DEGRADES OOD robustness (exactly our risk: fine-tune on iNat → better on iNat,
  worse on real field photos). Validated on WILDS-iWildCam (wildlife recognition),
  directly analogous to birds.
- **Method, 2 steps:** (1) standard fine-tune the zero-shot model on target data
  (cross-entropy + weight decay; end-to-end OR linear-probe-only); (2) **weight-space
  ensemble**: `θ = (1−α)·θ_zeroshot + α·θ_finetuned` — element-wise average of the two
  models' WEIGHTS (not outputs). A few lines of PyTorch, zero extra train/infer cost.
- **α = 0.5** recommended with no domain knowledge; near-optimal across experiments
  (they sweep α ∈ {0, 0.05, ..., 1}). Gains: +4-6pp OOD vs prior work, +1.6pp
  ImageNet; WILDS-iWildCam +6.2pp OOD at ≤0.3pp reference cost.
- **CRITICAL nuance for us:** WiSE-FT interpolates a fine-tuned model with ITS OWN
  zero-shot start (they must share an optimization basin; interpolating unrelated
  nets fails). Our "zero-shot start" is the DISTILLED STUDENT. So (a) fine-tune FROM
  the distilled checkpoint (never reinit), and (b) ensemble = distilled-student ↔
  its-fine-tuned-version. Keeps the teacher-embedding geometry (BioCLIP-2 text
  classifier still works) while gaining ground-truth accuracy.
- Cited by MobileCLIP2 as THE reference for specializing CLIP encoders → right
  handbook, not a tangent.

**Prereq not built yet:** a sampler script (alongside `download_inat.py`) that
pulls research-grade photos EXCLUDING observation_uuids already in our manifest
(~100/species by observation) → the leak-free held-out ground-truth set.

## Observation-level leakage + dedup (verify early; two sides of one issue)

iNat groups multiple photos per **observation** (one encounter with one bird: burst
frames, same perch/light, near-duplicates). Our manifest carries `observation_uuid`
per photo. This creates two related problems:

**(A) EVAL leakage — MEASURED 2026-07-23, real but bounded (NOT the ship metric):** the
2% val split in `train_student.py` splits **by photo**. Measured on the 2.5M manifest:
2,503,107 photos / 1,588,150 observations = **avg 1.58 photos/obs**. 45.6% are
singletons (no leakage possible); 54.4% are from multi-photo obs. Distribution: 1.14M
obs×1, 240K×2, 106K×3, 69K×4-5, 26K×6-10, only 5,350 (0.3%)×>10, max 165. So NO huge
bursts — typical obs is 1-2 photos. BUT with random by-photo split, ~every multi-photo
val image has a train sibling (~98% each), so **~54% of val photos are "leaked" →
val_cos_sim is optimistically biased.** Impact is limited because: (1) the SHIP metric
is NABirds/CUB/RealBirdID (foreign datasets, zero shared photos, leakage-IMMUNE — the
pilot's 99.2% retention was clean); (2) val_cos is just a training-progress monitor,
not ship accuracy; (3) for retention the bias partly cancels (teacher+student both
scored on the same set). **VERDICT: not scary for go/no-go, but treat val_cos as a
loose upper bound. The ground-truth held-out eval (which COULD drive go/no-go) MUST be
split by observation_uuid** — already specified in the sampler prereq above.

**(B) TRAINING variety — MEASURED 2026-07-23 (corrected). Cheap dedup not worth it;
backfill dedup is a real-but-costly option for common species.** Three numbers to keep
straight: (1) ~**52M** research-grade photos AVAILABLE on iNat; (2) **2,646,057
DOWNLOADED** (`manifest.parquet`), where **3,871 / 7,555 species (51%) hit the 500
cap**; (3) **2,503,107 TRAINED** (`train_manifest.parquet`, after ShareAlike
exclusion), where only 11 remain at exactly 500 — SA-removal shaved the capped species
below 500, so "11 at cap" is a post-SA artifact and MISLEADING about whether the cap
binds. At download time the cap bound for HALF the species.

But even the 3,871 capped species are already observation-diverse: avg **323 distinct
observations** (min 78) at **1.58 photos/obs**. Of their 1.94M photos, **82.3% are
already within 2/obs; only 17.7% (343K) are burst-excess** (3rd+ from one obs).
Implications:
- **Cheap reselection dedup: NOT worth it.** Dropping burst-excess just shrinks capped
  species 500→~460 avg (loses data) without adding observations, and hits the 1,132
  rare 50-99-photo species if applied globally. 323 obs/species is already diverse.
- **Backfill dedup (real option, COSTLY):** for the 3,871 capped species, drop the
  17.7% burst-excess AND download+embed fresh distinct observations to refill to 500.
  This genuinely raises observation diversity, but needs NEW downloads + GPU embedding
  (those species already hit the cap, so the replacement photos aren't on disk).
  Consider ONLY if the pilot shows common (capped) species underperforming.

(Observation grouping still matters for the eval split — see (A) — independent of this.)

---

## Licensing (SHIP GATE — read before release)

**CONTEXT THAT CHANGES EVERYTHING (2026-07-23):** (1) The <25MB target is a **WEB**
constraint (Cloudflare static asset the browser downloads), NOT iOS. iOS bundle size is
a non-issue (apps are routinely 100s of MB); iOS only cares about SPEED, and BioCLIP-2
ViT-L int8 (307MB) already **runs fine on the iPhone Neural Engine** (prior finding). So
iOS is essentially solved with clean weights (ship BioCLIP-2 or the LAION ViT-B) — the
small model is fundamentally a WEB play. (2) **WingDex is non-commercial** (no sales/ads/
subs, zero revenue), which may or may not clear Apple's "Research Purposes" terms — see
below.

Three components, each its own license:

**1. BioCLIP-2 teacher — CLEAN (MIT).** ViT-L/14 pre-trained on LAION-2B, then
TreeOfLife-200M. Distilling its knowledge + redistributing is fine w/ attribution. ✅

**2. Training data — CLEAN (handled).** Openly-licensed iNat; ShareAlike excluded for MIT
release; ATTRIBUTIONS.md bundled at release. ✅

**3. MobileCLIP-S2 — the only issue, and only for the WEB small-model:**
- Architecture/code (`LICENSE`): **MIT** — the arch is fine. ✅
- Pretrained weights (`LICENSE_MODELS`): **"Research Purposes" only**, defined as
  "non-commercial scientific research... does not include any commercial exploitation,
  product development or use in any commercial product or service." "Model Derivatives"
  includes retraining/fine-tuning → a student init'd from Apple weights inherits this.
- `datacompdr` = Apple's pretrained MobileCLIP-S2 weights (the restricted init).
- **CONFIRMED: no non-Apple MobileCLIP-S2 checkpoint exists** (open_clip registry:
  `MobileCLIP-S2->['datacompdr']`, `MobileCLIP2-S2->['dfndr2b']`, all Apple).

**Does WingDex's non-commercial status clear Apple's terms? AMBIGUOUS — don't assume.**
- FOR: no money made → arguably not "commercial exploitation" / not a "commercial product
  or service."
- AGAINST: the terms ALSO exclude "product development" and "use in any... product"
  (listed separately from "commercial"). A shipped App Store app — free or not — with a
  trademark (WingDex®) reads like "product use," not the papers/experiments the
  "Research Purposes" language seems aimed at.
- This is a genuine legal-interpretation call, NOT resolvable by vibes. (Written by an AI
  reading a license, not a lawyer.) DE-RISK: email Apple ML re: a commercial/product-use
  path (these research licenses sometimes have a "contact us" clause) before depending
  on it.

**⚠️ CONFIG NOTE:** `train_student.py` defaults to `--pretrained datacompdr` (Apple's
restricted weights). FINE for research/measurement experiments (e.g. the stock-MobileCLIP
baseline), but the SHIPPING config must not use it unless the non-commercial question is
resolved in our favor. Current ViT-B run is clean (`laion2b_s34b_b88k`).

**Decision tree:**
- **iOS:** ship BioCLIP-2 ViT-L int8 or the clean LAION ViT-B — CLEAN, size irrelevant,
  Neural Engine handles it. No Apple-weights question at all.
- **Web, if we even need a small on-device model:** the ORIGINAL plan was **"web keeps
  GPT"** — if that holds, the whole MobileCLIP-S2 question is OPTIONAL/future, not
  blocking. If we DO want on-device web: (a) resolve the non-commercial question with
  Apple, OR (b) train FastViT from random init (costly, ~$200-500 + data pipeline), OR
  (c) use a small open-weights arch (unscouted — see below), OR (d) ship the LAION ViT-B
  (~45MB, clean, misses <25MB but works).

### What it takes to build a LAION MobileCLIP-S2 ourselves (analysis 2026-07-23)

"Reproduce Apple's MobileCLIP-S2 pretraining on open data so the weights are
commercially clean." Real research-scale effort, NOT a quick job:

- **Compute:** Apple's efficient recipe (DataCompDR-12M) = 8×A100-80GB × 30-45k iters
  (~20-30 epochs), roughly ~1 A100-week-equivalent per model. On rented cloud (8×A100 ~
  $10-15/hr) that's **low hundreds of dollars ($200-500 ballpark)** per run, not the
  $10-20 casual figure. Their SOTA recipe (DataCompDR-1B, 256×A100 × 200k iters) is
  cluster-scale, out of reach.
- **Data pipeline is the real burden, not just GPU:** to match MobileCLIP-S2 quality you
  need EITHER (a) plain LAION CLIP training — simpler but Apple showed plain training is
  **10-1000× less sample-efficient**, so far more seen samples / much longer/costlier; OR
  (b) reproduce DataCompDR-on-LAION — build the reinforced dataset first: generate
  synthetic captions (CoCa over millions of imgs) + cache 2×ViT-L teacher-ensemble
  embeddings over the whole set. That's GPU-DAYS of preprocessing BEFORE training. Apple
  open-sourced the code (`ml-mobileclip-dr`) but the compute is on us.
- **Data volume:** multi-TB LAION subset (12M pairs min, ideally more) — dwarfs our 262GB
  bird corpus. Download + storage + management overhead.

**KEY INSIGHT — don't build a general LAION MobileCLIP-S2 as a separate step.** If we're
spending that compute training a FastViT from random init anyway, fold the BIRD
distillation INTO that run: train FastViT from random directly toward BioCLIP-2's bird
embeddings (= option 1 above), skipping the general-LAION-pretraining stage entirely.
Same cost bucket, ONE run instead of two, yields a bird model directly. Building a
*general* LAION MobileCLIP-S2 first only makes sense if we wanted a reusable general
checkpoint for other uses — we don't, we only want birds. So "build LAION MobileCLIP-S2"
and "train FastViT-from-random for birds" collapse into ~the same expensive job, and the
latter is more direct. Neither is worth it unless <25MB is non-negotiable.

### Open-weights small-arch scout (2026-07-23) + quantization reality

**Quantization can't rescue a big model for web.** Measured on BioCLIP-2 ViT-L: fp32
1217MB → fp16 609MB → int8 307MB (accuracy preserved) → int4 254-280MB but accuracy
COLLAPSED to 78/87 (GPT-level; 4-bit rounding erased fine-grained species margins).
int8 is the sweet spot; int4 breaks bird ID AND only gives ~1.2x beyond int8. Web needs
307→25MB = 12x; quantization is only 2-4x. So size is an ARCHITECTURE (param-count)
problem — quantize a SMALL model to get tiny, can't quantize a big one down.

**Scouted open_clip registry for small archs with NON-Apple open weights** (visual
encoder params, measured):
- ViT-B/16 (our current, LAION): 86.2M, ~45MB int8 (real export) — the <86MB fallback.
- ViT-B/32 (LAION/DataComp): 87.8M — same size, bigger patch, weaker. No win.
- convnext_base_w (LAION): 88.2M — same ballpark. No win.
- **RN50 (OpenAI): 38.3M, ~38MB int8** — the ONLY off-the-shelf option meaningfully
  smaller than ViT-B WITH clean weights. Older CNN, likely weaker at fine-grained; less
  training data than LAION. Legit clean candidate worth a distillation test if we want
  <45MB clean.
- SigLIP/SigLIP2: only SO400M (400M, huge) or B-size — no small variants. No help.

**Verdict: there is NO open-weights CLIP <25MB.** Everything genuinely tiny
(MobileCLIP-S0/S1/S2, ~15-20MB) is Apple-only (license question). The open ecosystem's
floor is RN50 (~38MB). So for a CLEAN <45MB web model: RN50 is the candidate; for <25MB:
Apple weights (non-commercial question) or train-from-scratch, no way around it.

### THE LIKELY ANSWER: one clean ViT-B, int8 for iOS, int4 for web (2026-07-23)

**Web is a FUN FLEX, not a product requirement (John, 2026-07-23):** nobody uses the web
app; the point is to say "we did WebGPU/WASM on-device CLIP inference client-side" vs just
calling GPT. So the <25MB target is NOT sacred and web accuracy barely matters. Don't
over-engineer int4. Options are both fine: ship the int8 ViT-B (~45MB) to web too (still a
legit "runs in your browser, no server" flex), OR do int4 (~22MB) because getting a tiny
CLIP running in WASM/WebGPU is itself the fun part (accuracy drop = who cares, it's a demo).
The `ml/demo/` WebGPU router currently loads BioCLIP ViT-L at 307MB (rude); swapping in our
own 45/22MB model makes the flex actually pleasant. Priorities: **iOS = real product
(accuracy matters); web = engineering flex (shipping it at all is the payoff).**

**WHERE THE 25MB NUMBER COMES FROM (updated 2026-07-23):** it's the **Cloudflare 25 MiB
per-asset limit** (26.2 MB decimal) — applies to BOTH Pages AND Workers Static Assets
(CF's Sep-2025 change raised asset COUNT, not the per-file 25 MiB, which "remains
unchanged for all customers"). WingDex migrated Pages→Workers (for free observability), but
the per-file limit is identical. **HOWEVER the constraint is now basically MOOT:** WingDex
already uses **R2**, so ">25MB forces you to R2" is a non-issue — R2 is already in the stack,
egress is free, no new setup/cost. So a 45MB int8 model served from R2 to both web+iOS is
totally fine. **The <25MB target is therefore OPTIONAL** — purely "a sub-25MiB int4 can be
a plain free static asset (no R2 hop) which is a slightly cleaner flex," NOT a real
requirement. Could just serve the better-accuracy 45MB int8 from R2 everywhere and skip
int4 entirely.

**BUT there IS one real reason to still want <25MiB (John, 2026-07-23): abuse-proof free
serving.** Workers static assets are "free and unlimited" (no per-request, no storage
cost) — structurally impossible to bill, even if a bad actor hammers millions of
downloads. R2 reads are METERED (Class B, $0.36/M after 10M/mo free) — free at normal
traffic, but a malicious download-flood COULD push past the free tier into real charges.
So <25MiB (int4 as a Workers static asset) removes an attack-surface cost vector: "can't
be griefed into a bill" beats "won't bill under normal use." For a hobby project you don't
want to babysit, that's a legit reason to hit the target. (Both paths are $0 at normal
scale; the difference is only under abuse.)

The pipeline that sidesteps ALL the Apple/MobileCLIP licensing drama:
1. Take the current LAION-init ViT-B/16, distill BioCLIP-2 bird knowledge in, THEN
   WiSE-FT ground-truth fine-tune to make the **int8 as good as possible** (goal: match
   or beat teacher on real bird accuracy).
2. **iOS: ship that int8 (~45MB).** Clean, fast on Neural Engine, size irrelevant. Solid.
3. **Web: quantize the SAME fine-tuned model to int4 (~22MB).** Clean, hits <25MB.

**Reframe on the int4 accuracy risk (John, 2026-07-23):** the int4 "collapse" I kept
citing was BioCLIP-2 ViT-L dropping 87→78 on OUR 27-img golden set, i.e. **down to ~GPT
(gpt-5.4-mini = 83/87) level.** But GPT-level accuracy that runs INSTANT + OFFLINE +
FREE + 22MB is a genuinely GOOD product — the on-device motivation was speed/offline/free,
NOT beating GPT on accuracy. So the acceptance bar for the web int4 model is **"useful
(~GPT-level is fine)," NOT "matches BioCLIP."** Do the fine-tune-int8-first-THEN-quantize
order so int4 falls from a higher starting point.

**Still worth MEASURING (not assuming):** how far int4 drops OUR fine-tuned ViT-B
(smaller models can quantize worse than the ViT-L we tested; fine-tuning may add
robustness). Levers if naive int4 disappoints: mixed precision (int8 sensitive layers +
int4 rest), better calibration. But even a meaningful drop likely lands in "still useful,"
not "broken." Worst realistic case: web = GPT-level-but-instant/offline/free. Best case:
near-teacher at 22MB. Either way web is served from our OWN clean model — no Apple, no
MobileCLIP, no from-scratch training.

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

## Where things live (✅ consolidated 2026-07-25)

**ONE directory: `~/wingdex/ml/distill/` on tomahawk.** The scratch dir
`~/spikes/bioclip-birdid/` is GONE, and so is the Pi checkout. There is no
sibling copy, no symlink farm, and no drift risk left. Heavy work runs on
tomahawk (RTX 3080).

- **Code + docs:** this git repo, branch `bioclip-distill`. GitHub
  (`jlian/wingdex`) is the durable record — push there; it is readable even when
  tomahawk is asleep.
- **Env:** `ml/distill/.venv`, managed by **uv** from the committed
  `pyproject.toml` + `uv.lock` (58 packages). Rebuild anywhere with `uv sync`.
  Gotcha: torch cu124 wheels are not on PyPI, so `tool.uv.index` +
  `tool.uv.sources` pin torch/torchvision to the pytorch cu124 index — without
  that uv silently resolves the CPU build and CUDA disappears.
- **Data (~40GB, all gitignored):** `runs/`, `embeddings/` (3.9GB, 366 shards of
  cached teacher embeddings), `nabirds/` (9.5GB OOD eval set), `nabirds_meta/`,
  the manifests, `taxonomy.json`, attribution records, and `logs/`.
- **Training data:** WebDataset shards on the NAS —
  `/mnt/nas/WingDex-Distill/wds/` (251 shards, 252GB, 2,502,898 samples) and
  `/mnt/nas/WingDex-Distill/wds-pilot500/` (25 shards, 25GB, 247,400 samples).
- **Backup:** `/mnt/nas/WingDex-Distill-Backup/20260724/` holds checkpoints,
  embeddings, manifests, nabirds and attributions.
- **Phase-0 spike artifacts:** `ml/spike/` — 16 scripts + 162 embedding fixtures
  for John's own bird photos, committed 2026-07-25 because they existed ONLY in
  the scratch dir and are the provenance for the spike findings quoted above.

**The 262GB loose `corpus/` was DELETED 2026-07-25**, gated on exp1 reproducing
the known pilot baseline off the shards (0.9447 vs 0.9465). Every image lives in
the shards byte-identically (`pack_webdataset.py` copies jpg bytes verbatim;
gate 1b verified all 251 shards), and it is re-downloadable from iNat Open Data
via `pull_images.py`. Freed 261GB; WSL disk went 391GB → 92GB used.
`eval_heldout.py` was ported to read from shards (`--wds`) first, so nothing
depends on loose files any more.

Note: compacting `V:\WSL\ext4.vhdx` is OPTIONAL. V: exists only to host the
vhdx, so free space there has no other consumer; what matters is that the
dynamic disk never needs to grow past V:'s 477GB, and deleting the corpus freed
~262GB *inside* the filesystem that WSL will reuse before expanding the file.

History: scripts were briefly split across `bioclip-birdid` and `bioclip-distill`
branches (consolidated 2026-07-22); five separate ml docs were merged into this
file 2026-07-23; the Pi checkout was deleted and the scratch scripts symlinked
2026-07-24; full consolidation into one directory 2026-07-25.


### T3 RESULTS (2026-07-30) — WiSE-FT investigated properly

**T3.1 — the interpolation is CORRECT.** `t3_wise_verify.py`: alpha=1.0
reproduces the fine-tune bit-for-bit (max abs diff 0.000e+00), alpha=0.5 equals
the analytic midpoint exactly, 154/154 tensors moved during fine-tuning, none
frozen or excluded from the merge. So any weird curve shape is a real finding,
not an arithmetic bug. Settled.

**T3.2 — WiSE-FT DOES help, the earlier "it's useless" call was WRONG.**
The 3-point sweep (0.50/0.75/1.00) missed the peak. Filling in 0.25 and 0.90:

  base 01: 0.25->85.86  0.50->88.42  0.75->89.69  **0.90->89.93**  1.00->89.77
  base 02: 0.25->83.20  0.50->86.40  0.75->88.19  **0.90->88.46**  1.00->88.26

alpha=0.90 beats alpha=1.00 on BOTH bases (+0.16, +0.20). Small, but it appears
independently at the same alpha on two separate runs, so it is a real peak.
Optimum is ~0.9, not the paper's ~0.5 — a milder version of the same effect,
consistent with our fine-tune data and eval both being birds (mild shift ->
less to recover).
**NEW SHIP CANDIDATE: base 01 @ alpha=0.90 = 89.93 NABirds** (teacher 86.41,
retention 104.1%). Beats the old dirty-run 89.45.

**T3.3 — the bird-only eval WAS hiding catastrophic forgetting.**
Imagenette (10 general non-bird ImageNet classes, 500 imgs), zero-shot through
a head built in the student's own laion2b 512-d space:

  base 01: 0.00->17.4  0.25->17.4  0.50->15.0  0.75->11.6  0.90->9.8  1.00->9.4
  base 02: 0.00->10.4  0.25->10.4  0.50->11.4  0.75->13.4  0.90->14.0  1.00->13.6

base 01 collapses MONOTONICALLY, -8.0 pts, losing ~half its general capability.
On birds the same sweep spans +4 pts UPWARD; here it is 8 pts DOWNWARD. So
fine-tuning IS destroying general knowledge exactly as WiSE-FT predicts, and
NABirds is structurally blind to it. Hypothesis confirmed.

⚠️ **UNEXPLAINED: base 02 runs BACKWARDS** (10.4 -> 14.0, rising with alpha) and
starts 7 pts BELOW base 01. Two bases, opposite signs, on the same eval. No
explanation yet. Do not build on the base-02 general numbers until understood.

⚠️ **Caveat on all T3.3 numbers:** 17.4% top-1 on 10 classes is barely above the
10% chance floor, and top-5 ~60% on 10 classes is near-meaningless. These are
bird specialists distilled from a bird specialist; they were never general. The
RELATIVE collapse is the signal, the absolute values are not. n=500 implies
roughly +/-1.7pt noise, which base 02's wiggles sit inside; base 01's 8-pt slide
does not.

**Product implication:** WingDex will be poor on non-bird photos at EVERY alpha
(dogs, leaves, thumbs -> confident nonsense). Argues for an abstention gate. We
already have the bird-side numbers: alpha=0.75, conf>=0.5 -> 88.4% coverage at
95.18% accuracy. NOT YET MEASURED: what that gate does to non-bird inputs, which
is the actual product requirement (reject them). Obvious next task.

**Method note:** `Student.forward()` projects 512->768 to match the BioCLIP-2
teacher. For a general-space eval you MUST use `model.visual(x)` directly, or you
get a 768x512 shape mismatch. Cost one crashed run.

### T4 RESULTS (2026-07-30) — does the confidence gate reject non-birds? YES

Every abstention number we had was measured on NABirds, where every image IS a
bird, so the gate had never been asked to reject anything. A 3,850-way bird
softmax has no "none of these" class, so the open question was whether a dog
photo produces low confidence (good) or confident nonsense (bad).

Imagenette (500 non-bird images) through the SAME bird classifier + confidence
path as eval_nabirds.py. Pass rate = % of non-bird photos the gate lets through
(= false accepts, lower is better):

  alpha      pass@0.3  pass@0.5  pass@0.7  pass@0.9   mean conf
  0.00 (base)    3.6%      0.8%      0.0%      0.0%      0.0854
  0.50           4.4%      1.6%      0.8%      0.0%      0.0882
  0.75           5.6%      2.0%      1.0%      0.0%      0.1003
  0.90 (ship)    7.4%      2.4%      0.8%      0.2%      0.1087
  1.00           7.2%      2.2%      0.2%      0.2%      0.1052

**At the ship candidate (alpha=0.90, thr 0.5): 2.4% of non-birds pass, vs 88.4%
of real birds.** ~36x selectivity, from a model never trained to detect birds.
At thr 0.7: 0.8% non-bird leakage while bird coverage is still ~75%.

Mechanism: mean confidence on non-birds is 0.109. A dog resembles none of the
11,167 species, so similarity is diffuse and no class wins the softmax. The
"no none-of-these class" concern does not bite.

**DECISION: ship the existing confidence gate at thr 0.5. No separate
bird/not-bird detector needed.** Open product question resolved.

Secondary finding: fine-tuning slightly WORSENS non-bird rejection
(0.8% -> 2.4% leakage from alpha 0 to 0.9), monotonic and consistent with the
T3.3 general-knowledge collapse — a more bird-specialized model is marginally
more willing to force a bird label onto anything. Magnitude is trivial.

⚠️ **Caveat: Imagenette is EASY negatives** (churches, chainsaws, gas pumps).
Real WingDex failure cases are hard negatives: blurry branches, squirrels, a
leaf at bird scale. 2.4% is a FLOOR, not a guarantee. A real hard-negative set
would be needed for a shippable confidence number.
