#!/usr/bin/env bash
# phase5_refit.sh -- refit the occurrence ranker for the new student.
#
# WHY THIS IS MANDATORY, not a tidy-up:
#   score = sim/T + beta * log P(species|cell)
# T and beta in calibration_occ_01.json were fitted to WingCLIP-0.1 at alpha
# 0.90, an 86.6M ViT-B. We now ship TinyCLIP-39M at alpha 0.60. T sets the
# scale on which visual similarity trades against the geographic prior, and a
# different model gives a different similarity distribution. A stale T
# silently mis-weights the prior.
#
# ORDER: refit in torch first, THEN export to ONNX. ONNX is a format change
# that should be numerically neutral, so check it by bit-exact comparison
# against torch, not by downstream accuracy. Exporting first would confound an
# export bug with a calibration bug.
#
# TWO artifacts are model-specific and BOTH must be regenerated:
#   calib_cands_*.parquet  cand_sim holds this model's similarities
#   calib_occ_counts.npz   shape (photos, 25) is indexed by CANDIDATE RANK,
#                          so it is tied to the candidate ordering above
set -uo pipefail
cd /home/jlian/wingdex/ml/distill || exit 1

V=./.venv/bin/python
CKPT=runs/ft_tiny39_fresh/wise_a0.60.pt
TAXO=/home/jlian/wingdex/src/lib/taxonomy.json
CANDS=calib_cands_tiny39_a060.parquet
COUNTS=calib_occ_counts_tiny39.npz
OUT=calibration_occ_tiny39.json
S=/home/jlian/wingdex-queue/refit
LOG=/home/jlian/phase5.log
mkdir -p "$S"

say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

say "=== PHASE 5 START (ranker refit for TinyCLIP-39M) ==="

[ -f "$CKPT" ] || { say "ABORT: $CKPT missing"; exit 3; }

# ---------------------------------------------------------------- step 1
if [ ! -f "$S/cands.done" ]; then
  say "STEP 1/4: emit calibration candidates with the new student"
  # NOTE: emit_calib_candidates.py appends "corpus/" itself (line 119), so
  # --corpus takes the PARENT. That is the INVERSE of
  # finetune_groundtruth.py, which wants the corpus/ subdir. Two scripts,
  # two conventions. Read the source before assuming either one.
  $V emit_calib_candidates.py \
    --checkpoint "$CKPT" \
    --manifest calib_untouched.parquet \
    --corpus /home/jlian/wingdex/ml/distill/calib_corpus \
    --taxonomy "$TAXO" \
    --out "$CANDS" >>"$LOG" 2>&1
  # A file-exists test is not enough: the emitter writes a valid but EMPTY
  # parquet when every image is missing, and logs "0 scored". Require rows.
  NROW=$($V -c "import pandas as pd;print(len(pd.read_parquet('$CANDS')))" 2>/dev/null || echo 0)
  if [ "$NROW" -lt 1000 ]; then
    say "  FAILED: $CANDS has $NROW rows. Check --corpus points at the right"
    say "  image root; the log line 'N scored, M missing' shows what was found."
    rm -f "$CANDS"
    exit 4
  fi
  say "  candidates: $NROW rows"
  touch "$S/cands.done"; say "  candidates OK"
else
  say "STEP 1/4 already done, skipping"
fi

# ---------------------------------------------------------------- step 2
# The counts matrix is (photos x 25) indexed by candidate rank, so it MUST be
# rebuilt against the new candidate ordering. Reusing the old one would pair
# each photo with occurrence counts for a DIFFERENT species list.
if [ ! -f "$S/counts.done" ]; then
  say "STEP 2/4: rebuild the occurrence counts matrix for the new candidates"
  $V join_occurrence.py \
    --candidates "$CANDS" \
    --occurrence occurrence_cells.parquet \
    --totals occurrence_totals.parquet \
    --target-taxa target_taxa.csv \
    --out "$COUNTS" >>"$LOG" 2>&1
  [ -f "$COUNTS" ] || { say "  FAILED: no $COUNTS"; exit 4; }
  touch "$S/counts.done"; say "  counts OK"
fi

# attach-range-status.mjs reads JSONL rows carrying cand_idx, lat and lon,
# so convert the candidate parquet once.
CANDS_JSONL=calib_cands_tiny39_a060.jsonl
if [ ! -f "$CANDS_JSONL" ]; then
  $V -c "import pandas as pd, json; df = pd.read_parquet('$CANDS'); df[['photo_id','latitude','longitude','cand_idx']].to_json('$CANDS_JSONL', orient='records', lines=True)" >>"$LOG" 2>&1
  say "  wrote $CANDS_JSONL"
else
  say "STEP 2/4 already done, skipping"
fi

# ---------------------------------------------------------------- step 2b
# The status file is {photo_id, status[]} PER CANDIDATE, so it is ordered by
# the candidate list and must be rebuilt with it. Range cells live in
# .tmp/range-priors/cells, the same directory pipeline-experiment.mjs uses.
STATUS=calib_status_tiny39.jsonl
if [ ! -f "$S/status.done" ]; then
  say "STEP 2b/4: regenerate range status for the new candidate ordering"
  node /home/jlian/wingdex/ml/scripts/attach-range-status.mjs \
    "$CANDS_JSONL" "$STATUS" >>"$LOG" 2>&1
  NS=$(wc -l < "$STATUS" 2>/dev/null || echo 0)
  if [ "$NS" -lt 1000 ]; then
    say "  FAILED: $STATUS has $NS lines"
    exit 4
  fi
  touch "$S/status.done"; say "  status OK ($NS photos)"
else
  say "STEP 2b/4 already done, skipping"
fi

# ---------------------------------------------------------------- step 3
if [ ! -f "$S/fit.done" ]; then
  say "STEP 3/4: fit T and beta on the new similarity distribution"
  $V fit_occurrence.py \
    --candidates "$CANDS" \
    --status "$STATUS" \
    --counts "$COUNTS" \
    --out "$OUT" >>"$LOG" 2>&1
  [ -f "$OUT" ] || { say "  FAILED: no $OUT"; exit 4; }
  touch "$S/fit.done"; say "  fit OK"
else
  say "STEP 3/4 already done, skipping"
fi

# ---------------------------------------------------------------- step 4
say "STEP 4/4: compare old and new calibration"
$V - <<PYEOF | tee -a "$LOG"
import json
old = json.load(open("calibration_occ_01.json"))
new = json.load(open("$OUT"))
print("")
print("=== ranker refit: WingCLIP-0.1 @a0.90 -> TinyCLIP-39M @a0.60 ===")
print("")
print("%-16s %14s %14s" % ("param", "old", "new"))
for k in ("temperature", "beta", "alpha", "val_top1_H", "val_top5_H",
          "val_top1_I", "val_top5_I"):
    o, n = old.get(k), new.get(k)
    if isinstance(o, float) and isinstance(n, float):
        print("%-16s %14.6g %14.6g" % (k, o, n))
print("")
print("val_top1_I is Strategy I on this run's own held-out split.")
print("Each model is scored on its OWN candidates, so read the SHAPE:")
print("does occurrence still add points over status-only H?")
PYEOF

touch "$S/phase5.done"
say "=== PHASE 5 DONE ==="
