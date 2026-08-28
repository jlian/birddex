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
  if [ ! -s "$cached" ]; then
    echo "  MISSING filtered extract for $r ($cached); run build-global.sh first" | tee -a "$LOG" >&2
    continue
  fi
  t0=$SECONDS
  osmium export "$cached" -f geojsonseq -c "$EXPORT_CONFIG" -o - 2>>"$LOG" \
    | python3 "$RECORDS" > "$OUT/$r.tsv" 2>>"$LOG"
  rc=("${PIPESTATUS[@]}")
  if [ "${rc[0]}" -ne 0 ] || [ "${rc[1]}" -ne 0 ]; then
    echo "  FAILED $r: osmium=${rc[0]} records=${rc[1]} (see $LOG)" | tee -a "$LOG" >&2
    exit 1
  fi
  echo "done $r in $((SECONDS-t0))s rows=$(wc -l < "$OUT/$r.tsv") size=$(du -h "$OUT/$r.tsv" | cut -f1)" | tee -a "$LOG"
done

# Concatenate in a FIXED order so the combined file is reproducible.
: > "$OUT/all.tsv"
for r in "${REGIONS[@]}"; do
  [ -s "$OUT/$r.tsv" ] && cat "$OUT/$r.tsv" >> "$OUT/all.tsv"
done
echo "TOTAL rows=$(wc -l < "$OUT/all.tsv") size=$(du -h "$OUT/all.tsv" | cut -f1)" | tee -a "$LOG"
echo DONE > "$WORK/search-export.DONE"
