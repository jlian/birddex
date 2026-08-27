#!/bin/bash
# Resolve a Wikidata class QID -> its English label, so an allowlist can be
# checked rather than trusted. Written after using Q46169 believing it was
# "beach" when it is in fact "national park".
DIR="$(cd "$(dirname "$0")" && pwd)"
ids=""
for q in "$@"; do ids="$ids wd:$q"; done
timeout 110 curl -s \
  -H "Accept: application/sparql-results+json" \
  -H "User-Agent: wingdex-research/1.0 (https://wingdex.app)" \
  --get --data-urlencode "query=
SELECT ?c ?cLabel WHERE {
  VALUES ?c {$ids}
  SERVICE wikibase:label { bd:serviceParam wikibase:language \"en\". }
}" \
  https://query.wikidata.org/sparql 2>/dev/null | python3 "$DIR/fmt_labels.py"
