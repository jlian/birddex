#!/bin/bash
# FULL 7,555-species distill: TinyCLIP-39M student, WingCLIP-0.1 teacher.
#
# This is the real run. Everything before it was pilots to settle the recipe:
#   teacher  = WingCLIP-0.1   (+5.65 NABirds top-1 over BioCLIP-2, n=24,633)
#   lr       = 7e-5           (floor; 5e-5 ties, everything above 1e-4 collapses)
#   batch    = 128            (proven a wash vs 96 at sqrt-scaled LR, so take the
#                              bigger one; lr = 7e-5 * sqrt(128/96) = 8.1e-5)
#   recipe   = 0.2 basis      (aug light, wd 0.2, beta2 0.95, warmup 500, clip 1.0)
#   GPU cfg  = bf16 + channels_last + torch.compile (~1.17x, measured)
#
# STEP 1 re-embeds the FULL corpus with WingCLIP-0.1. It is mandatory: the
# existing embeddings/ cache is dated 2026-07-21 and holds BIOCLIP-2 targets,
# i.e. the teacher that LOST by 5.65. Training on it would silently reproduce
# the losing arm at full scale. ~1.1h at the measured 676 img/s.
#
# Marker-gated under /home/jlian/wingdex-queue/full/ so a re-run resumes rather
# than restarting. train_student.py --resume restores optimizer+scheduler+scaler.
set -u
cd /home/jlian/wingdex/ml/distill || exit 1
V=./.venv/bin/python
S=/home/jlian/wingdex-queue/full
mkdir -p "$S"

T39="timm:vit_medium_patch16_clip_224.tinyclip_yfcc15m"
WDS="/mnt/nas/WingDex-Distill/wds/shard-*.tar"
SV=embeddings_wingclip_full
EPOCH_SAMPLES=2500000

say () { echo "[$(date +%H:%M:%S)] $*"; }

# ---------------------------------------------------------------- step 1
if [ ! -f "$S/embed.done" ]; then
  say "STEP 1/3: re-embed FULL corpus with WingCLIP-0.1 (~1.1h)"
  $V -u precompute_embeddings.py --manifest train_manifest.parquet \
    --wds "$WDS" --out "$SV" --batch 256 --shard-size 50000 --fp16 \
    --model runs/ft_clean_01/wise_a0.90.pt 2>&1 \
    | grep -viE "hf_hub|unauthenticated"
  touch "$S/embed.done"
else
  say "STEP 1/3 already done, skipping"
fi

# ---------------------------------------------------------------- step 2
RESUME=""
if [ -f runs/full7555_tiny39/last.pt ]; then
  RESUME="--resume runs/full7555_tiny39/last.pt"
  say "found existing checkpoint, resuming"
fi

if [ ! -f "$S/train.done" ]; then
  say "STEP 2/3: distill TinyCLIP-39M on 7,555 species (~23h)"
  $V -u train_student.py --wds "$WDS" --wds-epoch-samples $EPOCH_SAMPLES \
    --sv-embeddings "$SV" \
    --arch "$T39" --pretrained pretrained --out runs/full7555_tiny39 \
    $RESUME \
    --epochs 25 --batch 128 --workers 12 --wds-shuffle 10000 \
    --aug light --wd 0.2 --beta2 0.95 --warmup 500 --grad-clip 1.0 \
    --min-lr 0.0 --patience 3 --lr 8.1e-5 \
    --amp-dtype bf16 --channels-last --compile 2>&1 \
    | grep -viE "hf_hub|unauthenticated"
  touch "$S/train.done"
else
  say "STEP 2/3 already done, skipping"
fi

# ---------------------------------------------------------------- step 3
# --pilot-species 0 is correct here for the first time without caveat: the
# student now covers all 7,555 species, so there is no untrained-species penalty
# and no species-restriction confound.
say "STEP 3/3: NABirds eval (full test split, all mapped species)"
if [ -f runs/full7555_tiny39/best.pt ]; then
  $V eval_nabirds.py --checkpoint runs/full7555_tiny39/best.pt \
    --taxonomy /home/jlian/wingdex/src/lib/taxonomy.json \
    --pilot-species 0 --batch 64 --out runs/nbeval_full7555_tiny39.json 2>&1 \
    | grep -viE "hf_hub|unauthenticated|huggingface"
else
  say "  MISSING best.pt, cannot eval"
fi

say "=== FULL RUN DONE ==="
touch "$S/all.done"
