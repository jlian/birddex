#!/usr/bin/env bash
# Global OSM place archive for #308, parallelised.
#
# The naive version (one osmium pass over planet.osm.pbf, then one tippecanoe run)
# was measured at roughly 2.5 hours for the filter alone, reading 279 GB across
# passes, and tiling would have taken longer still. This version splits the work
# by continent so both stages run concurrently.
#
# Why sharding helps here specifically:
#   - osmium tags-filter is multi-threaded but bounded by a two-pass read of one
#     huge file. Six independent files are read and filtered in parallel instead.
#   - tippecanoe parallelises within a tileset, but six smaller tilesets finish
#     far sooner than one planet-sized one, and tile-join merges them cheaply.
#   - A failure costs one continent, not the whole run.
#
# Geofabrik continent extracts total ~84 GB against the 94 GB planet file, so the
# duplication is small and the download can also run concurrently.
#
# Run on LOCAL DISK. tippecanoe needs SQLite locking and fails on CIFS/NFS with
# "database is locked". Source PBFs may live on the NAS; outputs must not.
set -euo pipefail

# Re-exec under a PRIVATE MOUNT NAMESPACE with /tmp bound to scratch storage.
#
# Needed because tippecanoe hardcodes /tmp/sort1 and /tmp/sort2 (see the note on
# TMPDIR below). Everything inside this namespace sees /tmp on the scratch
# volume; nothing outside is affected, and the mount is torn down automatically
# when the process tree exits. Requires unshare(1) and root, so it degrades to a
# loud warning rather than silently filling the root disk.
if [ "${TMPNS:-0}" != "1" ]; then
  _scratch_tmp="${TMPDIR:-/mnt/ssdscratch/tmp}"
  mkdir -p "$_scratch_tmp"
  if command -v unshare >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    echo "==> re-exec with /tmp bound to $_scratch_tmp (tippecanoe hardcodes /tmp/sort*)"
    # CARRY THE ENVIRONMENT EXPLICITLY.
    #
    # `sudo -n` resets the environment and `setpriv` does not restore it, so a
    # re-exec that relies on inherited exports silently loses them and every
    # ${VAR:-default} falls back. That happened here: WORK reverted to the
    # default, the run picked up STALE Aug-13 z13 tilesets sitting there, and
    # the merge step was about to fold them into a z12 archive. Pass each
    # variable by name instead of trusting inheritance.
    exec sudo -n unshare -m --propagation private /bin/bash -c \
      "mount --bind '$_scratch_tmp' /tmp && exec setpriv --reuid=$(id -u) --regid=$(id -g) --clear-groups \
        env TMPNS=1 \
            TMPDIR='$_scratch_tmp' \
            WORK='${WORK:-/home/jlian/globalbuild}' \
            SRC='${SRC:-/mnt/nas/wikidata/regions}' \
            FCACHE='${FCACHE:-/mnt/nas/wikidata/filtered}' \
            JOBS='${JOBS:-2}' \
            FORCE='${FORCE:-0}' \
            NAMED_ONLY='${NAMED_ONLY:-1}' \
            FILTER='${FILTER:-}' \
            MIN_MBTILES_BYTES='${MIN_MBTILES_BYTES:-}' \
            ADMIN_FILTER='${ADMIN_FILTER:-}' \
            ADMIN_LEVELS='${ADMIN_LEVELS:-}' \
            ADMIN_LAYER='${ADMIN_LAYER:-}' \
            MIN_ADMIN_BYTES='${MIN_ADMIN_BYTES:-}' \
            '$(readlink -f "$0")'"
  fi
  echo "WARNING: no mount namespace available. tippecanoe sort1/sort2 will write to /tmp on the ROOT volume." >&2
  echo "WARNING: that filled the disk on 2026-08-26 at 10.5 GB per 45s. Watch df -h / closely." >&2
fi

