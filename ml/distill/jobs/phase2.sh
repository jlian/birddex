#!/usr/bin/env bash
# phase2.sh -- unattended fine-tune + WiSE-FT alpha sweep for TinyCLIP-39M.
# Runs AFTER the full distill finishes. Idempotent: every stage is marker-gated,
# so re-running resumes rather than redoing.
set -uo pipefail
cd /home/jlian/wingdex/ml/distill || exit 1

V=./.venv/bin/python
RUN=runs/full7555_tiny39
FT=runs/ft_tiny39
S=/home/jlian/wingdex-queue/full   # MUST match full_run.sh
LOG=/home/jlian/phase2.log
mkdir -p "$FT"

say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

say "=== PHASE 2 START ==="

# ---------------------------------------------------------------- guard
# Only proceed if the distill actually finished AND produced a checkpoint.
if [ ! -f "$S/all.done" ]; then
  say "ABORT: $S/all.done missing -- distill not finished"
  exit 3
fi
if [ ! -f "$RUN/best.pt" ]; then
  say "ABORT: $RUN/best.pt missing"
  exit 3
fi

# ---------------------------------------------------------------- step 1
# Ground-truth fine-tune on the CLEAN leak-free set (3,850 sp / 151,042 photos).
# Same hyperparameters as ft_clean_01, which produced +14.22 in-dist on ViT-B.
if [ ! -f "$S/ft.done" ]; then
  say "STEP 1/3: ground-truth fine-tune (12 ep, clean set)"
  $V finetune_groundtruth.py \
    --checkpoint "$RUN/best.pt" \
    --gt-manifest groundtruth_heldout_distilled.parquet \
    --gt-corpus /home/jlian/wingdex/ml/groundtruth/corpus \
    --taxonomy /home/jlian/wingdex/src/lib/taxonomy.json \
    --out "$FT" \
    --epochs 12 --lr 1e-5 --wd 0.1 --batch 96 --workers 10 \
    --warmup 200 --grad-clip 1.0 --aug light --label-smoothing 0.1 \
    >>"$LOG" 2>&1
  if [ -f "$FT/best.pt" ]; then
    touch "$S/ft.done"; say "  fine-tune OK"
  else
    say "  FAILED: no $FT/best.pt -- stopping"; exit 4
  fi
else
  say "STEP 1/3 already done, skipping"
fi

# ---------------------------------------------------------------- step 2
# WiSE-FT alpha sweep. Do NOT assume 0.90: that optimum came from a gentle
# fine-tune on an 86.6M model. A 38.3M student may want a lower alpha.
say "STEP 2/3: WiSE-FT alpha sweep + NABirds eval per alpha"
for A in 0.25 0.50 0.75 0.90 1.00; do
  W="$FT/wise_a${A}.pt"
  E="$FT/nbeval_a${A}.json"
  if [ -f "$E" ]; then say "  alpha $A already evaluated, skipping"; continue; fi
  if [ ! -f "$W" ]; then
    $V finetune_groundtruth.py --wise-only \
      --checkpoint "$RUN/best.pt" --finetuned "$FT/best.pt" \
      --alpha "$A" --out "$FT" >>"$LOG" 2>&1
  fi
  if [ ! -f "$W" ]; then say "  alpha $A: merge FAILED, skipping"; continue; fi
  # --pilot-species 0 is MANDATORY: the default 500 silently evaluates a
  # 7-species subset and produced void numbers once already.
  $V eval_nabirds.py --checkpoint "$W" \
    --taxonomy /home/jlian/wingdex/src/lib/taxonomy.json \
    --pilot-species 0 --batch 64 --out "$E" \
    >>"$LOG" 2>&1
  if [ -f "$E" ]; then say "  alpha $A evaluated"; else say "  alpha $A: EVAL FAILED"; fi
done

# ---------------------------------------------------------------- step 3
say "STEP 3/3: summary"
$V jobs/phase2_summary.py >>"$LOG" 2>&1
touch "$S/phase2.done"
say "=== PHASE 2 DONE ==="
