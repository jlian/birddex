#!/usr/bin/env bash
# Build the PMTiles place archive for #308.
#
# Reproducibility matters here beyond good practice: publishing this script is
# how we satisfy ODbL section 4.6(b), which lets us offer "the method of making
# the alterations" instead of hosting the derived database.
#
# Run on LOCAL DISK. Tippecanoe needs SQLite locking and fails on CIFS/NFS with
# "database is locked".
set -euo pipefail

REGION="${1:-north-america/us/washington}"
WORK="${2:-$PWD/osm-build}"
NAME="$(basename "$REGION")"

mkdir -p "$WORK"
cd "$WORK"

echo "==> downloading $REGION"
curl -sL -o "$NAME.osm.pbf" "https://download.geofabrik.de/$REGION-latest.osm.pbf"

# No water/bay/waterway: a creek or bay polygon routinely contains a point that
# belongs to the park around it, which made Union Bay Natural Area resolve to
# Ravenna Creek. Production's Geoapify query does not ask for them either.
echo "==> filtering to named places worth naming an outing after"
osmium tags-filter -o "$NAME-parks.osm.pbf" --overwrite "$NAME.osm.pbf" \
  wr/leisure=park,nature_reserve,garden \
  wr/boundary=protected_area,national_park \
  wr/landuse=forest \
  wr/natural=wood,beach

echo "==> exporting geojson"
osmium export "$NAME-parks.osm.pbf" -o "$NAME-parks.geojson" --overwrite -f geojson

echo "==> tiling at z13"
# -pf/-pk disable the feature-dropping limits that would silently discard
# polygons to hit a tile size target. We want every named place kept.
#
# Build to a temp path and rename over the destination only after the tileset
# clears a size floor. tippecanoe --force truncates its output BEFORE the build
# succeeds, so pointing it straight at "$NAME-parks.pmtiles" means an
# interruption, a full disk or a tippecanoe error leaves no archive at all.
# Writing a temp file and moving the previous archive aside keeps the last good
# build as the only rollback that exists, matching build-global.sh.
MIN_PMTILES_BYTES="${MIN_PMTILES_BYTES:-1048576}"
tippecanoe -o "$NAME-parks.pmtiles.tmp" --force -z13 -Z13 -pf -pk \
  --no-simplification-of-shared-nodes \
  --no-tiny-polygon-reduction \
  -l parks "$NAME-parks.geojson"

outsz=$(stat -c %s "$NAME-parks.pmtiles.tmp" 2>/dev/null || echo 0)
if [ "$outsz" -lt "$MIN_PMTILES_BYTES" ]; then
  echo "==> FAILED: new tileset is only ${outsz}B (min $MIN_PMTILES_BYTES), keeping previous archive" >&2
  rm -f "$NAME-parks.pmtiles.tmp"
  exit 1
fi
# Move any previous archive aside rather than deleting it, then rename the new
# one into place atomically.
[ -e "$NAME-parks.pmtiles" ] && mv -f "$NAME-parks.pmtiles" "$NAME-parks.pmtiles.prev-$(date +%Y%m%d-%H%M%S)"
mv -f "$NAME-parks.pmtiles.tmp" "$NAME-parks.pmtiles"

ls -la "$NAME-parks.pmtiles"
echo "==> done: $WORK/$NAME-parks.pmtiles"
