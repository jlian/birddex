#!/usr/bin/env bash
# Export forward-search records for every region from the CACHED filtered PBFs.
#
# Reads the filtered extracts that `build-global.sh` already produced for the
# reverse archive, so this costs no re-filtering of the 84 GB planet source.
#
# The cache key is a hash of the tag FILTER plus the source extract's identity,
# computed the same way `build-global.sh` computes it, so the two builds cannot
# silently read different vintages of the same region.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${WORK:-/mnt/ssdscratch}"
SRC="${SRC:-/mnt/nas/wikidata/regions}"
FCACHE="${FCACHE:-/mnt/nas/wikidata/filtered}"
OUT="${OUT:-$WORK/search}"
NAMED_ONLY="${NAMED_ONLY:-1}"
EXPORT_CONFIG="${EXPORT_CONFIG:-$SCRIPT_DIR/search-export.json}"
RECORDS="${RECORDS:-$SCRIPT_DIR/build-search-records.py}"

# Must match FILTER in build-global.sh, or the cache key will not resolve.
FILTER="${FILTER:-wr/leisure=park,nature_reserve,garden,golf_course wr/boundary=protected_area,national_park wr/landuse=forest,recreation_ground wr/natural wr/place wr/tourism}"

REGIONS=(africa antarctica asia australia-oceania central-america europe north-america south-america)

mkdir -p "$OUT"
LOG="$WORK/search-export.log"
: > "$LOG"

for r in "${REGIONS[@]}"; do
  src_id=$(stat -c '%s:%Y' "$SRC/$r.osm.pbf" 2>/dev/null || echo 'missing')
  fkey=$(printf '%s|named=%s|src=%s' "$FILTER" "$NAMED_ONLY" "$src_id" | md5sum | cut -c1-8)
  cached="$FCACHE/$r-$fkey.osm.pbf"
  # FAIL, do not skip. This builds the GLOBAL artifact, so a missing region is
  # not a warning: continuing would concatenate whatever stale $r.tsv happened
  # to be on disk, producing a mixed-vintage corpus, and would still write the
  # completion marker as though the build were whole.
  if [ ! -s "$cached" ]; then
    echo "  FAILED $r: no filtered extract at $cached; run build-global.sh first" | tee -a "$LOG" >&2
    exit 1
  fi
  # Remove any previous output for this region before writing, so a failure
  # partway through cannot leave a readable file from an older run.
  rm -f "$OUT/$r.tsv"
  t0=$SECONDS
  osmium export "$cached" -f geojsonseq -c "$EXPORT_CONFIG" -o - 2>>"$LOG" \
    | python3 "$RECORDS" > "$OUT/$r.tsv" 2>>"$LOG"
  rc=("${PIPESTATUS[@]}")
  if [ "${rc[0]}" -ne 0 ] || [ "${rc[1]}" -ne 0 ]; then
    echo "  FAILED $r: osmium=${rc[0]} records=${rc[1]} (see $LOG)" | tee -a "$LOG" >&2
    rm -f "$OUT/$r.tsv"
    exit 1
  fi
  echo "done $r in $((SECONDS-t0))s rows=$(wc -l < "$OUT/$r.tsv") size=$(du -h "$OUT/$r.tsv" | cut -f1)" | tee -a "$LOG"
done

# Concatenate in a FIXED order so the combined file is reproducible.
#
# `cat` is checked explicitly rather than trusted. This script deliberately does
# not use errexit, because the per-region loop reports which stage failed, so a
# read error here would otherwise fall straight through to the completion marker
# and publish a TRUNCATED global corpus as a finished build.
: > "$OUT/all.tsv"
for r in "${REGIONS[@]}"; do
  if [ ! -s "$OUT/$r.tsv" ]; then
    echo "  FAILED: $OUT/$r.tsv is missing or empty after export" | tee -a "$LOG" >&2
    rm -f "$OUT/all.tsv"
    exit 1
  fi
  if ! cat "$OUT/$r.tsv" >> "$OUT/all.tsv"; then
    echo "  FAILED: could not append $OUT/$r.tsv to the global corpus" | tee -a "$LOG" >&2
    rm -f "$OUT/all.tsv"
    exit 1
  fi
done

# The concatenated file must hold every region's rows. A short count means a
# truncated read that still exited zero.
expected=0
for r in "${REGIONS[@]}"; do
  expected=$(( expected + $(wc -l < "$OUT/$r.tsv") ))
done
actual=$(wc -l < "$OUT/all.tsv")
if [ "$expected" -ne "$actual" ]; then
  echo "  FAILED: global corpus has $actual rows, expected $expected" | tee -a "$LOG" >&2
  rm -f "$OUT/all.tsv"
  exit 1
fi
echo "TOTAL rows=$actual size=$(du -h "$OUT/all.tsv" | cut -f1)" | tee -a "$LOG"
echo DONE > "$WORK/search-export.DONE"
