#!/usr/bin/env python3
"""Emit the extinct-species exclusion list from eBird's own EXTINCT column.

WHY EBIRD RATHER THAN AVILIST/IUCN
----------------------------------
This used to read the AviList workbook's IUCN status column and exclude EX + EW.
It now follows eBird, because eBird is the taxonomy we align with everywhere
else: species codes, common names, taxonomic order, and the display sidecar all
come from their file. Having the extinct rule come from a second authority meant
two sources could disagree about the same bird, and they did.

The disagreement was real and definitional, not a data error in either source:

  - eBird flagged 27 species extinct that AviList rates CR, CR (PE) or NE.
    South Island Kokako (CR (PE), last accepted 1967) is the clearest case.
    eBird's EXTINCT column is an editorial "you will not see this"; IUCN EX is a
    formal assessment needing exhaustive surveys, so eBird is more aggressive.
  - AviList rated 6 extinct that eBird does not flag. Five are EW, Extinct in
    the Wild, which is not the same as gone: Spix's Macaw, Hawaiian Crow, Guam
    Kingfisher, Socorro Dove and Alagoas Curassow all exist in captivity with
    active reintroduction programmes. The sixth, White-chested White-eye, is a
    genuine judgement call.

Following eBird restores those 6 and drops the 27, which is the point: one
authority, no reconciliation.

WHY THIS EXISTS RATHER THAN A HARDCODED LIST OF ROW INDEXES
-----------------------------------------------------------
Row indexes are meaningless across taxonomy versions: dropping rows renumbers
everything after them, so a list of indexes is only valid for one exact file.
Deriving the exclusion from a status column means the next taxonomy refresh
re-derives it automatically instead of someone redoing the deletions by hand.

SOURCING: ONE HTTP REQUEST
--------------------------
The full eBird taxonomy is a single public CSV, no API key, carrying CATEGORY
and EXTINCT for every taxon. Fetch it once and cache it; there is no
per-species lookup to make.

Usage:
  python3 scripts/emit-extinct-list.py \
      --ebird .tmp/ebird-taxonomy-full.csv \
      --taxonomy src/lib/taxonomy.json \
      --out scripts/extinct-species.json
"""
import argparse
import csv
import json
import re
import sys
import urllib.request
from pathlib import Path

EBIRD_CSV_URL = "https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=csv"


def norm(s):
    return re.sub(r"\s+", " ", str(s or "")).strip().lower()


def load_ebird(path):
    p = Path(path)
    if p.exists():
        print(f"  using cached eBird taxonomy: {p}")
        return p.read_text(encoding="utf-8")
    print("  fetching the full eBird taxonomy (one request)...")
    with urllib.request.urlopen(EBIRD_CSV_URL, timeout=120) as fh:
        text = fh.read().decode("utf-8")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    print(f"  cached to {p}")
    return text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ebird", default=".tmp/ebird-taxonomy-full.csv")
    ap.add_argument("--taxonomy", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--allow-unmatched", action="store_true",
                    help="write the list even if a flagged species is missing "
                         "from the taxonomy; use only after checking the names")
    args = ap.parse_args()

    rows = list(csv.DictReader(load_ebird(args.ebird).splitlines()))
    if not rows:
        sys.exit("the eBird CSV parsed to zero rows")
    for col in ("SPECIES_CODE", "CATEGORY", "EXTINCT", "COMMON_NAME",
                "SCIENTIFIC_NAME"):
        if col not in rows[0]:
            sys.exit(f"eBird CSV has no {col} column; headers are "
                     f"{list(rows[0])}")

    tax = json.loads(Path(args.taxonomy).read_text())
    by_code = {}
    for i, entry in enumerate(tax):
        code = entry[2] if len(entry) > 2 else ""
        if code:
            by_code[code] = (i, entry)

    # CATEGORY must be species. eBird also flags extinct issf/form taxa, which
    # are subspecies groups that were never in the classifier, so counting them
    # would inflate the list with names we cannot match.
    flagged = [r for r in rows
               if r["CATEGORY"] == "species" and r["EXTINCT"].strip()]

    hits, unmatched = [], []
    for r in flagged:
        found = by_code.get(r["SPECIES_CODE"])
        if found:
            idx, entry = found
            hits.append({
                "idx": idx,
                "code": r["SPECIES_CODE"],
                "scientific": entry[1],
                "common": entry[0],
                "extinct_year": r["EXTINCT_YEAR"].strip() or None,
            })
        else:
            unmatched.append((r["SPECIES_CODE"], r["COMMON_NAME"]))

    hits.sort(key=lambda h: h["idx"])
    print(f"  eBird species flagged EXTINCT : {len(flagged)}")
    print(f"  matched into our taxonomy     : {len(hits)}")
    print(f"  flagged but not in taxonomy   : {len(unmatched)}")

    # An unmatched flagged species means an extinct bird SURVIVES the drop while
    # every artifact stays internally consistent, so verify-taxonomy-drop.py
    # passes and nothing downstream notices.
    if unmatched and not args.allow_unmatched:
        print(f"\nERROR: {len(unmatched)} flagged species did not match a "
              f"taxonomy row by species code.", file=sys.stderr)
        for code, name in unmatched[:20]:
            print(f"    {code}  {name}", file=sys.stderr)
        if len(unmatched) > 20:
            print(f"    ... and {len(unmatched) - 20} more", file=sys.stderr)
        sys.exit("refusing to write an incomplete exclusion list; re-run with "
                 "--allow-unmatched once the names above are confirmed absent "
                 "from the taxonomy")

    out = {
        "source": "eBird taxonomy EXTINCT column",
        "source_url": EBIRD_CSV_URL,
        "rule": "CATEGORY == species AND EXTINCT is set",
        "note": (
            "Follows eBird rather than AviList/IUCN so the extinct rule comes "
            "from the same authority as species codes, names and taxonomic "
            "order. This keeps Extinct in the Wild species, which exist in "
            "captivity and are being reintroduced, and drops species eBird "
            "considers gone that IUCN still rates CR or CR (PE)."),
        "taxonomy_rows": len(tax),
        "count": len(hits),
        "species": [
            {k: h[k] for k in ("code", "scientific", "common", "extinct_year")}
            for h in hits
        ],
    }
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
    print(f"\nwrote {args.out}: {len(hits)} species")


if __name__ == "__main__":
    main()
