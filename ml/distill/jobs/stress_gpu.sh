#!/bin/bash
# Instrumented GPU stress test for the Tomahawk hard-hang investigation.
#
# TWO CRASHES, NO EVIDENCE:
#   2026-08-01 15:01:33  after ~26h sustained GPU load
#   2026-08-01 23:22:47  after ~20min GPU load
# Both: Kernel-Power 41 + Event 6008, NO WHEA, NO dump, no TDR. John reported
# "light on, no video" = total hard hang, machine stopped executing.
#
# GOAL: reproduce under instrumentation, so we learn WHICH resource is at its
# limit when it dies. Telemetry is flushed to disk every sample, so whatever
# the last line says at the moment of death IS the evidence.
#
# Logs go to /home (NOT /tmp) because /tmp is wiped on boot and both crashes
# already destroyed their own logs that way.
set -u
OUT=/home/jlian/stress-$(date +%Y%m%d-%H%M%S)
mkdir -p "$OUT"
SMI=/usr/lib/wsl/lib/nvidia-smi
DUR=${1:-900}

echo "stress test -> $OUT   duration ${DUR}s"

# --- telemetry sampler: 1 Hz, line-buffered, fsync-ish via >> ---
(
  echo "ts,gpu_util,mem_used_mb,temp_c,power_w,pstate,clk_sm,clk_mem,throttle"
  while true; do
    L=$($SMI --query-gpu=utilization.gpu,memory.used,temperature.gpu,power.draw,pstate,clocks.sm,clocks.mem \
        --format=csv,noheader,nounits 2>/dev/null | tr -d " ")
    R=$($SMI --query-gpu=clocks_throttle_reasons.active --format=csv,noheader 2>/dev/null | tr -d " ")
    echo "$(date +%H:%M:%S),$L,$R"
    sleep 1
  done
) >> "$OUT/gpu.csv" &
SAMPLER=$!

# --- heartbeat: proves how far we got if the box dies mid-test ---
(
  while true; do
    echo "$(date +%H:%M:%S) alive load=$(cut -d\  -f1-3 /proc/loadavg)"
    sleep 5
  done
) >> "$OUT/heartbeat.log" &
HB=$!

cleanup () { kill $SAMPLER $HB 2>/dev/null; }
trap cleanup EXIT

# --- the load itself: same shape as the workload that crashed (matmul-heavy
#     fp16 on the 3080), ramped so we can see WHICH intensity triggers it ---
cd /home/jlian/wingdex/ml/distill || exit 1
./.venv/bin/python jobs/gpu_burn.py --seconds "$DUR" 2>&1 | tee "$OUT/burn.log"
RC=$?

cleanup
echo "exit=$RC" | tee -a "$OUT/burn.log"
echo ""
echo "=== telemetry summary ==="
./.venv/bin/python - "$OUT/gpu.csv" << "PYEOF"
import csv, sys
rows = list(csv.DictReader(open(sys.argv[1])))
def col(n):
    out = []
    for r in rows:
        try:
            out.append(float(r[n]))
        except (ValueError, TypeError, KeyError):
            pass
    return out
if not rows:
    print("no telemetry captured")
else:
    print("samples:", len(rows), " span:", rows[0]["ts"], "->", rows[-1]["ts"])
    for n, unit in [("temp_c","C"), ("power_w","W"), ("clk_sm","MHz"), ("gpu_util","%")]:
        v = col(n)
        if v:
            print("  %-9s max %7.1f %-3s  avg %7.1f" % (n, max(v), unit, sum(v)/len(v)))
    thr = set(r.get("throttle","") for r in rows)
    thr = [t for t in thr if t and t.lower() not in ("notactive","n/a")]
    print("  throttle reasons seen:", thr if thr else "none")
PYEOF
echo ""
echo "artifacts in $OUT"
touch /home/jlian/stress.done
