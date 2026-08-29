#!/usr/bin/env python3
"""Attach ISO 3166 region codes to search records offline.

Phase 1 step 4 of issue #343: "Runtime search should not need a PMTiles lookup
for every result." The reverse route resolves region codes by reading the
archive's `admin` layer for ONE coordinate. Forward search returns up to five
results from anywhere on earth, so doing the same at query time would mean up
to five extra R2 range reads per search. Resolving it at build time makes that
cost zero.

Codes come from the SAME admin boundaries the reverse archive uses
(`boundary=administrative`, admin_level 2-4), so the two systems cannot report
a different country for the same place.

Uses Shapely's STRtree rather than a hand-rolled index. A first version binned
bounding boxes into a 1-degree grid and ran a Python point-in-ring test per
candidate, which measured out at roughly six hours for the global corpus:
country polygons are enormous, so a coarse grid cell can hold hundreds of them
and the inner loop is interpreted. STRtree is a packed R-tree with the
predicate in C, and it is the standard tool for exactly this join.
"""
from __future__ import annotations

import json
import re
import sys

from shapely.geometry import Point, shape
from shapely.strtree import STRtree

# Must match `ISO_3166_2` in `functions/lib/osm-places.ts` EXACTLY. A looser
# prefix match here accepted malformed values that the reverse lookup rejects:
# `US-TOO-LONG` would derive country `US` in search while reverse geocoding
# fell back to the country tag, so the two paths could disagree about the same
# place despite sharing a source.
ISO_3166_2 = re.compile(r"^([A-Z]{2})-([A-Z0-9]{1,3})$")


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: enrich-search-regions.py <admin.geojsonseq> <records.tsv>", file=sys.stderr)
        return 1
    admin_path, records_path = sys.argv[1], sys.argv[2]

    geometries = []
    attributes = []
    with open(admin_path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip().lstrip("\x1e")
            if not line:
                continue
            try:
                feature = json.loads(line)
            except json.JSONDecodeError:
                continue
            props = feature.get("properties") or {}
            state = props.get("ISO3166-2")
            country = props.get("ISO3166-1:alpha2") or props.get("ISO3166-1")
            if not state and not country:
                continue
            # Prefer `name:en` for the visible locality. OSM's `name` on an
            # administrative boundary is frequently bilingual, so Rabat's
            # prefecture arrives as `Prefecture de Rabat` followed by the same
            # thing in Arabic. That is unreadable in a result list, and the
            # English name is the one this app's users can act on.
            name = props.get("name:en") or props.get("name") or ""
            try:
                geometry = shape(feature.get("geometry") or {})
            except Exception:
                continue
            if geometry.is_empty:
                continue
            # Invalid rings are common in OSM boundary data and make `contains`
            # raise. `buffer(0)` is the standard repair.
            if not geometry.is_valid:
                geometry = geometry.buffer(0)
                if geometry.is_empty:
                    continue
            geometries.append(geometry)
            # Area orders containing polygons: the smallest one is the most
            # precise answer. Degrees squared is fine for ordering.
            attributes.append((state or "", country or "", geometry.area, name))

    tree = STRtree(geometries)
    print(f"  admin polygons: {len(geometries):,}", file=sys.stderr)

    total = 0
    with_state = 0
    with_country = 0
    out = sys.stdout
    with open(records_path, encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            parts = line.rstrip("\n").split("\t")
            # FAIL rather than skip. A silent `continue` here lets TSV
            # corruption or a producer schema change yield a partial, or even
            # empty, enriched corpus while the pipeline still writes its DONE
            # marker, so an incomplete database could be published as a
            # successful rebuild.
            if len(parts) != 9:
                sys.exit(
                    f"{records_path}:{lineno}: expected 9 tab-separated fields, "
                    f"got {len(parts)}; refusing to write a partial corpus"
                )
            total += 1
            point = Point(float(parts[3]), float(parts[2]))
            hits = []
            for idx in tree.query(point):
                # `covers`, not `contains`: `contains` EXCLUDES the boundary,
                # and the record builder deliberately returns boundary vertices
                # for lines and for degenerate polygons. A named coastline
                # sitting exactly on a country outline would otherwise lose its
                # codes, which is precisely the case most likely to sit on an
                # administrative border.
                if geometries[idx].covers(point):
                    hits.append(attributes[idx])
            state = country = region = ""
            if hits:
                # Smallest containing polygon wins: a subdivision is a more
                # precise answer than the country that contains it.
                hits.sort(key=lambda h: h[2])
                state = next((h[0] for h in hits if h[0]), "")
                # The human-readable name of the smallest coded boundary that
                # contains the point. Issue #343 step 4 asks for "useful
                # locality names" alongside the codes: a result list reading
                # `US-WA` is a machine answer, and two same-named parks in one
                # subdivision stay indistinguishable without it. Resolved here
                # rather than at query time for the same reason the codes are:
                # five results would otherwise cost five archive reads.
                region = next((h[3] for h in hits if h[3]), "")
                # Derive the country FROM the subdivision code rather than
                # trusting a country tag on the same polygon. Puerto Rico's
                # admin_level=4 boundary carries BOTH `ISO3166-2=US-PR` and
                # `ISO3166-1=PR`, so the tag yields `PR` while the checklist
                # belongs to `US`. This mirrors the identical fix in
                # `functions/lib/osm-places.ts`, deliberately, so forward and
                # reverse search cannot disagree.
                match = ISO_3166_2.match(state) if state else None
                country = match.group(1) if match else next((h[1] for h in hits if h[1]), "")
            if state:
                with_state += 1
            if country:
                with_country += 1
            out.write("\t".join(parts + [state, country, region]))
            out.write("\n")
            if total % 500_000 == 0:
                print(f"  ... {total:,} records", file=sys.stderr, flush=True)

    print(f"  enriched: {total:,} records, {with_state:,} with a subdivision "
          f"({100 * with_state / max(total, 1):.1f}%), {with_country:,} with a country "
          f"({100 * with_country / max(total, 1):.1f}%)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
