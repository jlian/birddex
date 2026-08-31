#!/usr/bin/env python3
"""Remap the app_idx column of a target taxa CSV onto the post-drop taxonomy.

WHY THIS IS A SEPARATE STEP
---------------------------
build_prior_blob.py and build_rarity_blob.py key species by app_idx read
STRAIGHT OUT of the target taxa CSV, not by looking anything up in
taxonomy.json. They hash the taxonomy and embed that hash, so a blob built
from a stale CSV still carries the NEW hash and passes every client check
while being keyed to the OLD row numbers. Nothing downstream can catch it:
the mis-keying is silent and shifts by one more row for every dropped
species that sorts before it.

So the CSV has to be remapped BEFORE the blobs are rebuilt.

Rows whose app_idx was dropped are removed entirely: the species no longer
exists in the taxonomy, so there is no index to point at. Their occurrence
records would otherwise join against a shifted index and contribute another
species' range.

Usage:
  python3 scripts/remap-target-taxa.py --map scripts/taxonomy-keep-map.json \
    --csv ml/distill/target_taxa.csv
  python3 scripts/remap-target-taxa.py --map ... --csv ... --out remapped.csv
"""
import argparse
import csv
import json
import sys
from pathlib import Path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", required=True,
                    help="taxonomy-keep-map.json from drop-extinct.py")
    ap.add_argument("--csv", required=True, help="target taxa CSV to remap")
    ap.add_argument("--out", help="output path; default is in place")
    args = ap.parse_args()

    keep = json.loads(Path(args.map).read_text())
    # kept_old_indexes[new] == old, so invert it to rewrite old -> new.
    old_to_new = {old: new for new, old in enumerate(keep["kept_old_indexes"])}

    src = Path(args.csv)
    rows = list(csv.DictReader(src.open(newline="")))
    if not rows:
        sys.exit(f"ERROR: {src} has no rows")
    if "app_idx" not in rows[0]:
        sys.exit(f"ERROR: {src} has no app_idx column; columns are "
                 f"{list(rows[0])}")

    idxs = [int(r["app_idx"]) for r in rows]
    seen = set(idxs)
    expected = keep["old_rows"]
    # The CSV must span the PRE-DROP taxonomy EXACTLY: every index from 0 to
    # old_rows - 1, once each.
    #
    # Checking only the upper bound let an already-remapped file through: its
    # max is new_rows - 1, which is below old_rows, so a second run would remap
    # new indexes as if they were old and shift every row again.
    #
    # Checking only the maximum is also not enough on its own. A CSV missing an
    # index, or carrying a duplicate row, still ends at 11166 and would pass,
    # then hand the blob builders a taxon that never appears or appears twice,
    # while this script printed a contiguous range and looked correct.
    if max(seen) != expected - 1:
        already = ""
        if max(seen) == keep["new_rows"] - 1:
            already = ("  That is exactly the post-drop range, so this CSV has "
                       "ALREADY been remapped.")
        sys.exit(f"ERROR: {src} spans app_idx 0..{max(seen)}, but the map was "
                 f"built from a {expected}-row taxonomy and needs "
                 f"0..{expected - 1}.{already}")

    if len(idxs) != len(seen):
        dupes = sorted({i for i in seen if idxs.count(i) > 1})
        sys.exit(f"ERROR: {src} repeats app_idx {dupes[:10]}"
                 f"{' and more' if len(dupes) > 10 else ''}; each taxon must "
                 f"appear exactly once or the blobs double-count it")

    missing = sorted(set(range(expected)) - seen)
    if missing:
        sys.exit(f"ERROR: {src} is missing {len(missing)} app_idx value(s), "
                 f"starting {missing[:10]}; the CSV must cover every row of "
                 f"the pre-drop taxonomy or those taxa vanish from the blobs")

    out_rows, dropped = [], []
    for r in rows:
        old = int(r["app_idx"])
        if old in old_to_new:
            r["app_idx"] = str(old_to_new[old])
            out_rows.append(r)
        else:
            dropped.append(old)

    dest = Path(args.out) if args.out else src
    with dest.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(out_rows)

    print(f"  read    {len(rows)} rows from {src}")
    print(f"  dropped {len(dropped)} rows for extinct species")
    print(f"  wrote   {len(out_rows)} rows to {dest}")
    print(f"  app_idx now spans 0..{keep['new_rows'] - 1}")


if __name__ == "__main__":
    main()
