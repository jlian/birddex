#!/usr/bin/env python3
"""Emit the EX/EW species list from the AviList workbook.

WHY THIS EXISTS RATHER THAN A HARDCODED LIST OF 143 ROW INDEXES
---------------------------------------------------------------
Row indexes are meaningless across taxonomy versions: dropping rows renumbers
everything after them, so a list of indexes is only valid for one exact file.
Deriving the exclusion from the IUCN status column means the next taxonomy
refresh re-derives it automatically instead of someone remembering to redo 143
deletions by hand.

The workbook is the same one scripts/build-birdlife-crosswalk.py already opens,
so this adds a column read rather than a new data source.

Usage:
  python3 scripts/emit-extinct-list.py \
      --avilist .tmp/AviList-v2025-11Jun-extended.xlsx \
      --taxonomy src/lib/taxonomy.json \
      --out scripts/extinct-species.json
"""
import argparse
import json
import re
import sys
from pathlib import Path

try:
    import openpyxl
except ImportError:
    sys.exit("pip install openpyxl first")

# IUCN codes that mean "cannot be photographed alive in the wild".
# EW is included: an Extinct in the Wild species exists only in captivity, so a
# wild-bird identifier should not offer it either. CR is deliberately NOT here,
# even though it contains probably-extinct species like Ivory-billed
# Woodpecker: those are exactly the records that would matter most.
EXCLUDE = {"EX", "EW"}


def norm(s):
    return re.sub(r"\s+", " ", str(s or "")).strip().lower()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--avilist", required=True)
    ap.add_argument("--taxonomy", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    tax = json.loads(Path(args.taxonomy).read_text())
    by_sci = {}
    for i, row in enumerate(tax):
        if len(row) > 1 and row[1]:
            by_sci.setdefault(norm(row[1]), i)

    wb = openpyxl.load_workbook(args.avilist, read_only=True)
    ws = wb[wb.sheetnames[0]]

    header = None
    sci_col = status_col = None
    hits = []
    unmatched = []
    seen_status = {}

    for row in ws.iter_rows(min_row=1, values_only=True):
        if header is None:
            header = [norm(c) for c in row]
            for j, h in enumerate(header):
                if h in ("scientific_name", "scientific name", "species"):
                    sci_col = j
                if "iucn" in h and ("red" in h or "status" in h or "category" in h):
                    status_col = j
            if sci_col is None or status_col is None:
                sys.exit("could not find scientific-name and IUCN columns; "
                         f"headers were: {header}")
            continue

        sci = norm(row[sci_col])
        status = norm(row[status_col]).upper()
        if not sci or not status:
            continue
        seen_status[status] = seen_status.get(status, 0) + 1
        if status not in EXCLUDE:
            continue
        idx = by_sci.get(sci)
        if idx is None:
            unmatched.append((sci, status))
            continue
        hits.append(dict(idx=idx, scientific=tax[idx][1], common=tax[idx][0],
                         status=status))

    hits.sort(key=lambda h: h["idx"])
    print(f"IUCN status values seen: {dict(sorted(seen_status.items()))}")
    print(f"EX/EW rows matched into taxonomy: {len(hits)}")
    print(f"EX/EW rows NOT in our taxonomy:   {len(unmatched)}")

    out = dict(
        excluded_statuses=sorted(EXCLUDE),
        taxonomy_rows=len(tax),
        count=len(hits),
        species=[{k: h[k] for k in ("scientific", "common", "status")} for h in hits],
        indexes_for_reference_only=[h["idx"] for h in hits],
    )
    Path(args.out).write_text(json.dumps(out, indent=1) + "\n")
    print(f"wrote {args.out}")
    for h in hits[:10]:
        print(f"  {h['idx']:>6}  {h['status']}  {h['common']}")
    if len(hits) > 10:
        print(f"  ... and {len(hits)-10} more")


if __name__ == "__main__":
    main()
