#!/usr/bin/env bash
#
# Fifth variant: place=* instead of the curated admin list.
#
# Kept OUT of run-variants.sh on purpose. That script was already executing when
# this was added, and bash reads a script incrementally rather than loading it
# whole, so editing a running script can make the live shell execute garbage
# from a shifted byte offset.
#
# Measured on central-america before queueing: place=* costs +21% over the
# curated list (27.5 MB vs 22.8 MB) and what it adds is mostly what we would
# rank out anyway: 229 archipelago, 67 state, 53 region, 46 province. Those are
# the same huge admin polygons the original tag audit rejected on median area,
# plus the archipelago version of the landmass problem. The only genuinely
# useful additions were 4 farm and 2 isolated_dwelling per 500 tiles.
#
# Built anyway because a measured number beats an argument, and 3.6 GB versus
# 3.0 GB is immaterial against a 10 GB tier.
set -uo pipefail

BUILD=/home/jlian/build-global-variant.sh
OUT=/home/jlian/variants
LOG=/home/jlian/variant-runs.log
mkdir -p "$OUT"

name=place-all
work="/mnt/ssdscratch/var-$name"
FILTER_ALL="wr/leisure=park,nature_reserve,garden,golf_course wr/boundary=protected_area,national_park wr/landuse=forest,recreation_ground wr/natural wr/place wr/tourism"

say() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

if [ -s "$OUT/$name.pmtiles" ]; then
  say "SKIP $name: already built"
  exit 0
fi

avail=$(df -BG --output=avail /mnt/ssdscratch | tail -1 | tr -dc '0-9')
if [ "$avail" -lt 150 ]; then
  say "ABORT $name: only ${avail}G free on /mnt/ssdscratch"
  exit 1
fi

say "START $name (${avail}G free)"
rm -rf "$work"
mkdir -p "$work"
t0=$SECONDS

# Cleanup must run on every path, so the failure is recorded in `status` and
# returned at the end. Otherwise the script exits 0 after a failed build and a
# caller cannot tell that no archive was produced.
status=0
if FILTER="$FILTER_ALL" NAMED_ONLY=1 JOBS=2 WORK="$work" \
     TMPDIR=/mnt/ssdscratch/tmp "$BUILD" > "/home/jlian/variant-$name.log" 2>&1; then
  if [ -s "$work/planet-parks.pmtiles" ]; then
    mv "$work/planet-parks.pmtiles" "$OUT/$name.pmtiles"
    say "DONE $name in $((SECONDS - t0))s -> $(du -h "$OUT/$name.pmtiles" | cut -f1)"
  else
    say "FAILED $name: no pmtiles produced"
    status=1
  fi
else
  say "FAILED $name: build exited non-zero"
  status=1
fi

rm -rf "$work"
say "=== place-all variant finished ==="
exit "$status"
