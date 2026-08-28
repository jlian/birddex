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
VENV_PY="${VENV_PY:-$WORK/venv/bin/python}"
IMPORTANCE_TABLE="${IMPORTANCE_TABLE:-$WORK/qid-importance.tsv}"
# Default to the exporter COMMITTED next to this script. Pointing at a copy
# under the scratch directory meant a normal checkout could not rebuild, and
# where such a copy did exist it could silently be older than the repository.
EXPORT_SCRIPT="${EXPORT_SCRIPT:-$SCRIPT_DIR/run-search-export.sh}"

cd "$WORK"
rm -f pipeline.DONE
: > pipeline.log

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
