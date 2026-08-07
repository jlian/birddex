#!/usr/bin/env bash
# phase4_quant.sh -- quantisation sweep on the ACTUAL shipping artifact.
#
# The first sweep ran on runs/full7555_tiny39/best.pt, the distill baseline.
# That is not what we ship. We ship a WiSE-FT blend, which is a weighted
# average of two weight sets and can have a different outlier structure, and
# outliers are exactly what broke int4 at block 128. So the -8.85 measured on
# the baseline may not transfer either way. Re-measure on the winner.
#
# Picks the best alpha from the phase-3 eval JSONs, so it needs no argument.
set -uo pipefail
cd /home/jlian/wingdex/ml/distill || exit 1

V=./.venv/bin/python
FT=runs/ft_tiny39_fresh
S=/home/jlian/wingdex-queue/fresh
LOG=/home/jlian/phase4.log

say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

say "=== PHASE 4 START (quantisation on the shipping artifact) ==="

if [ ! -f "$S/phase3.done" ]; then
  say "ABORT: $S/phase3.done missing, phase 3 has not finished"; exit 3
fi

# Pick the winning alpha from the eval JSONs rather than hardcoding one.
BEST=$($V - <<EOF
import json, glob, os
best, top = None, -1.0
for p in sorted(glob.glob("runs/ft_tiny39_fresh/nbeval_a*.json")):
    try:
        d = json.load(open(p))
    except Exception:
        continue
    s = d.get("student")
    t = s.get("top1") if isinstance(s, dict) else d.get("student_top1")
    if t is not None and t > top:
        top = t
        best = os.path.basename(p).replace("nbeval_a", "").replace(".json", "")
print(best or "")
EOF
)

if [ -z "$BEST" ]; then
  say "ABORT: no phase-3 eval results, cannot pick an alpha"; exit 4
fi

CKPT="$FT/wise_a${BEST}.pt"
if [ ! -f "$CKPT" ]; then
  say "ABORT: $CKPT missing"; exit 4
fi
say "best alpha = $BEST -> $CKPT"

# The rescue sweep: fp32, int8, and int4 at three block sizes plus two mixed
# variants. On the baseline, block 32 recovered 6.6 of the 8.85 lost points.
say "STEP 1/1: quantisation rescue sweep on the shipping artifact"
$V jobs/quant_rescue.py \
  --checkpoint "$CKPT" \
  --taxonomy /home/jlian/wingdex/src/lib/taxonomy.json \
  --batch 128 >>"$LOG" 2>&1

if grep -aq "int4-blk32" "$LOG"; then
  touch "$S/phase4.done"
  say "=== PHASE 4 DONE ==="
else
  say "FAILED: sweep produced no int4-blk32 row"
  exit 5
fi
