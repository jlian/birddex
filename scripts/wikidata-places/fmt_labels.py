import json
import sys

try:
    rows = json.load(sys.stdin)['results']['bindings']
except Exception:
    print('  TIMEOUT/ERR')
    sys.exit(0)

for r in sorted(rows, key=lambda x: x['c']['value']):
    qid = r['c']['value'].rsplit('/', 1)[-1]
    print('  %-10s %s' % (qid, r['cLabel']['value']))