SRC="${SRC:-/mnt/nas/wikidata/regions}"     # where continent PBFs live (NAS is fine)
WORK="${WORK:-/home/jlian/globalbuild}"     # local disk, tippecanoe writes here
FCACHE="${FCACHE:-/mnt/nas/wikidata/filtered}"  # filtered PBFs, reused across tilings
# Two regions at a time. Three concurrent runs filled a 477 GB volume and wedged
# WSL. Note that streaming does NOT fix that: the 27 GB GeoJSON it eliminates was
# minor next to ~200 GB of tippecanoe scratch, which scales with feature count
# however the features arrive. What makes 2 safe is headroom, so check free space
# before raising this.
JOBS="${JOBS:-2}"

# Minimum size for a .mbtiles to count as real, used by BOTH the skip guard and
# the post-build success check. A killed tippecanoe leaves a ~28 KB SQLite
# header, which is non-empty and therefore passes a naive `-s` test.
MIN_MBTILES_BYTES="${MIN_MBTILES_BYTES:-1048576}"

# The admin layer is smaller than the parks layer, but every real one measured
# still clears 1 MiB: the smallest, antarctica, is 4.4 MB. The old 16 KB floor
# sat BELOW tippecanoe's ~28 KB killed-run stub, so a stub passed both the
# resume guard and the success check. Reuse the same 1 MiB floor the parks layer
# uses: comfortably above the stub and below every real admin layer.
MIN_ADMIN_BYTES="${MIN_ADMIN_BYTES:-1048576}"

# tippecanoe writes scratch to TWO places, and they need DIFFERENT fixes.
#
# 1. geom/index/node/pool/read/tree/vertex honour `--temporary-directory` (-t)
#    and IGNORE the TMPDIR environment variable.
# 2. sort1/sort2 ignore BOTH. The paths are compiled into the binary; v2.49.0
#    contains the literal strings "/tmp/sort1.XXXXX" and "/tmp/sort2.XXXXX",
#    so no flag and no environment variable can move them.
#
# Both bit this build. Adding -t alone still put 72.5 GB of sort files on the
# WSL root and was heading for a full disk in ~15 minutes at 10.5 GB/45s.
# The only fix for (2) is to make /tmp itself not live on the root, which is
# what `unshare -m` below does: a private mount namespace where /tmp is bound
# to scratch. The mount is invisible to the rest of the system and disappears
# when the build exits.
#
# The scratch is also INVISIBLE to `ls /tmp`: tippecanoe unlinks each file
# immediately and keeps the fd open, so only lsof / /proc/PID/fd can see it.
# Any "is /tmp clean?" check based on a directory listing reports healthy while
# the disk fills.
#
# This bit twice. On 2026-08-26 the run was launched with TMPDIR=/mnt/ssdscratch/tmp
# and the process environment genuinely showed TMPDIR set, while lsof showed the
# scratch going to /tmp on the WSL root: 24 GB of it, climbing, on the volume that
# had already been filled to 0 bytes once.
#
# The scratch is INVISIBLE to `ls /tmp`, because tippecanoe unlinks each file
# immediately and keeps the fd open. Only `lsof`/`/proc/PID/fd` show it, so any
# "is /tmp clean?" check that greps a directory listing will report healthy while
# the disk fills.
TMPDIR="${TMPDIR:-/mnt/ssdscratch/tmp}"
mkdir -p "$TMPDIR"
export TMPDIR

# Attributes to KEEP. Everything else is dropped at tile-build time.
#
# Measured on a 300-tile sample of the central-america tileset: 194 distinct
# attribute keys present, 8 read by the client. The rest is wikidata/wikipedia
# ids, start_date, operator, protect_class, protection_title, source, website,
# note, and a long tail of name:xx translations. The ranker reads name and
# name:en only, so every other language variant is pure download weight.
#
# These eight are exactly what functions/lib/place-rank.ts touches. Adding a
# ninth branch to the scorer means adding the tag here too, or it will be
# missing at runtime and the tier silently scores 0 -- the same class of bug as
# the absent tourism/place branches that made Taipei Zoo return null.
#
# `wikidata` is the one exception to "keep only what the ranker reads". It is
# not read at runtime; it is the JOIN KEY to the Wikidata place dump, which
# carries centroids and importance scores the OSM tags do not have. Measured on
# central-america, adding it costs 0.99% (39.03 -> 39.42 MB), about +55 MB on
# the global archive. Re-tiling later to add a 12-byte key would cost hours, so
# it is cheaper to carry it now than to need it later.
KEEP="-y name -y name:en -y tourism -y leisure -y natural -y boundary -y landuse -y place -y wikidata -y admin_level -y ISO3166-1 -y ISO3166-2"

