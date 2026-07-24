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
- [ ] **Full 7,555-species ViT-B/16 baseline run** ← *in progress* (epoch ~10, val_cos ~0.9573)
- [ ] **Leakage check (MEASURED 2026-07-23: avg 1.58 photos/obs, 54% from multi-photo obs, no big bursts):** val_cos is ~54%-leakage-biased but that's just a progress monitor; ship metric NABirds is immune. Only hard requirement: split the ground-truth held-out eval by `observation_uuid`.
- [ ] **Pilot experimentation stage (500 sp) — BOTH recipes locked here:**
  - [ ] distillation-recipe sweep: batch 96 × LR {5e-5, 7e-5, 1e-4}, aug, resolution, epochs
  - [ ] adopt from MobileCLIP papers (see "What MobileCLIP's papers say"): strong aug (RandomResizedCrop [0.08,1.0]+RandAugment), multi-augmentation embedding caching, AdamW β₂=0.95 / wd 0.2 / cosine-to-1e-6 / warmup / grad-clip 1.0
  - [ ] **co-occurrence hard-example weighting** wired into `train_student.py` + tested (built but NOT yet integrated)
  - [ ] **ground-truth fine-tune recipe** (see below) — same cheap-iteration harness; apply **WiSE-FT** (fine-tune from distilled ckpt, then weight-ensemble θ=(1−α)·distilled+α·finetuned, α≈0.5) to keep OOD robustness
  - [ ] fine-tune lever to test: higher input res (256/336 via interpolated pos-emb, source is 500px)
- [ ] Build **leak-free held-out ground-truth set** (sampler script, NOT built yet — see "Ground-truth fine-tune")
- [ ] One more full ViT-B run *only if* the sweep beats baseline meaningfully
- [ ] Re-benchmark **MobileCLIP-S2 (FastViT)** training speed on the 3080 (the ~17s/step figure is suspect — see caveats). Harness ready: `ml/distill/bench_fastvit.py` (warmup, cudnn.benchmark, AMP, batch sweep 64→512, channels_last both ways in synthetic mode, `--real` reuses the actual train_student dataloader for end-to-end img/s). RUN ONLY WHEN GPU IS FREE.
- [ ] **Map the cosine→accuracy curve:** eval NABirds top-1/5 at epoch 1/5/10/final checkpoints. Answers "is early already usable?" and "minimum epochs needed" — could cut the expensive final MobileCLIP run short. (Needs per-epoch checkpoints saved; add to future runs.)
- [ ] **Adopt Apple's WebDataset + open_clip_train dataloader (option A), keep our image-only cosine loss** — see "Adopt upstream training path" below. Prime suspect for both the ViT-B 314 img/s and FastViT slowness is our random-small-file dataloader; Apple's tar-sharded path is built to saturate the GPU. Do before the final MobileCLIP-S2 run.
- [ ] Final **MobileCLIP-S2** production run with locked recipe (3080 if viable, else torch.compile / rented cloud GPU — see "Cloud GPU rental", ~$10-20 fallback)
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

**Apple `ml-mobileclip` reality (cloned at `~/spikes/bioclip-birdid/ml-mobileclip`):**
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
   used 10. **This is our biggest current gap:** we cache ONE 224 embedding per image, so
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
