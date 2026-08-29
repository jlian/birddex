import json
import sys

try:
    rows = json.load(sys.stdin)['results']['bindings']
except Exception:
    print('  TIMEOUT/ERR')
    sys.exit(0)

if not rows:
    print('  (none)')
    sys.exit(0)

for r in rows:
    n = int(r['n']['value'])
    if n == 0:
        continue
    print('  %-11s %-38s %7s' % (
        r['c']['value'].rsplit('/', 1)[-1],
        r['cLabel']['value'][:38],
        format(n, ','),
    ))