# osmium export config: ONE geometry per object.
#
# By default osmium sets both `area_tags: true` and `linear_tags: true`, and the
# manual is explicit about what that means for a closed way: "If both match, an
# area and a linestring is created." So every closed park, lake and hotel was
# emitted TWICE, once as each. Measured on central-america: 38,514 of 49,770
# named LineStrings were twins of an area, and the duplicates reached the client
# as repeated picker entries (228 across the 25 sample photos).
#
# Listing only the genuinely LINEAR tags and leaving `area_tags` null inverts
# the rule: areas are created for everything else, so each object gets exactly
# one interpretation. Measured on central-america: twins 38,514 -> 0, while the
# features that are legitimately lines keep identical counts (2,710 rivers,
# 2,196 coastlines). Those matter; an earlier fix added named lines on purpose
# because rivers and coastlines are real answers.
#
# `--geometry-types=polygon` was tested first and REJECTED: it drops all 11,256
# genuine line features along with the twins.
#
# Note the area id is the way id times two, so a twin does NOT show up as a
# repeated id. Comparing ids directly reports zero duplicates and hides this.
EXPORT_CONFIG="$WORK/one-geometry.json"
write_export_config() {
  mkdir -p "$WORK"
  cat > "$EXPORT_CONFIG" <<'JSON'
{
    "attributes": { "type": false, "id": false },
    "linear_tags": [
        "waterway",
        "highway",
        "railway",
        "route",
        "barrier",
        "natural=coastline",
        "natural=cliff",
        "natural=ridge",
        "natural=arete",
        "natural=tree_row",
        "natural=valley",
        "natural=strait"
    ],
    "area_tags": null,
    "exclude_tags": [],
    "include_tags": []
}
JSON
}

REGIONS=(
  africa
  antarctica
  asia
  australia-oceania
  central-america
  europe
  north-america
  south-america
)

# Tag filter, as a single string. It is deliberately NOT a bash array: arrays do
# not survive `export -f` into the subshells xargs spawns, so an array silently
# expands to nothing there and osmium filters on no tags at all. That failure is
# quiet: it exits 0 and writes an empty file.
# Categories chosen from a measured audit of every named OSM feature in
# Washington, scored on three things: how many are NAMED (unnamed ones get
# discarded anyway), what fraction are POLYGONS (point-in-polygon cannot match a
# linestring), and MEDIAN AREA (a category whose typical feature spans km wins
# every lookup inside it and drowns out the park you are actually standing in).
#
# Excluded on that evidence: waterway=* is 0% polygons across 47k named features,
# so it can never be returned; boundary=administrative has a p90 of 135 km2;
# place=city/town/village are 3-14 km2 medians; amenity/landuse=residential are
# not places anyone names an outing after. natural=peak is 0% polygons too, so
# the earlier worry about mountains outranking parks was misplaced.
# `natural` is taken WHOLE rather than as a five-value list.
#
# The original list (wood, beach, wetland, bay, water) was chosen by measuring
# named-ness, polygon share and median area. That audit was right about which
# values are USABLE but wrong to treat the filter as the place to enforce it:
# excluding a category means it can never be returned, while including it costs
# little and the ranker can score it low. The same reasoning error produced the
# island bug, where data was thrown away instead of ranked down.
#
# Re-auditing all 45 natural values present in the z12 archive found one clear
# miss: coastline, 804 named features at 88% polygons. grassland, scrub,
# bare_rock, sand and heath are smaller but real. valley, divide and reef are
# large (0.97-3.1 km2 median) and would drown out better answers, so they are
# kept and ranked down rather than dropped.
#
# Measured cost on central-america: 39.5 MB -> 45.0 MB, +14%. Globally about
# 6.0 GB -> 6.8 GB.
#
# `waterway` is deliberately NOT here. It measured +44 percentage points on top
# of this (62.3 MB, +58% total, ~9.5 GB global) and every named waterway is a
# LINESTRING. Line support now works against the lines already in the archive
# and supplies 15.3% of answers at zero storage cost, so paying 3.5 GB for more
# of the same category is a bad trade.
# The admin values are a LAST-RESORT fallback, not competitors.
#
# 18.5% of 20,000 iNaturalist coordinates have no named OSM feature within 2 km,
# and the app then shows a raw coordinate string as the outing name. Nominatim
# reaches 99% coverage by falling back to townships and suburbs; these values do
# the same. `place-rank.ts` scores them below REAL_PLACE_FLOOR so they can only
# win when nothing real is in range.
#
# `wr/place` stays even though `boundary=administrative` is now also tiled. They
# answer DIFFERENT questions and one cannot replace the other: `place=*` says
# what somewhere is CALLED, `boundary=administrative` says which jurisdiction it
# is IN. Measured on central-america by feature id, dropping `place=*` in favour
# of admin boundaries would lose 44,447 named non-point features, including
# 8,207 islets, 4,529 neighbourhoods and 1,194 islands. Those are exactly the
# features that name a coastal bird photo.
# `wr/place` is bare on purpose: it must MATCH the deployed archive.
#
# An earlier curated list (island, islet, neighbourhood, city, town, village,
# hamlet, suburb, borough, municipality) was measured on central-america and
# rejected. Bare `place=*` costs about 21% more size and adds values the ranker
# explicitly scores, including farm and isolated_dwelling, which are exactly
# the last-resort names for rural coordinates. The deployed archive was built
# with the bare form, so a default run must reproduce it rather than quietly
# producing a narrower archive that looks the same.
FILTER="${FILTER:-wr/leisure=park,nature_reserve,garden,golf_course wr/boundary=protected_area,national_park wr/landuse=forest,recreation_ground wr/natural wr/place wr/tourism}"

