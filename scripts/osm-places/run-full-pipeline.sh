#!/usr/bin/env bash
# Full search-corpus rebuild: export -> region enrich -> database + measure.
#
# One script so the three stages cannot race each other. Each rebuild takes
# tens of minutes, and two overlapping runs previously produced row counts that
# did not match the files on disk.
#
# `-e` matters here: without it a failed export or enrichment still fell
# through to the completion marker, so `pipeline.DONE` could advertise a
# partial or stale artifact as a finished build.
set -euo pipefail

# Paths are overridable so this runs outside the one machine it was written on.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Absolute BEFORE anything is derived from it. `cd "$WORK"` happens below, so a
# relative override such as `WORK=tmp` would make `VENV_PY` read `tmp/venv/...`,
# which resolves against the original directory here and against `$WORK` itself
# after the cd, i.e. `tmp/tmp/venv/...` during enrichment.
WORK="${WORK:-/mnt/ssdscratch}"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"
VENV_DIR="${VENV_DIR:-$WORK/venv}"
VENV_PY="${VENV_PY:-$VENV_DIR/bin/python}"
IMPORTANCE_TABLE="${IMPORTANCE_TABLE:-$WORK/qid-importance.tsv}"
# Default to the exporters COMMITTED next to this script. Pointing at copies
# under the scratch directory meant a normal checkout could not rebuild, and
# where such a copy did exist it could silently be older than the repository.
EXPORT_SCRIPT="${EXPORT_SCRIPT:-$SCRIPT_DIR/run-search-export.sh}"
ADMIN_SCRIPT="${ADMIN_SCRIPT:-$SCRIPT_DIR/run-admin-export.sh}"
# Must match the defaults in `run-admin-export.sh`; both read the same
# environment, so an override applies to the cache key and to the build alike.
SRC="${SRC:-/mnt/nas/wikidata/regions}"
# Absolute, and exported, so the wrapper and the child exporters agree on one
# directory. Previously only the cache key honoured `OUT` while every other
# path was hardcoded under `$WORK/search`, so a non-default `OUT` made the
# exporters write one place and this script read another. `cd "$WORK"` below
# also means a relative `OUT` would resolve differently in each.
OUT_DIR="${OUT:-$WORK/search}"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
OUT="$OUT_DIR"
ADMIN_FILTER="${ADMIN_FILTER:-r/boundary=administrative}"
ADMIN_LEVELS="${ADMIN_LEVELS:-r/admin_level=2,3,4,6}"
export SRC OUT ADMIN_FILTER ADMIN_LEVELS

# Hold an exclusive lock BEFORE touching anything shared.
#
# Sequencing the stages inside one script stops them racing each other, but it
# does nothing about two INVOCATIONS: both would truncate the same log and
# rewrite all.tsv, all-enriched.tsv and the SQLite output, which is exactly the
# mixed-artifact corruption this script claims to prevent. That has already
# happened once here, and the corrupt result looked entirely plausible.
#
# The lock must come before the virtualenv too. Two first-time invocations
# would otherwise run `venv` and `pip` concurrently against the same directory
# and corrupt the environment, which is shared state exactly like the outputs.
exec 9> "$WORK/pipeline.lock"
if ! flock -n 9; then
  echo "another pipeline run holds $WORK/pipeline.lock; refusing to start" >&2
  exit 1
fi

# Create the enrichment environment when it is absent, so a clean checkout can
# rebuild. Only the region join needs a third-party package; every other stage
# runs on the standard library. Without this the pipeline advertised a
# one-command rebuild but failed at enrichment on any machine that did not
# already have this venv by hand.
if [ ! -x "$VENV_PY" ]; then
  echo "== creating $VENV_DIR =="
  python3 -m venv "$VENV_DIR"
  "$VENV_DIR/bin/pip" install --quiet --upgrade pip
  "$VENV_DIR/bin/pip" install --quiet -r "$SCRIPT_DIR/requirements.txt"
fi
"$VENV_PY" -c 'import shapely' 2>/dev/null || {
  echo "$VENV_PY cannot import shapely; install $SCRIPT_DIR/requirements.txt into it" >&2
  exit 1
}

cd "$WORK"
rm -f pipeline.DONE
: > pipeline.log

# The admin boundaries are an INPUT to enrichment and nothing else produces
# them, so build them when they are absent rather than failing deep in the run.
#
# Reusing the file whenever it merely EXISTS produced the mixed-vintage
# artifact this pipeline exists to prevent: a refreshed planet invalidates the
# filtered-place cache by size and mtime, so new place records were enriched
# against boundaries from the previous snapshot.
#
# The cache is therefore keyed by the identity of every source extract plus the
# filter settings that shaped it, and reused only when a previous run recorded
# the SAME key on a successful build.
ADMIN_KEY_FILE="$OUT_DIR/admin-iso.key"
admin_key() {
  {
    echo "filter=$ADMIN_FILTER levels=$ADMIN_LEVELS"
    for r in africa antarctica asia australia-oceania central-america europe north-america south-america; do
      f="$SRC/$r.osm.pbf"
      if [ -e "$f" ]; then
        stat -c '%n %s %Y' "$f"
      else
        echo "$f MISSING"
      fi
    done
  } | sha256sum | cut -d' ' -f1
}
WANT_KEY="$(admin_key)"

if [ ! -s "$OUT_DIR/admin-iso.geojsonseq" ] || [ "$(cat "$ADMIN_KEY_FILE" 2>/dev/null)" != "$WANT_KEY" ]; then
  echo "== admin boundaries ==" | tee -a pipeline.log
  rm -f "$ADMIN_KEY_FILE"
  "$ADMIN_SCRIPT" >> pipeline.log 2>&1
  echo "$WANT_KEY" > "$ADMIN_KEY_FILE"
else
  echo "== admin boundaries: reusing, sources unchanged ==" | tee -a pipeline.log
fi

echo "== export ==" | tee -a pipeline.log
rm -f search-export.DONE
"$EXPORT_SCRIPT" >> pipeline.log 2>&1

echo "== enrich ==" | tee -a pipeline.log
"$VENV_PY" "$SCRIPT_DIR/enrich-search-regions.py" \
  "$OUT_DIR/admin-iso.geojsonseq" "$OUT_DIR/all.tsv" > "$OUT_DIR/all-enriched.tsv" 2>> pipeline.log

echo "== database ==" | tee -a pipeline.log
python3 "$SCRIPT_DIR/build-search-db.py" "$OUT_DIR/all-enriched.tsv" \
  "$OUT_DIR/places-search.sqlite" "$IMPORTANCE_TABLE" >> pipeline.log 2>&1

echo DONE > pipeline.DONE
