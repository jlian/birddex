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
WORK="${WORK:-/mnt/ssdscratch}"
VENV_DIR="${VENV_DIR:-$WORK/venv}"
VENV_PY="${VENV_PY:-$VENV_DIR/bin/python}"
IMPORTANCE_TABLE="${IMPORTANCE_TABLE:-$WORK/qid-importance.tsv}"
# Default to the exporters COMMITTED next to this script. Pointing at copies
# under the scratch directory meant a normal checkout could not rebuild, and
# where such a copy did exist it could silently be older than the repository.
EXPORT_SCRIPT="${EXPORT_SCRIPT:-$SCRIPT_DIR/run-search-export.sh}"
ADMIN_SCRIPT="${ADMIN_SCRIPT:-$SCRIPT_DIR/run-admin-export.sh}"

mkdir -p "$WORK"

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

# Hold an exclusive lock for the WHOLE pipeline.
#
# Sequencing the stages inside one script stops them racing each other, but it
# does nothing about two INVOCATIONS: both would truncate the same log and
# rewrite all.tsv, all-enriched.tsv and the SQLite output, which is exactly the
# mixed-artifact corruption this script claims to prevent. That has already
# happened once here, and the corrupt result looked entirely plausible.
exec 9> "$WORK/pipeline.lock"
if ! flock -n 9; then
  echo "another pipeline run holds $WORK/pipeline.lock; refusing to start" >&2
  exit 1
fi

cd "$WORK"
rm -f pipeline.DONE
: > pipeline.log

# The admin boundaries are an INPUT to enrichment and nothing else produces
# them, so build them when they are absent rather than failing deep in the run.
if [ ! -s search/admin-iso.geojsonseq ]; then
  echo "== admin boundaries ==" | tee -a pipeline.log
  "$ADMIN_SCRIPT" >> pipeline.log 2>&1
fi

echo "== export ==" | tee -a pipeline.log
rm -f search-export.DONE
"$EXPORT_SCRIPT" >> pipeline.log 2>&1

echo "== enrich ==" | tee -a pipeline.log
"$VENV_PY" "$SCRIPT_DIR/enrich-search-regions.py" \
  search/admin-iso.geojsonseq search/all.tsv > search/all-enriched.tsv 2>> pipeline.log

echo "== database ==" | tee -a pipeline.log
python3 "$SCRIPT_DIR/build-search-db.py" search/all-enriched.tsv \
  search/places-search.sqlite "$IMPORTANCE_TABLE" >> pipeline.log 2>&1

echo DONE > pipeline.DONE