# A SECOND, thin layer: administrative boundaries carrying ISO 3166 codes.
#
# The eBird export needs a state/province code and a country code, and polygons
# in the `parks` layer carry neither. They live on administrative boundaries as
# `ISO3166-1` and `ISO3166-2`, which the main filter never asked for, so only
# 139 leaked into the previous archive by accident.
#
# Restricted to admin_level 2-4 deliberately. ISO 3166 only defines country and
# subdivision codes, so lower levels carry none: measured on central-america,
# 335 of 2,237 polygons at levels 2-4 have a code, against 0 of 8,246 at level
# 10. Tiling the rest would be pure weight.
#
# Kept as its own LAYER rather than merged into `parks`, so "which state is this
# in" stays a separate question from "what is this place called", and the ranker
# never sees a province as a candidate answer.
ADMIN_FILTER="${ADMIN_FILTER:-r/boundary=administrative}"
ADMIN_LEVELS="${ADMIN_LEVELS:-r/admin_level=2,3,4}"
ADMIN_LAYER="${ADMIN_LAYER:-admin}"

mkdir -p "$SRC" "$WORK"

fetch() {
  local r="$1"
  [ -s "$SRC/$r.osm.pbf" ] && { echo "  have $r"; return; }
  echo "  downloading $r"
  curl -sL --retry 3 -o "$SRC/$r.osm.pbf" \
    "https://download.geofabrik.de/$r-latest.osm.pbf"
}

