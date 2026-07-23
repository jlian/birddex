# Method & Results: BioCLIP-2 → small bird-ID student

This documents *what* we did, *why* it works, and *what we got*. Companion to
`README.md` (which tracks the pipeline/phases). Written for the eventual Phase-4
writeup and so the reasoning survives.

## The problem

WingDex needs on-device (iOS + browser) bird species ID. The best open teacher,
**BioCLIP-2** (ViT-L/14, ~428M params, ~1.7GB), is far too big to ship on a
phone. GPT-4.1-mini vision (the current WingDex identifier) is accurate (~83/87
top-1/5 on our golden set) but is a paid API call per photo, needs a network
round-trip, and gives no calibrated "I'm not sure" signal. We want a small
(<25MB stretch / <86MB fallback), fast, offline model that keeps most of
BioCLIP-2's accuracy AND can abstain when unsure.

## The approach: feature distillation into the teacher's embedding space

Standard knowledge distillation copies a teacher's *output logits*. We do
something more flexible, **feature (embedding) distillation**:

1. **Teacher = frozen BioCLIP-2.** For every corpus image we precompute and
   cache its BioCLIP-2 image embedding (768-d, L2-normalized). ~2.6M images →
   366 shards of cached vectors. This is done ONCE; the teacher never runs at
   train time.
2. **Student = a smaller CLIP image encoder + a linear projection** into the
   teacher's 768-d space. We train the student so its output embedding matches
   the teacher's cached embedding for the same image, via **cosine loss**
   (`1 - cos(student_emb, teacher_emb)`).
