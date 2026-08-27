import csv
import os
import sys

sys.path.insert(0, '/home/pi/.openclaw/workspace/tmp')
from PIL import Image
from PIL.ExifTags import GPSTAGS
from place_lookup import load, load_containment, best, best_contained, CLS_NAME

PLACES = '/home/pi/wingdex/scripts/wikidata-places/places.ndjson'
EDGES = '/home/pi/wingdex/scripts/wikidata-places/containment.ndjson'
IMG = '/home/pi/wingdex/src/assets/images'
CSV = '/home/pi/wingdex/src/assets/ebird-import.csv'

grid = load(PLACES)
edges = load_containment(EDGES)
print('containment edges usable (both ends nameable): %d children' % len(edges))
print()


def to_deg(v, ref):
    d, m, s = [float(x) for x in v]
    val = d + m / 60.0 + s / 3600.0
    return -val if ref in ('S', 'W') else val


def photo_coords(path):
    try:
        raw = Image.open(path).getexif().get_ifd(0x8825)
        if not raw:
            return None
        g = {GPSTAGS.get(k, k): v for k, v in raw.items()}
        return (to_deg(g['GPSLatitude'], g.get('GPSLatitudeRef', 'N')),
                to_deg(g['GPSLongitude'], g.get('GPSLongitudeRef', 'E')))
    except Exception:
        return None


def show(title, items):
    print('=== %s ===' % title)
    print('%-46s %-30s %-30s' % ('coordinate source', 'before (no containment)', 'after (containment)'))
    print('-' * 108)
    changed = 0
    for label, lat, lon in items:
        b = best(grid, lat, lon)
        a = best_contained(grid, lat, lon, edges)
        bn = ('%s %.0fm' % (b[1]['name'][:22], b[2])) if b else '-- none --'
        an = ('%s %.0fm' % (a[1]['name'][:22], a[2])) if a else '-- none --'
        mark = '  <-- CHANGED' if bn != an else ''
        if mark:
            changed += 1
        print('%-46s %-30s %-30s%s' % (label[:46], bn, an, mark))
    print()
    print('  %d of %d changed' % (changed, len(items)))
    print()


photos = []
for fn in sorted(os.listdir(IMG)):
    c = photo_coords(os.path.join(IMG, fn))
    if c:
        photos.append((fn.replace('_', ' ')[:46], c[0], c[1]))
show('25 real photos (EXIF GPS)', photos)

seen = {}
with open(CSV, encoding='utf-8') as fh:
    for row in csv.DictReader(fh):
        if row['Location'] not in seen:
            seen[row['Location']] = (float(row['Latitude']), float(row['Longitude']))
show('10 CSV fixtures', [(k, v[0], v[1]) for k, v in seen.items()])