build_region() {
  # xargs runs this in a fresh `bash -c`, which does NOT inherit the parent's
  # `set -euo pipefail`. Without it, a failing `osmium export | tippecanoe`
  # pipeline returns tippecanoe's status, so an osmium failure is masked
  # whenever tippecanoe still exits 0 on the truncated stream. Re-arm strict
  # mode here so the child shell fails the same way the parent would.
  set -euo pipefail
  local r="$1"
  local t0=$SECONDS

  # RESUME: skip a region whose tileset is already built.
  #
  # This build gets interrupted a lot -- twice by a full volume in August, and
  # once by tippecanoe scratch landing on the wrong disk. Each restart redid
  # every finished region, which cost about two hours the last time.
  #
  # The size floor matters. tippecanoe creates the .mbtiles immediately and
  # fills it as it goes, so an interrupted region leaves a small file behind:
  # the two killed runs left europe and north-america at 28K each. Testing for
  # existence alone would treat those as done and ship an empty tileset.
  # 1 MiB is comfortably below the smallest real region (antarctica, 11 MB)
  # and far above an aborted stub.
  #
  # Pass FORCE=1 to rebuild regardless, which is what a filter or zoom change
  # needs: the outputs are still valid files, they are just stale.
  # Both layers must be present to count as done. Checking only the parks
  # tileset would let a run interrupted between the two stages resume as
  # "already built" and produce an archive with no ISO codes for that region.
  # The admin tileset keeps its own floor variable, but the same 1 MiB default
  # as the parks layer: every real admin layer clears it (antarctica, the
  # smallest, is 4.4 MB) while tippecanoe's ~28 KB killed-run stub does not.
  if [ "${FORCE:-0}" != "1" ] && [ -f "$WORK/$r.mbtiles" ]; then
    local sz asz
    sz=$(stat -c %s "$WORK/$r.mbtiles" 2>/dev/null || echo 0)
    asz=$(stat -c %s "$WORK/$r-admin.mbtiles" 2>/dev/null || echo 0)
    if [ "$sz" -ge "$MIN_MBTILES_BYTES" ] && [ "$asz" -ge "${MIN_ADMIN_BYTES:-1048576}" ]; then
      echo "  skip $r: already built ($(du -h "$WORK/$r.mbtiles" | cut -f1) + $(du -h "$WORK/$r-admin.mbtiles" | cut -f1) admin)"
      return 0
    fi
    if [ "$sz" -ge "$MIN_MBTILES_BYTES" ] && [ "$asz" -lt "${MIN_ADMIN_BYTES:-1048576}" ]; then
      echo "  rebuilding $r: parks tileset is present but the admin layer is missing or partial (${asz}B)"
    else
      echo "  rebuilding $r: existing mbtiles is only ${sz}B, treating as partial"
    fi
  fi

  # Once a rebuild is decided, DESTROY BOTH outputs before producing either.
  #
  # The two layers are built in sequence, and a run can die between them. If the
  # parks stage succeeds and the admin stage then fails, an old admin tileset
  # left lying next to the fresh parks tileset is worse than no file: both clear
  # their size floors, so the NEXT resume skips the region entirely and
  # tile-join merges two layers built from different inputs. That produces a
  # plausible archive whose ISO codes silently disagree with its place names.
  #
  # This runs for a FORCE rebuild too, where the outputs are valid but stale for
  # exactly the same reason.
  rm -f "$WORK/$r.mbtiles" "$WORK/$r-admin.mbtiles"

  # Pipe osmium straight into tippecanoe instead of staging a GeoJSON file.
  #
  # This is not a micro-optimisation. The staged version wrote 28 GB of GeoJSON
  # for Europe alone and 12 GB for North America, on top of tippecanoe's own
  # scratch, which is roughly 3x the input again. Running three regions at once
  # filled a 477 GB volume and wedged the whole WSL instance. Streaming removes
  # the intermediate entirely and overlaps export with tiling.
  #
  # geojsonseq is newline-delimited features. Read them via /dev/stdin, NOT the
  # bare `-`: tippecanoe accepts `-` without error but reads nothing from it,
  # then reports "Did not read any valid geometries" and exits 0. Silent success
  # with empty output.
  #
  # $FILTER is unquoted on purpose so it word-splits into arguments.
  # Cache the filtered PBF on the NAS, keyed by a hash of the TAG FILTER.
  #
  # The filter stage depends on $FILTER only, never on $KEEP or the zoom, so a
  # KEEP change like adding `wikidata` must not re-read 84.6 GB of source. The
  # key is a hash of $FILTER, so changing the tag list correctly invalidates it
  # while changing what tippecanoe keeps does not.
  local fkey cached
  fkey=$(printf '%s|named=%s' "$FILTER" "${NAMED_ONLY:-1}" | md5sum | cut -c1-8)
  cached="$FCACHE/$r-$fkey.osm.pbf"
  if [ -s "$cached" ]; then
    echo "  cached filter $r ($(du -h "$cached" | cut -f1))"
    cp "$cached" "$WORK/$r-parks.osm.pbf"
  else
    osmium tags-filter -o "$WORK/$r-parks.osm.pbf" --overwrite \
      "$SRC/$r.osm.pbf" $FILTER 2>"$WORK/$r.filter.log"
    if [ "${NAMED_ONLY:-1}" = "1" ]; then
      # Second pass: keep only objects that carry a name.
      #
      # The lookup discards every unnamed feature at query time, so tiling them
      # is pure waste. Measured on central-america with natural=*: the filtered
      # PBF drops 78.4 MB -> 29.5 MB and the tileset 45.0 MB -> 18.1 MB, a 60%
      # cut, while tile count only falls 18,874 -> 17,604 because the tiles that
      # disappear are the ones that held nothing usable.
      #
      # BOTH keys are required, not just `name`. osmium ORs the expressions, and
      # 24 of 28,993 sampled features carry `name:en` with no `name`; dropping
      # those would lose the English rendering for places like Taipei Zoo to
      # save nothing measurable.
      osmium tags-filter -o "$WORK/$r-named.osm.pbf" --overwrite \
        "$WORK/$r-parks.osm.pbf" name name:en 2>"$WORK/$r.named.log"
      mv -f "$WORK/$r-named.osm.pbf" "$WORK/$r-parks.osm.pbf"
    fi
    # Write via .tmp then rename, so an interrupted copy cannot leave a partial
    # file that a later run would trust.
    if [ -s "$WORK/$r-parks.osm.pbf" ] && [ -d "$FCACHE" ]; then
      cp "$WORK/$r-parks.osm.pbf" "$cached.tmp" && mv "$cached.tmp" "$cached"
    fi
  fi

  if [ ! -s "$WORK/$r-parks.osm.pbf" ]; then
    echo "  FAILED $r: tag filter produced nothing" >&2
    return 1
  fi

  # Run the export|tile pipeline with errexit off so the shell does not abort
  # before PIPESTATUS is read, then fail explicitly on either stage. Reading
  # PIPESTATUS reports WHICH stage died rather than inferring a masked upstream
  # failure from output size: osmium can fail while tippecanoe still exits 0 on
  # the truncated stream and writes a small but valid tileset the size floor
  # cannot catch.
  set +e
  osmium export "$WORK/$r-parks.osm.pbf" -f geojsonseq -c "$EXPORT_CONFIG" -o - 2>"$WORK/$r.export.log" \
    | tippecanoe -o "$WORK/$r.mbtiles" --force -z12 -Z12 -pf -pk \
        --no-simplification-of-shared-nodes --no-tiny-polygon-reduction \
        --temporary-directory="$TMPDIR" \
          $KEEP \
        -l parks /dev/stdin 2>"$WORK/$r.tip.log"
  local -a pipe_rc=("${PIPESTATUS[@]}")
  set -e
  if [ "${pipe_rc[0]}" -ne 0 ]; then
    echo "  FAILED $r: osmium export exited ${pipe_rc[0]} (see $r.export.log); upstream failure would otherwise be masked by tippecanoe" >&2
    rm -f "$WORK/$r.mbtiles"
    return 1
  fi
  if [ "${pipe_rc[1]}" -ne 0 ]; then
    echo "  FAILED $r: tippecanoe exited ${pipe_rc[1]} (see $r.tip.log)" >&2
    rm -f "$WORK/$r.mbtiles"
    return 1
  fi

  rm -f "$WORK/$r-parks.osm.pbf"

  # Build the ISO-code layer from the SAME source extract.
  #
  # Done here rather than as a separate top-level pass so it shares the region
  # loop's parallelism and failure handling, and so a region either produces
  # both layers or fails as a unit. `tile-join` then merges the two tilesets
  # into one archive carrying two layers.
  #
  # A missing admin tileset is FATAL rather than skipped. A silently absent
  # layer would leave the ISO lookup returning null everywhere, which looks
  # exactly like "this coordinate has no state code" and would not be noticed.
  local adm_pbf="$WORK/$r-adm.osm.pbf"
  local adm_lvl="$WORK/$r-adm24.osm.pbf"
  # Check these explicitly rather than relying on `set -e`. Under `set -e` a
  # failing osmium aborts the child shell immediately, which skips the cleanup
  # below and leaves the intermediate PBFs behind; reporting WHICH stage failed
  # also beats a bare non-zero exit in a log covering eight parallel regions.
  if ! osmium tags-filter -o "$adm_pbf" --overwrite \
       "$SRC/$r.osm.pbf" $ADMIN_FILTER 2>"$WORK/$r.adm-filter.log"; then
    echo "  FAILED $r: admin tags-filter failed (see $r.adm-filter.log)" >&2
    rm -f "$WORK/$r.mbtiles" "$adm_pbf"
    return 1
  fi
  if ! osmium tags-filter -o "$adm_lvl" --overwrite \
       "$adm_pbf" $ADMIN_LEVELS 2>"$WORK/$r.adm-level.log"; then
    echo "  FAILED $r: admin level filter failed (see $r.adm-level.log)" >&2
    rm -f "$WORK/$r.mbtiles" "$adm_pbf" "$adm_lvl"
    return 1
  fi
  rm -f "$adm_pbf"

  set +e
  osmium export "$adm_lvl" -f geojsonseq --geometry-types=polygon -o - 2>"$WORK/$r.adm-export.log" \
    | tippecanoe -o "$WORK/$r-admin.mbtiles" --force -z12 -Z12 -pf -pk \
        --no-simplification-of-shared-nodes --no-tiny-polygon-reduction \
        --temporary-directory="$TMPDIR" \
        -y name -y name:en -y admin_level -y ISO3166-1 -y ISO3166-2 \
        -l "$ADMIN_LAYER" /dev/stdin 2>"$WORK/$r.adm-tip.log"
  local -a adm_rc=("${PIPESTATUS[@]}")
  set -e
  rm -f "$adm_lvl"
  if [ "${adm_rc[0]}" -ne 0 ] || [ "${adm_rc[1]}" -ne 0 ]; then
    echo "  FAILED $r: admin layer osmium=${adm_rc[0]} tippecanoe=${adm_rc[1]} (see $r.adm-*.log)" >&2
    rm -f "$WORK/$r.mbtiles" "$WORK/$r-admin.mbtiles"
    return 1
  fi
  local admsz
  admsz=$(stat -c %s "$WORK/$r-admin.mbtiles" 2>/dev/null || echo 0)
  if [ "$admsz" -lt "$MIN_ADMIN_BYTES" ]; then
    echo "  FAILED $r: admin layer is only ${admsz}B (min $MIN_ADMIN_BYTES), treating as failed" >&2
    rm -f "$WORK/$r.mbtiles" "$WORK/$r-admin.mbtiles"
    return 1
  fi

  if grep -q "Did not read any valid geometries" "$WORK/$r.tip.log"; then
    echo "  FAILED $r: tippecanoe read no geometries" >&2
    return 1
  fi
  # Success needs a SIZE FLOOR, not `-s`.
  #
  # `-s` only catches a zero-byte file. tippecanoe creates the .mbtiles and
  # writes the SQLite header immediately, so a run that is killed or dies part
  # way leaves a ~28 KB file that is non-empty, opens cleanly, and contains no
  # tiles. On 2026-08-26 that made the script print "done europe in 2157s -> 28K"
  # for a build that had been killed, and the same 28 KB stub then satisfied a
  # later skip check. Reuse the same 1 MiB floor the skip guard uses: the
  # smallest real region (antarctica) is 11 MB, so this cannot reject valid work.
  local outsz
  outsz=$(stat -c %s "$WORK/$r.mbtiles" 2>/dev/null || echo 0)
  if [ "$outsz" -lt "$MIN_MBTILES_BYTES" ]; then
    echo "  FAILED $r: mbtiles is only ${outsz}B (min $MIN_MBTILES_BYTES), treating as failed" >&2
    rm -f "$WORK/$r.mbtiles"
    return 1
  fi

  # Also require that tippecanoe actually reported writing tiles. A file can
  # clear the size floor and still be a partial write.
  if ! grep -qE "wrote|tiles" "$WORK/$r.tip.log" 2>/dev/null; then
    echo "  WARNING $r: no 'wrote/tiles' line in tip.log, output may be partial" >&2
  fi

  echo "  done $r in $((SECONDS - t0))s -> $(du -h "$WORK/$r.mbtiles" | cut -f1)"
}
export -f build_region
export WORK SRC FILTER KEEP FCACHE TMPDIR MIN_MBTILES_BYTES NAMED_ONLY
# The child `bash -c` shells need these too, or the admin layer silently builds
# with an empty filter and the export config path resolves to nothing.
export ADMIN_FILTER ADMIN_LEVELS ADMIN_LAYER EXPORT_CONFIG MIN_ADMIN_BYTES

