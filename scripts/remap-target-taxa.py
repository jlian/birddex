#!/usr/bin/env python3
"""Remap the app_idx column of a target taxa CSV onto the post-drop taxonomy.

WHY THIS IS A SEPARATE STEP
---------------------------
build_prior_blob.py keys species by app_idx read STRAIGHT OUT of the target
taxa CSV, not by looking anything up in taxonomy.json. It hashes the taxonomy
and embeds that hash, so an occurrence blob built from a stale CSV still
carries the NEW hash and passes every client check while being keyed to the
OLD row numbers. Nothing downstream can catch it: the mis-keying is silent and
shifts by one more row for every dropped species that sorts before it.

build_rarity_blob.py does NOT read the CSV. It takes --occurrence and derives
its taxonomy-indexed data from the rebuilt WDOP blob, refusing to run if that
blob's taxonomy hash does not match. So it inherits the occurrence blob's
keying rather than deriving its own, which means a mis-keyed occurrence blob
produces a mis-keyed rarity blob without the CSV ever being involved.

So the CSV has to be remapped BEFORE the occurrence blob is rebuilt, and the
rarity blob has to be rebuilt after it.

Rows whose app_idx was dropped are removed entirely: the species no longer
exists in the taxonomy, so there is no index to point at. Their occurrence
records would otherwise join against a shifted index and contribute another
species' range.

Usage:
  python3 scripts/remap-target-taxa.py --map scripts/taxonomy-keep-map.json \
    --csv ml/distill/target_taxa.csv --old-taxonomy <pre-drop taxonomy.json>
  python3 scripts/remap-target-taxa.py --map ... --csv ... --out remapped.csv

The pre-drop taxonomy comes out of git, e.g.
  git show <pre-drop-sha>:src/lib/taxonomy.json > /tmp/old-taxonomy.json
"""
import argparse
import csv
import hashlib
import json
import re
import sys
from pathlib import Path


def norm(s):
    return re.sub(r"\s+", " ", str(s or "")).strip().lower()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", required=True,
                    help="taxonomy-keep-map.json from drop-extinct.py")
    ap.add_argument("--csv", required=True, help="target taxa CSV to remap")
    ap.add_argument("--out", help="output path; default is in place")
    ap.add_argument("--old-taxonomy",
                    help="the PRE-DROP taxonomy.json the CSV was built "
                         "against. Its hash is checked against the map's "
                         "old_sha16 and every CSV scientific name is compared "
                         "at its app_idx. Skipping it leaves the CSV bound to "
                         "the taxonomy by index arithmetic alone.")
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
    #
    # Both endpoints have to be checked. A row with app_idx -1 keeps the right
    # maximum, adds no duplicate and leaves nothing missing, so every other
    # check here passes. It is then absent from old_to_new and gets counted as
    # one more dropped species, silently inflating the drop.
    if min(seen) != 0:
        out_of_range = sorted(i for i in seen if i < 0)
        sys.exit(f"ERROR: {src} holds app_idx {out_of_range[:10]}; indexes must "
                 f"start at 0. A negative index is not a taxonomy row and "
                 f"would be silently treated as a dropped species.")

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

    # Numeric coverage still does not say the CSV belongs to THIS taxonomy. A
    # CSV from a different or reordered 11,167-row taxonomy holds every app_idx
    # exactly once and passes everything above, and the remap would then bind
    # its iNaturalist ids to the wrong post-drop species while the blob
    # builders embed the correct new taxonomy hash. The result is a blob that
    # verifies clean and is mis-keyed.
    #
    # The only fix is to check the NAMES against the pre-drop taxonomy the map
    # was built from, which is what old_sha16 identifies.
    if args.old_taxonomy:
        old_path = Path(args.old_taxonomy)
        old_hash = hashlib.sha256(old_path.read_bytes()).hexdigest()[:16]
        if old_hash != keep["old_sha16"]:
            sys.exit(f"ERROR: {old_path} has sha256[:16] {old_hash}, but the "
                     f"map was built from {keep['old_sha16']}. This is not the "
                     f"pre-drop taxonomy, so comparing names against it proves "
                     f"nothing.")
        old_tax = json.loads(old_path.read_text())
        if len(old_tax) != expected:
            sys.exit(f"ERROR: {old_path} has {len(old_tax):,} rows, the map "
                     f"expects {expected:,}")
        if "scientific" not in rows[0]:
            sys.exit(f"ERROR: {src} has no scientific column, so it cannot be "
                     f"checked against the taxonomy; columns are "
                     f"{list(rows[0])}")

        bad = []
        for r in rows:
            i = int(r["app_idx"])
            if norm(old_tax[i][1]) != norm(r["scientific"]):
                bad.append((i, r["scientific"], old_tax[i][1]))
        if bad:
            print(f"ERROR: {len(bad)} row(s) name a different species than the "
                  f"pre-drop taxonomy holds at that app_idx:", file=sys.stderr)
            for i, got, want in bad[:10]:
                print(f"    app_idx {i}: csv {got!r}, taxonomy {want!r}",
                      file=sys.stderr)
            sys.exit("this CSV was not built against the taxonomy the map "
                     "describes; remapping it would mis-key the blobs")
        print(f"  checked {len(rows):,} scientific names against "
              f"{old_path.name} ({old_hash})")
    else:
        print("  WARNING: no --old-taxonomy given, so the CSV is bound to the "
              "taxonomy by index arithmetic only", file=sys.stderr)

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
