#!/usr/bin/env bash
# Set the Windows AC standby-idle timer on Tomahawk, in seconds.
#   sleeptimer.sh 60     -> sleep after 1 min idle, for wake testing
#   sleeptimer.sh 1800   -> restore the normal 30 min
# Always restore 1800 when done; a 60s timer makes the box unusable.
set -uo pipefail
SECS=${1:?usage: sleeptimer.sh <seconds>}
PS=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
ssh -o ConnectTimeout=20 tomahawk-wsl \
  "$PS -NoProfile -Command \"powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP STANDBYIDLE $SECS; powercfg /setactive SCHEME_CURRENT\"" >/dev/null 2>&1
ssh -o ConnectTimeout=20 tomahawk-wsl \
  "$PS -NoProfile -Command \"powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE\"" 2>/dev/null | grep -i "Current AC"
