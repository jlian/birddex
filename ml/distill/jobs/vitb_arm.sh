#!/usr/bin/env bash
# vitb_arm.sh -- rebuild the ViT-B side inputs so both models can be scored
# through the SAME script with the SAME split and the SAME absolute metric.
#
# calib_cands_01_a090.parquet and calibration_occ_01.json survive from
# 2026-07-30, but the counts matrix and status file for that candidate
# ordering do not. Both are CANDIDATE-ORDERED, so they must be rebuilt from
# the ViT-B candidates, not borrowed from the TinyCLIP run.
#
# The occurrence data itself is unchanged since 2026-07-30 (verified by mtime
# and by git log), so this reproduces the original inputs rather than new ones.
set -uo pipefail
cd /home/jlian/wingdex/ml/distill || exit 1

V=./.venv/bin/python
CANDS=calib_cands_01_a090.parquet
JSONL=calib_cands_01_a090.jsonl
COUNTS=calib_occ_counts_vitb.npz
STATUS=calib_status_vitb.jsonl
LOG=/home/jlian/vitb_arm.log

say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

say "=== rebuilding the ViT-B arm ==="

[ -f "$CANDS" ] || { say "ABORT: $CANDS missing"; exit 3; }

if [ ! -f "$COUNTS" ]; then
  say "counts matrix for the ViT-B candidate ordering"
  $V join_occurrence.py \
    --candidates "$CANDS" \
    --occurrence occurrence_cells.parquet \
    --totals occurrence_totals.parquet \
    --target-taxa target_taxa.csv \
    --out "$COUNTS" >>"$LOG" 2>&1
  [ -f "$COUNTS" ] || { say "FAILED: no $COUNTS"; exit 4; }
  say "  counts OK"
fi

if [ ! -f "$JSONL" ]; then
  $V -c "import pandas as pd; df = pd.read_parquet('$CANDS'); df[['photo_id','latitude','longitude','cand_idx']].to_json('$JSONL', orient='records', lines=True)" >>"$LOG" 2>&1
  say "  wrote $JSONL"
fi

if [ ! -f "$STATUS" ]; then
  say "range status for the ViT-B candidate ordering"
  node /home/jlian/wingdex/ml/scripts/attach-range-status.mjs \
    "$JSONL" "$STATUS" >>"$LOG" 2>&1
  NS=$(wc -l < "$STATUS" 2>/dev/null || echo 0)
  [ "$NS" -ge 1000 ] || { say "FAILED: $STATUS has $NS lines"; exit 4; }
  say "  status OK ($NS photos)"
fi

say "=== ViT-B arm ready ==="
