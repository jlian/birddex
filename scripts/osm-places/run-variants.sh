#!/usr/bin/env bash
#
# Run the archive-size variants back to back, overnight.
#
# Purpose: the current natural=* build is tracking about 1.51x the previous
# archive, which projects to 8.0-8.7 GB and lands near R2's 10 GB free tier
# once wingdex-models and wingdex-range-priors are counted. Rather than guess
# which trade to make, build each candidate and measure it.
#
# Variants, cheapest lever first:
#   1 natural-named    natural=* plus a named-only pass
#   2 natural-admin    the above plus place=city/town/village/... fallback
#   3 trim-named       a trimmed natural list (no glacier) plus named-only
#   4 trim-admin       the above plus the admin fallback
#
# The named-only pass is the important one: unnamed features are discarded at
# query time, so tiling them is waste. Measured on central-america with
# natural=*, it cut the tileset 45.0 MB -> 18.1 MB while tile count fell only
# 18,874 -> 17,604.
#
# Runs STRICTLY one at a time. Two tippecanoe pairs at JOBS=2 already saturate
# the box, and overlapping runs would make every timing meaningless.
set -uo pipefail

BUILD=/home/jlian/build-global-variant.sh
OUT=/home/jlian/variants
LOG=/home/jlian/variant-runs.log
mkdir -p "$OUT"

NAT="wr/leisure=park,nature_reserve,garden,golf_course wr/boundary=protected_area,national_park wr/landuse=forest,recreation_ground wr/natural wr/place=island,islet,neighbourhood wr/tourism"
# Trimmed: the values the tile audit found both NAMED and polygonal, minus
# glacier, which alone took antarctica from 11 MB to 77 MB.
TRIM="wr/leisure=park,nature_reserve,garden,golf_course wr/boundary=protected_area,national_park wr/landuse=forest,recreation_ground wr/natural=wood,beach,wetland,bay,water,coastline,grassland,scrub,heath,sand,bare_rock,reef,valley wr/place=island,islet,neighbourhood wr/tourism"
ADMIN=" wr/place=city,town,village,hamlet,suburb,borough,municipality"

say() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

run_variant() {
  local name="$1" filter="$2"
  local work="/mnt/ssdscratch/var-$name"

  if [ -s "$OUT/$name.pmtiles" ]; then
    say "SKIP $name: already built ($(du -h "$OUT/$name.pmtiles" | cut -f1))"
    return 0
  fi

  # Free space check before starting. A region build needs room for the PBFs,
  # the per-region tilesets and the merged output; 150 GB is comfortable.
  local avail
  avail=$(df -BG --output=avail /mnt/ssdscratch | tail -1 | tr -dc '0-9')
  if [ "$avail" -lt 150 ]; then
    say "ABORT $name: only ${avail}G free on /mnt/ssdscratch"
    return 1
  fi

  say "START $name (${avail}G free)"
  rm -rf "$work"
  mkdir -p "$work"

  local t0=$SECONDS
  if FILTER="$filter" NAMED_ONLY=1 JOBS=2 WORK="$work" \
       TMPDIR=/mnt/ssdscratch/tmp "$BUILD" > "/home/jlian/variant-$name.log" 2>&1; then
    if [ -s "$work/planet-parks.pmtiles" ]; then
      mv "$work/planet-parks.pmtiles" "$OUT/$name.pmtiles"
      say "DONE $name in $((SECONDS - t0))s -> $(du -h "$OUT/$name.pmtiles" | cut -f1)"
    else
      say "FAILED $name: no pmtiles produced"
    fi
  else
    say "FAILED $name: build exited non-zero (see variant-$name.log)"
  fi

  # Reclaim the per-region tilesets immediately. Four variants of intermediate
  # files would fill the volume; only the merged archive is worth keeping.
  rm -rf "$work"
}

say "=== variant sweep starting ==="
# natural-admin FIRST: it is the widest data set and the one most likely to
# ship, so if only one finishes overnight it should be that one. The others are
# fallbacks in case it comes out too large.
# Only two variants are worth building.
#
# An earlier version of this sweep had four, adding natural-named (no admin
# fallback), trim-admin and trim-named (a reduced natural list without glacier
# and coastline). All three existed to trade DATA AWAY for SPACE, back when the
# archive was projected at 8.5 GB against R2's 10 GB free tier.
#
# The named-only pass removed that constraint: unnamed features were 78.3% of
# stored geometry and are discarded at query time anyway, so dropping them took
# central-america from 45.0 MB to 22.8 MB WITH natural=* and the admin fallback
# both included. At a projected 3.6 GB there is no reason to build a smaller,
# worse archive, and trimming natural would discard coastline and glacier, both
# real birding habitat, to save space that is not needed.
run_variant natural-admin "$NAT$ADMIN"

say "=== variant sweep finished ==="
ls -la "$OUT" | tee -a "$LOG"
