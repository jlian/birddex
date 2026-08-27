import os
import sys

sys.path.insert(0, '/home/pi/.openclaw/workspace/tmp')
from PIL import Image
from PIL.ExifTags import GPSTAGS
from place_lookup import load, best, CLS_NAME

D = '/home/pi/wingdex/src/assets/images'


def to_deg(v, ref):
    d, m, s = [float(x) for x in v]
    val = d + m / 60.0 + s / 3600.0
    return -val if ref in ('S', 'W') else val


def coords(path):
    try:
        exif = Image.open(path).getexif()
        raw = exif.get_ifd(0x8825)
        if not raw:
            return None
        g = {GPSTAGS.get(k, k): v for k, v in raw.items()}
        return (to_deg(g['GPSLatitude'], g.get('GPSLatitudeRef', 'N')),
                to_deg(g['GPSLongitude'], g.get('GPSLongitudeRef', 'E')))
    except Exception:
        return None


grid = load('/home/pi/wingdex/scripts/wikidata-places/places.ndjson')

print('%-52s %-32s %7s' % ('photo (real EXIF GPS)', 'chosen place', 'dist'))
print('-' * 95)
hit = 0
total = 0
for fn in sorted(os.listdir(D)):
    c = coords(os.path.join(D, fn))
    if not c:
        continue
    total += 1
    r = best(grid, c[0], c[1])
    if r is None:
        print('%-52s %-32s %7s' % (fn[:52], '-- no match --', ''))
        continue
    hit += 1
    score, place, d = r
    print('%-52s %-32s %6.0fm  %s' % (fn[:52], place['name'][:32], d, CLS_NAME.get(place['cls'], place['cls'])))

print()
print('  %d of %d photos got a name (%.0f%%)' % (hit, total, 100.0 * hit / total))
