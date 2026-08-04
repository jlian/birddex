#!/usr/bin/env bash
# phase3.sh -- fresh-photo fine-tune (D7) end to end, unattended.
#
# Tests whether reusing the teacher's own ground-truth set suppressed the
# fine-tune gain. Phase 2 used groundtruth_heldout_distilled.parquet, the same
# set that produced WingCLIP-0.1, and gained only +1.10 NABirds where the ViT-B
# chain gained about +8. This run uses groundtruth_fresh_v2.parquet: 143,890
# photos over 3,662 species, disjoint from BOTH the distillation corpus and the
# phase-2 set, by photo_id AND observation_uuid.
#
# Fine-tunes FROM THE DISTILL BASELINE, not from the phase-2 model. Stacking
# would deepen in-distribution overfit (phase 2 already went 74.85 -> 74.28 on
# its own val) and would break WiSE-FT, which interpolates between the
# distilled and fine-tuned endpoints.
#
# Marker-gated and idempotent: every stage skips if already done.
set -uo pipefail
cd /home/jlian/wingdex/ml/distill || exit 1

V=./.venv/bin/python
RUN=runs/full7555_tiny39
FT=runs/ft_tiny39_fresh
CORPUS=/home/jlian/wingdex/ml/groundtruth-fresh
MANIFEST=groundtruth_fresh_v2.parquet
S=/home/jlian/wingdex-queue/fresh
LOG=/home/jlian/phase3.log
mkdir -p "$S" "$FT"

say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

say "=== PHASE 3 START (fresh-photo fine-tune) ==="

# ---------------------------------------------------------------- guards
if [ ! -f "$MANIFEST" ]; then
  say "ABORT: $MANIFEST missing"; exit 3
fi
if [ ! -f "$RUN/best.pt" ]; then
  say "ABORT: $RUN/best.pt missing (need the distill baseline)"; exit 3
fi

# ---------------------------------------------------------------- step 1
# Download the fresh photos. ~143,890 images; this is the long pole.
if [ ! -f "$S/pull.done" ]; then
  say "STEP 1/4: downloading 143,890 fresh photos"
  $V pull_images.py --manifest "$MANIFEST" --out "$CORPUS" \
    --size medium --workers 16 >>"$LOG" 2>&1
  N=$(find "$CORPUS" -name "*.jpg" 2>/dev/null | wc -l)
  say "  downloaded $N files"
  # Accept partial: iNat 404s some photos. Below 80% means something is wrong.
  if [ "$N" -ge 115000 ]; then
    touch "$S/pull.done"; say "  pull OK ($N files)"
  else
    say "  FAILED: only $N files, expected >=115000 (80% of 143890)"; exit 4
  fi
else
  say "STEP 1/4 already done, skipping"
fi

# ---------------------------------------------------------------- step 2
# Fine-tune FROM THE DISTILL BASELINE. Same hyperparameters as phase 2, so the
# ONLY difference against ft_tiny39 is which photos it sees.
if [ ! -f "$S/ft.done" ]; then
  say "STEP 2/4: ground-truth fine-tune on FRESH photos (12 ep)"
  $V finetune_groundtruth.py \
    --checkpoint "$RUN/best.pt" \
    --gt-manifest "$MANIFEST" \
    --gt-corpus "$CORPUS" \
    --taxonomy /home/jlian/wingdex/src/lib/taxonomy.json \
    --out "$FT" \
    --epochs 12 --lr 1e-5 --wd 0.1 --batch 96 --workers 10 \
    --warmup 200 --grad-clip 1.0 --aug light --label-smoothing 0.1 \
    >>"$LOG" 2>&1
  if [ -f "$FT/best.pt" ]; then
    touch "$S/ft.done"; say "  fine-tune OK"
  else
    say "  FAILED: no $FT/best.pt"; exit 4
  fi
else
  say "STEP 2/4 already done, skipping"
fi

# ---------------------------------------------------------------- step 3
# Seed the 24,633-row teacher cache so the first eval does not re-run
# BioCLIP-2 over every image for ~20-30 min.
SRC=runs/ft_tiny39/nabirds_teacher_cache.npz
DST="$FT/nabirds_teacher_cache.npz"
if [ ! -f "$DST" ] && [ -f "$SRC" ]; then
  cp "$SRC" "$DST" && say "seeded teacher cache"
fi

# Phase 2 peaked at alpha 0.50, so sweep finer around it and keep the ends.
say "STEP 3/4: WiSE-FT alpha sweep + NABirds eval per alpha"
for A in 0.25 0.40 0.50 0.60 0.75 0.90; do
  W="$FT/wise_a${A}.pt"
  E="$FT/nbeval_a${A}.json"
  if [ -f "$E" ]; then say "  alpha $A already evaluated"; continue; fi
  if [ ! -f "$W" ]; then
    $V finetune_groundtruth.py --wise-only \
      --checkpoint "$RUN/best.pt" --finetuned "$FT/best.pt" \
      --alpha "$A" --out "$FT" >>"$LOG" 2>&1
  fi
  if [ ! -f "$W" ]; then say "  alpha $A: merge FAILED"; continue; fi
  # --pilot-species 0 is MANDATORY: the default 500 silently scores 7 species.
  $V eval_nabirds.py --checkpoint "$W" \
    --taxonomy /home/jlian/wingdex/src/lib/taxonomy.json \
    --pilot-species 0 --batch 64 --out "$E" \
    --ref-teacher runs/ft_clean_01/wise_a0.90.pt \
    >>"$LOG" 2>&1
  if [ -f "$E" ]; then say "  alpha $A evaluated"; else say "  alpha $A: EVAL FAILED"; fi
done

# ---------------------------------------------------------------- step 4
say "STEP 4/4: summary"
$V jobs/phase3_summary.py >>"$LOG" 2>&1
touch "$S/phase3.done"
say "=== PHASE 3 DONE ==="
