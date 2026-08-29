"""Verify representative_point() returns a point ON the feature.

A search result is a "take me here" answer, so the coordinate must be inside
the polygon. Two shapes break the naive implementations:

- A C shape breaks the CENTROID: the average of the vertices lands in the notch.
- A donut breaks a midpoint SCANLINE that ignores holes: the widest span between
  outer-ring crossings is the hole itself.

Both are checked here against an independent even-odd point-in-polygon test
rather than against hard-coded coordinates, so the assertion is "the point is
inside the shape", not "the point equals what the code happened to produce".
"""
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("builder", "scripts/osm-places/build-search-records.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def in_ring(pt, ring):
    lat, lon = pt
    x, y = lon, lat
    inside = False
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside


def inside_polygon(pt, outer, holes=()):
    return in_ring(pt, outer) and not any(in_ring(pt, h) for h in holes)


CASES = []

# Convex square: any sane answer works.
square = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]
CASES.append(("square", {"type": "Polygon", "coordinates": [square]}, square, []))

# C shape: the centroid is OUTSIDE.
cshape = [[0, 0], [10, 0], [10, 3], [4, 3], [4, 7], [10, 7], [10, 10], [0, 10], [0, 0]]
CASES.append(("C shape", {"type": "Polygon", "coordinates": [cshape]}, cshape, []))

# Donut: the midpoint scanline crosses the hole.
d_out = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]
d_hole = [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]]
CASES.append(("donut", {"type": "Polygon", "coordinates": [d_out, d_hole]}, d_out, [d_hole]))

# Donut with a thin remaining rim, so the hole dominates the width.
t_out = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]
t_hole = [[0.5, 0.5], [9.5, 0.5], [9.5, 9.5], [0.5, 9.5], [0.5, 0.5]]
CASES.append(("thin rim donut", {"type": "Polygon", "coordinates": [t_out, t_hole]}, t_out, [t_hole]))

# Two holes on the same scanline.
m_out = [[0, 0], [12, 0], [12, 10], [0, 10], [0, 0]]
m_h1 = [[1, 4], [5, 4], [5, 6], [1, 6], [1, 4]]
m_h2 = [[7, 4], [11, 4], [11, 6], [7, 6], [7, 4]]
CASES.append(("two holes", {"type": "Polygon", "coordinates": [m_out, m_h1, m_h2]}, m_out, [m_h1, m_h2]))

# MultiPolygon: the larger part is chosen and must still be a valid point.
small = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]
big = [[5, 5], [15, 5], [15, 9], [12, 9], [12, 7], [5, 7], [5, 5]]
CASES.append(("multipolygon", {"type": "MultiPolygon", "coordinates": [[small], [big]]}, big, []))

failures = 0
for name, geom, outer, holes in CASES:
    pt = builder.representative_point(geom)
    if pt is None:
        print(f"  FAIL {name}: returned None")
        failures += 1
        continue
    ok = inside_polygon(pt, outer, holes)
    # Show what a centroid would have done, to keep the reason visible.
    cx = sum(p[0] for p in outer[:-1]) / (len(outer) - 1)
    cy = sum(p[1] for p in outer[:-1]) / (len(outer) - 1)
    centroid_ok = inside_polygon((cy, cx), outer, holes)
    status = "ok  " if ok else "FAIL"
    if not ok:
        failures += 1
    print(f"  {status} {name:<16} point={pt} inside={ok}   (centroid inside={centroid_ok})")

# Lines must return a real vertex, not an interpolated midpoint.
line = {"type": "LineString", "coordinates": [[0, 0], [5, 5], [10, 0]]}
pt = builder.representative_point(line)
is_vertex = [pt[1], pt[0]] in line["coordinates"]
print(f"  {'ok  ' if is_vertex else 'FAIL'} line vertex     point={pt} is_real_vertex={is_vertex}")
if not is_vertex:
    failures += 1

# A control character inside a name must never reach the TSV.
#
# Replacing only tab and newline was not enough. OSM carries a bare carriage
# return in `Little River\r Gorge` (way237614464), and Python reads files in
# universal-newline mode, so that lone \r started a new line on the way back in
# and split one record into two. The enrichment stage then rejected the corpus.
print("\ncontrol characters:")
for raw, want in [
    ("Little River\r Gorge", "Little River Gorge"),
    ("tab\tseparated", "tab separated"),
    ("two\nlines", "two lines"),
    ("vertical\x0btab", "vertical tab"),
    ("del\x7fchar", "del char"),
    ("  padded  ", "padded"),
    ("collapse  runs", "collapse runs"),
    # Legitimate text must survive untouched.
    ("Do\u00f1ana", "Do\u00f1ana"),
    ("Saint-Louis", "Saint-Louis"),
]:
    got = builder.clean(raw)
    ok = got == want
    if not ok:
        failures += 1
    print(f"  {'ok  ' if ok else 'FAIL'} {raw!r} -> {got!r}")

# The real defence: a cleaned field must never contain a line terminator, or a
# row splits no matter what the field count says.
for raw in ("a\rb", "a\nb", "a\r\nb"):
    cleaned = builder.clean(raw)
    ok = len(cleaned.splitlines()) == 1
    if not ok:
        failures += 1
    print(f"  {'ok  ' if ok else 'FAIL'} {raw!r} stays one line")

# Aliases must be cleaned BEFORE folding.
#
# `fold()` DELETES control characters rather than treating them as separators,
# so folding first joins the words either side into one unreachable token:
# `Little River\rGorge` becomes `little rivergorge`, while a user typing the
# displayed name folds to three tokens and matches nothing. The earlier fixture
# hid this because its carriage return happened to sit next to a space.
print("\nalias cleaning order:")
for raw, want in [
    ("Little River\rGorge", "little river gorge"),
    ("Foo\tBar", "foo bar"),
    ("Split\nName", "split name"),
]:
    aliases = builder.aliases_for({"name": raw}, builder.clean(raw))
    ok = aliases == [want]
    if not ok:
        failures += 1
    print(f"  {'ok  ' if ok else 'FAIL'} {raw!r} -> {aliases}")

# A query for the DISPLAYED name must reach the indexed alias.
for raw in ("Little River\rGorge", "Little River\r Gorge"):
    display = builder.clean(raw)
    aliases = builder.aliases_for({"name": raw}, display)
    ok = builder.fold(display) in aliases
    if not ok:
        failures += 1
    print(f"  {'ok  ' if ok else 'FAIL'} query {display!r} reaches its alias")

print("ALL PASS" if failures == 0 else f"{failures} FAILURE(S)")
sys.exit(1 if failures else 0)
