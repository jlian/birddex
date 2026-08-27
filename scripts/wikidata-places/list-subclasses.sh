#!/bin/bash
# Generate candidate place classes instead of hand-writing them.
#
# For a root class, list its subclasses ranked by how many instances actually
# carry coordinates. That ranking is the point: it surfaces classes nobody would
# guess (Natura 2000 site is the largest protected-area subclass at 21,573) and
# it is how a hand-written list gets caught being wrong.
#
# Output is for REVIEW, not direct use: the extent per class is still a judgment
# call, and some high-count classes are deliberately unwanted.
DIR="$(cd "$(dirname "$0")" && pwd)"
root="$1"
limit="${2:-25}"
timeout 110 curl -s \
  -H "Accept: application/sparql-results+json" \
  -H "User-Agent: wingdex-research/1.0 (https://wingdex.app)" \
  --get --data-urlencode "query=
SELECT ?c ?cLabel (COUNT(?i) AS ?n) WHERE {
  ?c wdt:P279 wd:$root .
  OPTIONAL { ?i wdt:P31 ?c ; wdt:P625 [] }
  SERVICE wikibase:label { bd:serviceParam wikibase:language \"en\". }
}
GROUP BY ?c ?cLabel
ORDER BY DESC(?n)
LIMIT $limit" \
  https://query.wikidata.org/sparql 2>/dev/null | python3 "$DIR/fmt_classes.py"
