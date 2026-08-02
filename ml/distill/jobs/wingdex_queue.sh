#!/bin/bash
# Full WingDex TinyCLIP queue: finish the LR sweep, then the teacher experiment.
#
# Everything lives in the REPO, not /tmp. Tomahawk hard-hung twice on 2026-08-01
# and /tmp is cleared on boot, which destroyed the staged scripts AND their logs
# both times. Markers and logs go under /home/jlian/ for the same reason.
set -u
cd /home/jlian/wingdex/ml/distill || exit 1
V=./.venv/bin/python
STATE=/home/jlian/wingdex-queue
mkdir -p "$STATE"

T39="timm:vit_medium_patch16_clip_224.tinyclip_yfcc15m"
W02="/mnt/nas/WingDex-Distill/wds-pilot500/shard-*.tar"
W401="/mnt/nas/WingDex-Distill/wds-nabirds401/shard-*.tar"
SV401=embeddings_wingclip_nb401

say () { echo "[$(date +%H:%M:%S)] $*"; }

# ---------------------------------------------------------------- step 1
# Finish lr 3e-5. --resume restores model+optimizer+scheduler+scaler+epoch so
# it continues the SAME cosine trajectory rather than warm-restarting.
# Confirmatory only: 7e-5 -> 0.9560 and 5e-5 -> 0.9563 already show LR is at
# the floor.
if [ ! -f "$STATE/lr3e5.done" ]; then
  say "STEP 1: finish lr 3e-5 (resume from epoch ~11/25)"
  $V -u train_student.py --wds "$W02" --wds-epoch-samples 244000 \
    --sv-embeddings embeddings_wingclip_pilot500 \
    --arch "$T39" --pretrained pretrained --out runs/tiny39_r02_lr3e5 \
    --resume runs/tiny39_r02_lr3e5/last.pt \
    --epochs 25 --batch 96 --workers 12 --wds-shuffle 10000 \
    --aug light --wd 0.2 --beta2 0.95 --warmup 500 --grad-clip 1.0 \
    --min-lr 0.0 --patience 3 --lr 3e-5 2>&1 | grep -viE "hf_hub|unauthenticated"
  touch "$STATE/lr3e5.done"
else
  say "STEP 1 already done, skipping"
fi

# ---------------------------------------------------------------- step 2
# WingCLIP-0.1 targets for the NABirds-aligned shards (~21 min at ~148 emb/s).
if [ ! -f "$STATE/embed401.done" ]; then
  say "STEP 2: re-embed WingCLIP-0.1 targets for wds-nabirds401"
  $V -u precompute_embeddings.py --manifest train_manifest.parquet \
    --wds "$W401" --out "$SV401" --batch 256 --shard-size 50000 --fp16 \
    --model runs/ft_clean_01/wise_a0.90.pt 2>&1 \
    | grep -viE "hf_hub|unauthenticated"
  touch "$STATE/embed401.done"
else
  say "STEP 2 already done, skipping"
fi

# ---------------------------------------------------------------- step 3
# THE POINT OF ALL THIS: which teacher makes the better student?
# Identical recipe (RUN B 0.2 basis), ONLY the teacher differs.
#   TEACH-W = WingCLIP-0.1 targets (--sv-embeddings)
#   TEACH-B = BioCLIP-2 targets    (omit it; baked into the shards)
if [ ! -f "$STATE/teachw.done" ]; then
  say "STEP 3a: TEACH-W (WingCLIP-0.1 teacher)"
  $V -u train_student.py --wds "$W401" --wds-epoch-samples 185000 \
    --sv-embeddings "$SV401" \
    --arch "$T39" --pretrained pretrained --out runs/nb401_teach_wingclip \
    --epochs 25 --batch 96 --workers 12 --wds-shuffle 10000 \
    --aug light --wd 0.2 --beta2 0.95 --warmup 500 --grad-clip 1.0 \
    --min-lr 0.0 --patience 3 --lr 7e-5 2>&1 | grep -viE "hf_hub|unauthenticated"
  touch "$STATE/teachw.done"
else
  say "STEP 3a already done, skipping"
fi

if [ ! -f "$STATE/teachb.done" ]; then
  say "STEP 3b: TEACH-B (BioCLIP-2 teacher)"
  $V -u train_student.py --wds "$W401" --wds-epoch-samples 185000 \
    --arch "$T39" --pretrained pretrained --out runs/nb401_teach_bioclip \
    --epochs 25 --batch 96 --workers 12 --wds-shuffle 10000 \
    --aug light --wd 0.2 --beta2 0.95 --warmup 500 --grad-clip 1.0 \
    --min-lr 0.0 --patience 3 --lr 7e-5 2>&1 | grep -viE "hf_hub|unauthenticated"
  touch "$STATE/teachb.done"
else
  say "STEP 3b already done, skipping"
fi

# ---------------------------------------------------------------- step 4
# --pilot-species 0 scores ALL mapped NABirds species. Correct HERE and only
# here: these students trained the 401 NABirds species, so there is no
# untrained-species penalty. 24,633 images instead of the old 282.
say "STEP 4: NABirds eval, 401 species / full test split"
for R in nb401_teach_wingclip nb401_teach_bioclip; do
  if [ -f "runs/$R/best.pt" ]; then
    say "  eval $R"
    $V eval_nabirds.py --checkpoint "runs/$R/best.pt" \
      --taxonomy /home/jlian/wingdex/src/lib/taxonomy.json \
      --pilot-species 0 --batch 64 --out "runs/nbeval_$R.json" 2>&1 \
      | grep -viE "hf_hub|unauthenticated|huggingface_hub"
  else
    say "  MISSING runs/$R/best.pt, cannot eval"
  fi
done

say "=== QUEUE DONE ==="
touch "$STATE/queue.done"