3. **Classification is zero-shot, shared.** Because the student is trained to
   live *inside the teacher's embedding geometry*, the exact BioCLIP-2 **text
   classifier** (text embeddings of all 11,167 species' taxonomic prompts) works
   on the student UNCHANGED. Species prediction = `argmax(student_emb · text_emb)`.
   No species-specific classifier head to train, no fixed class list baked into
   weights; add/rename species by changing text prompts, not retraining.

### Why this is the right design (the novelty for our use case)

- **Model-agnostic + future-proof.** Distilling the *embedding* (not logits over
  a fixed species set) means the student isn't locked to today's taxonomy. The
  same student works with any text classifier built from BioCLIP-2's text tower.
  Swap the student architecture later without touching the classification path.
- **Cheap iteration.** Caching teacher embeddings once turns each training run
  into a pure student-forward job, no teacher inference in the loop. A full
  7,555-species epoch is ~2.3h on a single RTX 3080 instead of being bottlenecked
  by a 428M-param teacher.
- **Built-in abstention.** Softmax over the image-vs-text similarities gives a
  calibrated confidence. Thresholding it yields an accuracy/coverage dial ("only
  answer when ≥X% sure"), a lever GPT-4.1-mini does not expose. This is the
  headline differentiator for the RealBirdID abstention-aware benchmark.
- **License-clean.** Corpus is openly-licensed iNaturalist (AWS Open Data);
  ShareAlike images are excluded from the training manifest so the student
  weights can be released MIT. Full attribution retained.
- **Trained on a single consumer GPU (RTX 3080, 10GB).** No cluster, no cloud.
  The whole point of feature distillation from cached embeddings is that it makes
  CLIP-scale student training tractable on hobbyist hardware: the pilot (500
  species) took ~3h and the full 7,555-species run ~1.5 days on one 3080. By
  contrast the teacher-class models were trained on 8-176x A100/H100 nodes
  (thousands of GPU-hours). Caching the teacher's embeddings once + starting from
  LAION-pretrained weights is what collapses that into a single-desktop-GPU job.

### Transfer learning: we do NOT start from random weights

The student's encoder is initialized from **LAION-2B-pretrained CLIP weights**
(e.g. `ViT-B-16 / laion2b_s34b_b88k`), a model already trained on ~2B image-text
pairs. So at step 0 the encoder is already a competent general vision model; only
the added 512→768 linear projection head starts random. Distillation just
*specializes* an already-smart encoder into BioCLIP-2's bird-embedding geometry.

This is why cosine similarity to the teacher jumps from ~0 to ~0.77 in the first
50 steps and the whole pilot converges in ~3h, we stand on LAION's pretraining
rather than training a ViT from scratch (which cost the original authors
thousands of GPU-hours on billions of images).

## Two-architecture plan (decided 2026-07-22)

- **Tuning arch: ViT-B/16.** Trains fast on a desktop GPU (~316 img/s, batch 96
  on a 3080). Used to develop/validate the recipe.
- **Shipping arch: MobileCLIP-S2 (Apple, FastViT backbone).** ~15-20MB,
  CoreML/ONNX-ready, hits the <25MB stretch target. FastViT's train-time
  overparameterization (MobileOne-style parallel depthwise-conv branches) made it
  ~17s/step to *train* on the 3080 in the 2026-07-22 tests.
  **CAVEAT (unverified): that ~17s figure is SUSPECT.** All FastViT timings that
  day were at batch 64 during a session where the GPU was thrashing and several
  numbers were misread (the ViT-B "48 img/s ceiling" turned out to be a batch-128
  VRAM-wall artifact; batch 96 ran 6x faster at 314 img/s). FastViT at batch 64
  may have been partly hitting the same 10GB VRAM wall. We never did a clean
  batch-swept re-measure (fresh GPU context, batch 96/48/32). **TODO: re-benchmark
  FastViT properly AFTER the full ViT-B run frees the GPU** before concluding it
  needs cloud. It's possible the MobileCLIP-S2 "stretch" model also trains fine on
  the 3080.
- **Plan:** tune the recipe on ViT-B/16 (distillation-preserves-accuracy is
  arch-agnostic), then do the final MobileCLIP-S2 run, on the 3080 if the
  re-benchmark shows it's viable, else via torch.compile or a rented cloud GPU.
  Expect a light LR/schedule re-tune when switching arches.
- **Note:** the ViT-B/16 student is ITSELF shippable (~86MB fp16 / ~45MB int8),
  hitting the <86MB *fallback* target. If ~45MB int8 is acceptable for the app,
  one ViT-B run + export could be the production model with no MobileCLIP needed.
  MobileCLIP-S2 is only required to hit the <25MB *stretch* target.

## Training recipe (as of the pilot)

- Cosine loss on L2-normalized embeddings; AdamW (lr 1e-4, wd 0.1); cosine LR
  schedule; AMP (fp16 autocast); tf32 + cudnn.benchmark.
- Batch 96 (the 3080's sweet spot; batch 128 hits the 10GB VRAM wall and thrashes
  to ~48 img/s, batch 96 runs ~316 img/s).
- **LR was NOT retuned when batch dropped 128->96 (both pilot + full run use
  lr 1e-4).** Batch/LR are coupled (change one, retune the other), but: the
  change was only 0.75x (minor), AdamW is adaptive (forgiving of base-LR error),
  and distillation-to-fixed-targets is smooth/robust, so the pilot still hit 99%
  retention. Still, it's UNTUNED: a slightly lower LR (~5-7e-5, matching the 0.75
  batch ratio) might improve the val plateau / reduce the mild overfit drift we
  saw (val peaked ~epoch 11 then declined, a classic slightly-high-LR symptom).
  TODO in the tuning sweep: batch 96 x lr {5e-5, 7e-5, 1e-4}.
- 2% held-out val split (seeded); `val_cos_sim` (student-vs-teacher cosine on val)
  is the training signal. Early stopping (patience 3) + best-checkpoint saving:
  val plateaus then mildly overfits, so we keep the peak.

## Results

### Pilot: 500 species, ViT-B/16, 15 epochs, ~3h on one RTX 3080 (2026-07-22)

Final `val_cos_sim` 0.946 (plateaued ~0.947 from epoch ~10-11). Both models
scored with the SAME BioCLIP-2 text classifier (fair encoder-vs-encoder). No GPT
in these evals (GPT lives in the separate gated+range pipeline experiment).

**Held-out corpus (in-distribution, 4,000 unseen iNat images):**
| model | top-1 | top-5 |
|---|---|---|
| BioCLIP-2 teacher | 53.9 | 77.9 |
| student | 56.1 | 78.5 |
| retention | **104%** | **101%** |

**NABirds (out-of-distribution, external expert-labeled, 282 test imgs ∩ pilot
species):**
| model | top-1 | top-5 |
|---|---|---|
| BioCLIP-2 teacher | 91.5 | 99.7 |
| student | 90.8 | 97.2 |
| retention | **99.2%** | **97.5%** |

The OOD number is the headline: **a ViT-B/16 student retains ~99% of the
teacher's top-1 accuracy on unseen external birds.** In-distribution the student
slightly *beats* the teacher (normal distillation specialization: it fits the
teacher's geometry on this distribution and shaves some teacher noise), which is
expected and not a claim of general superiority.

Abstention lever (student, held-out corpus): @0.7 confidence → keep 34% at 91%
acc; @0.9 → keep 16.6% at 97%. Confidence gating cleanly trades coverage for
accuracy.

### Full run: 7,555 species, ViT-B/16 (launched 2026-07-22 ~19:54)

2,502,898 images, max 20 epochs, patience-3 early stop, ~316 img/s (~2.3h/epoch),
ETA ~26-30h. Results TBD (this doc will be updated when it lands + evals run at
`--pilot-species 0`).

## Honest caveats

- Held-out corpus eval is in-distribution (same iNat source), so it flatters the
  student; NABirds/CUB/RealBirdID are the real generalization anchors.
- NABirds test ∩ pilot-species was only 282 images (small); the full-species run
  will give a much larger NABirds intersection.
- Retention is measured against BioCLIP-2, not ground truth in isolation, but
  since BioCLIP-2 is the teacher we're trying to compress, "retain the teacher"
  is exactly the goal. Absolute accuracy vs GPT/ViT-L is Phase 4.
- The classification top-1 is over the full 11,167-species text classifier even
  when images come from a 500-species subset (open-set, honest but harder than a
  closed 500-way task).
