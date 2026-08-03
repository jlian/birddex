#!/bin/bash
# Batch-size experiment: 128 + sqrt-scaled LR vs the settled 96 + 7e-5.
#
# WHY: batch has NEVER been swept. Every run in project history used 96, and
# the README froze it as "a RECIPE hyperparameter, not a throughput knob".
# That is a reason to CONTROL it, not a reason to never test it.
#
# LR must move with batch or this tests the wrong thing. AdamW convention is
# sqrt scaling: 7e-5 * sqrt(128/96) = 7e-5 * 1.155 = 8.1e-5. Linear scaling
# would say 9.3e-5, which is likely too hot given val_cos collapses above 1e-4.
#
# Baseline for comparison is TEACH-W (runs/nb401_teach_wingclip): same shards,
# same teacher, same everything except batch 96 / lr 7e-5, val_cos 0.9612,
# NABirds 89.09. So this is a clean single-variable test (batch+its paired LR).
set -u
cd /home/jlian/wingdex/ml/distill || exit 1
V=./.venv/bin/python
STATE=/home/jlian/wingdex-queue
mkdir -p "$STATE"

T39="timm:vit_medium_patch16_clip_224.tinyclip_yfcc15m"
W401="/mnt/nas/WingDex-Distill/wds-nabirds401/shard-*.tar"
SV401=embeddings_wingclip_nb401

say () { echo "[$(date +%H:%M:%S)] $*"; }

if [ ! -f "$STATE/batch128.done" ]; then
  say "STEP B1: batch 128 + lr 8.1e-5 (sqrt-scaled), WingCLIP teacher"
  $V -u train_student.py --wds "$W401" --wds-epoch-samples 185000 \
    --sv-embeddings "$SV401" \
    --arch "$T39" --pretrained pretrained --out runs/nb401_batch128 \
    --epochs 25 --batch 128 --workers 12 --wds-shuffle 10000 \
    --aug light --wd 0.2 --beta2 0.95 --warmup 500 --grad-clip 1.0 \
    --min-lr 0.0 --patience 3 --lr 8.1e-5 2>&1 | grep -viE "hf_hub|unauthenticated"
  touch "$STATE/batch128.done"
else
  say "STEP B1 already done, skipping"
fi

say "STEP B2: NABirds eval (401 species, full test split)"
if [ -f runs/nb401_batch128/best.pt ]; then
  $V eval_nabirds.py --checkpoint runs/nb401_batch128/best.pt \
    --taxonomy /home/jlian/wingdex/src/lib/taxonomy.json \
    --pilot-species 0 --batch 64 --out runs/nbeval_nb401_batch128.json 2>&1 \
    | grep -viE "hf_hub|unauthenticated|huggingface_hub"
else
  say "  MISSING runs/nb401_batch128/best.pt, cannot eval"
fi

say "=== BATCH EXPERIMENT DONE ==="
touch "$STATE/batch.done"
