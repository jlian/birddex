#!/usr/bin/env bash
# phase4_quant.sh -- quantisation sweep on the ACTUAL shipping artifact.
#
# The first sweep ran on runs/full7555_tiny39/best.pt, the distill baseline.
# That is not what we ship. We ship a WiSE-FT blend, which is a weighted
# average of two weight sets and can have a different outlier structure, and
# outliers are exactly what broke int4 at block 128. So the -8.85 measured on
# the baseline may not transfer either way. Re-measure on the winner.
#
# The checkpoint is PINNED in ml/distill/shipped_model.py, not selected here.
# This script used to scan runs/ft_tiny39_fresh/nbeval_a*.json and take the
# highest student top1. That cannot give a defensible answer, because 0.60 and
# 0.75 TIE at 86.90, so the winner was decided by file ordering rather than by
# evidence. The scan is kept below as a CROSS-CHECK only: if it disagrees with
# the pin, this script stops and names both instead of silently preferring
# either one. The pin wins by default because it is a reviewed assertion with
# the tie-break reasoning written down; the scan is a heuristic that cannot
# distinguish a tie from a winner.
#
# Pass --allow-mismatch to proceed anyway after reading the warning.
set -uo pipefail
cd /home/jlian/wingdex/ml/distill || exit 1

ALLOW_MISMATCH=0
for arg in "$@"; do
  case "$arg" in
    --allow-mismatch) ALLOW_MISMATCH=1 ;;
    *) echo "unknown argument: $arg"; exit 2 ;;
  esac
done

V=./.venv/bin/python
FT=runs/ft_tiny39_fresh
S=/home/jlian/wingdex-queue/fresh
LOG=/home/jlian/phase4.log

say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

say "=== PHASE 4 START (quantisation on the shipping artifact) ==="

if [ ! -f "$S/phase3.done" ]; then
  say "ABORT: $S/phase3.done missing, phase 3 has not finished"; exit 3
fi

# The pinned answer. Single source of truth.
CKPT=$($V -c 'import shipped_model as S; print(S.SHIPPED_CHECKPOINT)')
PIN=$($V -c 'import shipped_model as S; print("%.2f" % S.SHIPPED_WISE_ALPHA)')
if [ -z "$CKPT" ] || [ ! -f "$CKPT" ]; then
  say "ABORT: pinned checkpoint missing: $CKPT"; exit 4
fi
say "pinned alpha = $PIN -> $CKPT"

# Cross-check: what would a max-scan of the phase-3 evals have chosen? This is
# informational. It reports EVERY alpha at the maximum, so a tie is visible as
# a tie rather than being collapsed to whichever file came first.
SCAN=$($V - <<'EOF'
import json, glob, os
top = -1.0
best = []
for p in sorted(glob.glob("runs/ft_tiny39_fresh/nbeval_a*.json")):
    try:
        d = json.load(open(p))
    except Exception:
        continue
    s = d.get("student")
    t = s.get("top1") if isinstance(s, dict) else d.get("student_top1")
    if t is None:
        continue
    a = os.path.basename(p).replace("nbeval_a", "").replace(".json", "")
    if t > top:
        top, best = t, [a]
    elif t == top:
        best.append(a)
print(",".join(best) + " " + ("%.2f" % top) if best else "")
EOF
)

if [ -z "$SCAN" ]; then
  say "WARNING: no phase-3 eval results, cross-check skipped"
else
  SCAN_A=${SCAN%% *}
  SCAN_T=${SCAN##* }
  say "cross-check: eval scan peaks at top1 $SCAN_T for alpha(s) $SCAN_A"
  case ",$SCAN_A," in
    *",$PIN,"*)
      if [ "$SCAN_A" != "$PIN" ]; then
        say "cross-check OK: the pin $PIN is among the tied maxima ($SCAN_A)."
        say "  A tie is why the alpha is pinned rather than scanned."
      else
        say "cross-check OK: scan and pin agree on $PIN"
      fi
      ;;
    *)
      say ""
      say "########################################################"
      say "# WARNING: SCAN AND PIN DISAGREE                        #"
      say "########################################################"
      say "#  pinned alpha (shipped_model.py) : $PIN"
      say "#  scan best alpha(s)              : $SCAN_A  (top1 $SCAN_T)"
      say "#"
      say "#  Neither is preferred silently. Either the pin is now"
      say "#  stale and shipped_model.py must be updated with the"
      say "#  reasoning, or the eval JSONs are from a different run."
      say "#  Remember runs/ft_tiny39_fresh/ holds SIX alphas and"
      say "#  wise_a0.90.pt is the PREVIOUS model's optimum."
      say "#"
      say "#  Re-run with --allow-mismatch to proceed on the PIN."
      say "########################################################"
      if [ "$ALLOW_MISMATCH" -ne 1 ]; then
        say "ABORT: pin/scan mismatch and no --allow-mismatch"; exit 6
      fi
      say "proceeding on the PIN because --allow-mismatch was given"
      ;;
  esac
fi

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