echo "==> fetching continent extracts"
write_export_config
echo "  export config: $EXPORT_CONFIG (one geometry per object)"
for r in "${REGIONS[@]}"; do fetch "$r" & done
wait

echo "==> building ${#REGIONS[@]} regions, $JOBS at a time"
printf '%s\n' "${REGIONS[@]}" | xargs -P "$JOBS" -I{} bash -c 'build_region {}'

echo "==> merging"
# Merge the REGION tilesets by name. A bare *.mbtiles glob also matches a
# planet-parks.mbtiles left by a previous run, which would merge the old output
# into the new one and silently double-count every feature.
MERGE_IN=()
for r in "${REGIONS[@]}"; do
  [ -s "$WORK/$r.mbtiles" ] && MERGE_IN+=("$WORK/$r.mbtiles")
  # The admin tileset is a second LAYER, so it joins the same merge rather than
  # producing a separate archive. tile-join keeps layers distinct.
  [ -s "$WORK/$r-admin.mbtiles" ] && MERGE_IN+=("$WORK/$r-admin.mbtiles")
done
echo "  merging ${#MERGE_IN[@]} region tilesets"
if [ "${#MERGE_IN[@]}" -ne "$(( ${#REGIONS[@]} * 2 ))" ]; then
  echo "  FAILED: expected $(( ${#REGIONS[@]} * 2 )) tilesets (one parks + one admin per region), found ${#MERGE_IN[@]}" >&2
  exit 1
