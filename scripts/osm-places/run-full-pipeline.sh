#!/usr/bin/env bash
# Full search-corpus rebuild: export -> region enrich -> database + measure.
#
# One script so the three stages cannot race each other. Each corpus rebuild
# takes tens of minutes, and two overlapping runs previously produced row
# counts that did not match the files on disk.
set -uo pipefail
cd /mnt/ssdscratch
rm -f pipeline.DONE
: > pipeline.log
echo "== export ==" | tee -a pipeline.log
rm -f search-export.DONE
./run-search-export.sh >> pipeline.log 2>&1
echo "== enrich ==" | tee -a pipeline.log
/mnt/ssdscratch/venv/bin/python enrich-search-regions.py \
  search/admin-iso.geojsonseq search/all.tsv > search/all-enriched.tsv 2>> pipeline.log
echo "== database ==" | tee -a pipeline.log
python3 build-search-db.py search/all-enriched.tsv search/places-search.sqlite \
  qid-importance.tsv >> pipeline.log 2>&1
echo DONE > pipeline.DONE
