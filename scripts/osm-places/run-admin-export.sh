#!/usr/bin/env bash
# Export administrative boundaries carrying ISO 3166 codes, globally.
#
# Produces the `admin-iso.geojsonseq` that `enrich-search-regions.py` joins
# against. The reverse archive builds its `admin` layer by streaming straight
# into Tippecanoe and deleting the intermediate PBF, so nothing on disk was
# reusable and this stage was originally run by hand. A pipeline that depends on
# a file no committed script produces is not reproducible, so it lives here now.
#
# Same source and same filter as `build-global.sh`'s admin layer
# (`boundary=administrative`), so forward and reverse search cannot resolve a
# coordinate to different jurisdictions.
#
# Levels 2-4 carry the ISO 3166 codes and NOTHING ELSE DOES, so they alone
# decide `state` and `country`. Level 6 is added for the DISPLAY name only.
# Without it the locality shown for a place in Washington is `Washington`, which
# is what the ISO code already says, so two parks sharing a name and a state
# render as identical rows. Level 6 is the county in the countries that map one,
# and it is the smallest containing boundary, so the join picks it up while the
# codes still come from the ISO-bearing ancestor.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${WORK:-/mnt/ssdscratch}"
SRC="${SRC:-/mnt/nas/wikidata/regions}"
OUT="${OUT:-$WORK/search}"
ADMIN_FILTER="${ADMIN_FILTER:-r/boundary=administrative}"
ADMIN_LEVELS="${ADMIN_LEVELS:-r/admin_level=2,3,4,6}"

REGIONS=(africa antarctica asia australia-oceania central-america europe north-america south-america)

mkdir -p "$OUT"
LOG="$WORK/admin-export.log"
: > "$LOG"

RAW="$OUT/admin-raw.geojsonseq"
: > "$RAW"

for r in "${REGIONS[@]}"; do
  src="$SRC/$r.osm.pbf"
  if [ ! -s "$src" ]; then
    echo "  FAILED $r: no source extract at $src" | tee -a "$LOG" >&2
    exit 1
  fi
  t0=$SECONDS
  osmium tags-filter -o "$OUT/$r-adm.pbf" --overwrite "$src" $ADMIN_FILTER 2>>"$LOG"
  osmium tags-filter -o "$OUT/$r-adm24.pbf" --overwrite "$OUT/$r-adm.pbf" $ADMIN_LEVELS 2>>"$LOG"
  osmium export "$OUT/$r-adm24.pbf" -f geojsonseq --geometry-types=polygon -o - 2>>"$LOG" >> "$RAW"
  rm -f "$OUT/$r-adm.pbf" "$OUT/$r-adm24.pbf"
  echo "done $r in $((SECONDS-t0))s" | tee -a "$LOG"
done

# Keep ONLY the features carrying an ISO code, and only the tags the join reads.
#
# `osmium export` emits every member way of a boundary relation as its own
# feature, so the raw file is dominated by coastlines and islands that merely
# belong to a boundary. Measured globally at levels 2-4: 288,613 features, of
# which 5,003 carry a code. Filtering here keeps the enrichment input small.
#
# Keep a feature if it carries an ISO code (it can supply `state`/`country`) OR
# it is a level-6 boundary with a name (it can supply the display locality).
# Requiring a code would discard every county, since ISO 3166 stops at the
# subdivision.
python3 - "$RAW" "$OUT/admin-iso.geojsonseq" <<'PY'
import json
import sys

src, dst = sys.argv[1], sys.argv[2]
kept = 0
coded = 0
local = 0
with open(src, encoding="utf-8") as fh, open(dst, "w", encoding="utf-8") as out:
    for line in fh:
        line = line.strip().lstrip("\x1e")
        if not line:
            continue
        try:
            feature = json.loads(line)
        except json.JSONDecodeError:
            continue
        props = feature.get("properties") or {}
        has_code = bool(
            props.get("ISO3166-2") or props.get("ISO3166-1:alpha2") or props.get("ISO3166-1")
        )
        named_level6 = str(props.get("admin_level", "")) == "6" and bool(props.get("name"))
        if not (has_code or named_level6):
            continue
        if has_code:
            coded += 1
        else:
            local += 1
        slim = {
            k: props[k]
            for k in (
                "ISO3166-2", "ISO3166-1:alpha2", "ISO3166-1",
                "name", "name:en", "admin_level",
            )
            if k in props
        }
        out.write(json.dumps({"type": "Feature", "properties": slim, "geometry": feature["geometry"]}))
        out.write("\n")
        kept += 1
print(f"  boundaries kept: {kept:,} ({coded:,} ISO-coded, {local:,} named level 6)", file=sys.stderr)
if coded == 0:
    sys.exit("no ISO-coded boundaries found; refusing to write an empty admin file")
PY

rm -f "$RAW"
echo "TOTAL $(wc -l < "$OUT/admin-iso.geojsonseq") boundaries, $(du -h "$OUT/admin-iso.geojsonseq" | cut -f1)" | tee -a "$LOG"
echo DONE > "$WORK/admin-export.DONE"