fi
# Refuse to merge anything older than 24h. Stale tilesets from a PREVIOUS zoom
# level are the dangerous case: they are valid files, so a size check passes,
# and the merged output looks plausible while being wrong.
for _m in "${MERGE_IN[@]}"; do
  if [ -n "$(find "$_m" -mtime +1 2>/dev/null)" ]; then
    echo "  FAILED: $_m is older than 24h, refusing to merge a stale tileset" >&2
    exit 1
  fi
done
# Move any previous archive aside rather than deleting it. A stale merge input
# must not be reused, but an existing archive is the only rollback that exists:
# an `rm -f` here destroyed the z13 archive on 2026-08-26 when $WORK pointed
# somewhere unexpected.
for _old in "$WORK/planet-parks.mbtiles" "$WORK/planet-parks.pmtiles"; do
  [ -e "$_old" ] && mv -f "$_old" "$_old.prev-$(date +%Y%m%d-%H%M%S)"
done
tile-join -f -pk -o "$WORK/planet-parks.mbtiles" "${MERGE_IN[@]}"
tippecanoe-enumerate "$WORK/planet-parks.mbtiles" >/dev/null 2>&1 || true

echo "==> converting to pmtiles"
if ! command -v pmtiles >/dev/null; then
  # FAIL rather than print advice and exit 0. The script promises a .pmtiles
  # archive, and a caller that checks only the exit status would otherwise
  # treat a missing converter as a successful build.
  echo "  FAILED: pmtiles CLI not found; install from github.com/protomaps/go-pmtiles" >&2
  echo "  the merged mbtiles is at $WORK/planet-parks.mbtiles if you want to convert it by hand" >&2
  exit 1
fi
if ! pmtiles convert "$WORK/planet-parks.mbtiles" "$WORK/planet-parks.pmtiles"; then
  echo "  FAILED: pmtiles convert exited non-zero" >&2
  exit 1
fi
if [ ! -s "$WORK/planet-parks.pmtiles" ]; then
  echo "  FAILED: pmtiles convert produced no archive" >&2
  exit 1
fi

ls -la "$WORK"/planet-parks.* 2>/dev/null
echo "==> done"
