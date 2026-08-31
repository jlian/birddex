#!/usr/bin/env python3
"""Verify a taxonomy drop left every artifact aligned.

THE RISK THIS EXISTS FOR
------------------------
Row i of the int8 classifier matrix must BE species i in taxonomy.json. If the
classifier is re-emitted dropping a different set of rows than the taxonomy
did, every species after the first divergence shifts by one and the model
returns correct embeddings under WRONG NAMES. Nothing crashes: the row count
matches, the hash matches, and the app ships confidently mislabelled results.

That is the failure the hash guards cannot catch, because they check the
taxonomy against itself, not the classifier against the taxonomy.

Checks:
  1. classifier row count == taxonomy rows + 1 probe row
  2. no dropped species survives in the taxonomy
  3. a set of anchor species land on the rows the keep-map says they should
  4. both blobs carry the new taxonomy hash
  5. the kept order is monotonic in the OLD indexes (no reordering)
  6. with --old-classifier, every kept row is byte-identical to the row the
     keep-map says it came from, which is the only check that distinguishes
     "152 rows were dropped" from "the RIGHT 152 rows were dropped"

Usage:
  python3 scripts/verify-taxonomy-drop.py \
      --map scripts/taxonomy-keep-map.json \
      --classifier public/models/text_classifier_int8.bin \
      --occurrence public/priors/occurrence.<hash>.bin.gz \
      --rarity public/priors/rarity.<hash>.bin.gz \
      --old-taxonomy <pre-drop taxonomy.json> \
      --old-classifier <pre-drop text_classifier_int8.bin>

All five inputs are required to reach "all checks passed". Omitting any one of
them reports PARTIAL VERIFICATION and exits 2, on purpose: the taxonomy and
keep-map checks alone say nothing about whether the artifacts are aligned.

The pre-drop files come out of git, e.g.
  git show <pre-drop-sha>:public/models/text_classifier_int8.bin > /tmp/old.bin
  git show <pre-drop-sha>:src/lib/taxonomy.json > /tmp/old-taxonomy.json
"""
import argparse
import gzip
import hashlib
import json
import re
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TAX = ROOT / "src" / "lib" / "taxonomy.json"
DIM = 768


def norm(s):
    return re.sub(r"\s+", " ", str(s or "")).strip().lower()


def fail(msg):
    print(f"  FAIL  {msg}")
    return 1


def ok(msg):
    print(f"  ok    {msg}")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", required=True)
    ap.add_argument("--classifier")
    ap.add_argument("--occurrence")
    ap.add_argument("--rarity")
    ap.add_argument("--old-taxonomy",
                    help="the pre-drop taxonomy.json, for anchor checks")
    ap.add_argument("--old-classifier",
                    help="the pre-drop text_classifier_int8.bin, to check WHICH "
                         "rows were dropped rather than just how many")
    args = ap.parse_args()

    errs = 0
    m = json.loads(Path(args.map).read_text())
    tax = json.loads(TAX.read_text())
    new_hash = hashlib.sha256(TAX.read_bytes()).hexdigest()[:16]

    print(f"taxonomy: {len(tax):,} rows, sha256[:16] {new_hash}")
    print()

    # 1. row count
    if len(tax) != m["new_rows"]:
        errs += fail(f"taxonomy has {len(tax):,} rows, keep-map expects {m['new_rows']:,}")
    else:
        errs += ok(f"row count matches the keep-map ({len(tax):,})")

    # 2. hash recorded in the map
    if new_hash != m["new_sha16"]:
        errs += fail(f"taxonomy hash {new_hash} != keep-map {m['new_sha16']}")
    else:
        errs += ok("taxonomy hash matches the keep-map")

    # 3. the keep-map must be an exact partition of the OLD row space.
    #
    # Ascending order alone does not establish a pure drop, because duplicates
    # sort too: a map of [0, 1, 1] with dropped [3] is ascending, has the right
    # length, and drives a taxonomy where old row 2 silently disappears and row
    # 1 appears twice. Kept and dropped must be disjoint, in range, and cover
    # 0..old_rows-1 exactly once between them.
    kept = m["kept_old_indexes"]
    dropped_idx = m["dropped_old_indexes"]
    old_rows = m["old_rows"]

    if kept != sorted(kept):
        errs += fail("kept indexes are NOT ascending; rows were reordered")
    else:
        errs += ok("kept order is monotonic (a pure drop, no reordering)")

    kept_set, dropped_set = set(kept), set(dropped_idx)
    part_errs = []
    if len(kept_set) != len(kept):
        dupes = sorted({i for i in kept if kept.count(i) > 1})
        part_errs.append(f"kept repeats {dupes[:5]}")
    if len(dropped_set) != len(dropped_idx):
        part_errs.append("dropped repeats an index")
    if kept_set & dropped_set:
        part_errs.append(f"kept and dropped overlap at "
                         f"{sorted(kept_set & dropped_set)[:5]}")
    out_of_range = sorted(i for i in kept_set | dropped_set
                          if i < 0 or i >= old_rows)
    if out_of_range:
        part_errs.append(f"indexes outside 0..{old_rows - 1}: "
                         f"{out_of_range[:5]}")
    uncovered = set(range(old_rows)) - kept_set - dropped_set
    if uncovered:
        part_errs.append(f"{len(uncovered)} old row(s) neither kept nor "
                         f"dropped, starting {sorted(uncovered)[:5]}")
    if len(kept) != m["new_rows"]:
        part_errs.append(f"kept length {len(kept):,} != new_rows "
                         f"{m['new_rows']:,}")

    if part_errs:
        for e in part_errs:
            errs += fail(f"keep-map is not a partition: {e}")
        # Every check below indexes `old` and `tax` THROUGH this map. Carrying
        # on with a map already proven invalid turns a diagnosed failure into
        # an IndexError traceback, which hides the diagnosis that was just
        # printed. Stop here and report normally.
        print()
        print(f"{errs} CHECK(S) FAILED -- do not ship")
        print("  the keep-map is not a valid partition, so no artifact check "
              "below it can be trusted; fix the map first")
        return 1
    else:
        errs += ok(f"keep-map partitions all {old_rows:,} old rows exactly "
                   f"({len(kept):,} kept + {len(dropped_idx):,} dropped)")

    # 4. EVERY kept row must be the species the keep-map says it is.
    #
    # This was a ~51-row sample, which cannot establish the property. The
    # keep-map is the input to both the taxonomy edit and the classifier
    # re-emit, and the row-identity check below re-uses that same map, so a
    # wrong kept_old_indexes entry outside the sample would drive the rebuild
    # AND satisfy the check that is supposed to catch it. Comparing every row
    # against the old taxonomy is the only step here that ties the map to
    # something it did not produce, so it has to be exhaustive.
    if args.old_taxonomy:
        old = json.loads(Path(args.old_taxonomy).read_text())

        old_hash = hashlib.sha256(Path(args.old_taxonomy).read_bytes()) \
            .hexdigest()[:16]
        if old_hash != m["old_sha16"]:
            errs += fail(f"--old-taxonomy hash {old_hash} != keep-map "
                         f"{m['old_sha16']}; this is not the taxonomy the map "
                         f"was built from, so the comparison below is "
                         f"meaningless")
        else:
            errs += ok("old taxonomy hash matches the keep-map")

        if len(old) != m["old_rows"]:
            errs += fail(f"--old-taxonomy has {len(old):,} rows, keep-map "
                         f"expects {m['old_rows']:,}")
        else:
            # Compare the WHOLE row, not just the scientific name. Every field
            # here is row-indexed by some consumer: common name and eBird code
            # go out in labels.json, and the image path renders in the UI. A
            # taxonomy whose scientific names are correctly ordered but whose
            # common names or codes shifted by one would pass a name-only
            # check and ship mislabelled birds, which is the exact failure
            # this script exists to catch.
            bad = 0
            for new_i, old_i in enumerate(kept):
                if old[old_i] != tax[new_i]:
                    bad += 1
                    if bad <= 5:
                        diff = [j for j in range(max(len(old[old_i]),
                                                     len(tax[new_i])))
                                if (old[old_i][j:j + 1] != tax[new_i][j:j + 1])]
                        j = diff[0]
                        print(f"        row {new_i} (old {old_i}): fields "
                              f"{diff} differ; field {j} expected "
                              f"{old[old_i][j:j + 1]}, got {tax[new_i][j:j + 1]}")
            if bad:
                errs += fail(f"{bad:,} of {len(kept):,} kept rows do not match "
                             f"their source row field for field")
            else:
                errs += ok(f"all {len(kept):,} kept rows match their source "
                           f"row field for field")

            # The dropped rows must be GONE, not merely absent from the map.
            dropped_sci = {norm(old[i][1]) for i in m["dropped_old_indexes"]}
            survivors = sorted(dropped_sci & {norm(r[1]) for r in tax})
            if survivors:
                errs += fail(f"{len(survivors)} dropped species survive in the "
                             f"taxonomy, e.g. {survivors[:5]}")
            else:
                errs += ok(f"none of the {len(dropped_sci):,} dropped species "
                           f"survive in the taxonomy")

    # 5. classifier row count
    if args.classifier:
        n_bytes = Path(args.classifier).stat().st_size
        n = n_bytes // (DIM + 4)
        if n * (DIM + 4) != n_bytes:
            errs += fail(f"classifier size {n_bytes} is not a whole number of rows")
        elif n - 1 != len(tax):
            errs += fail(f"classifier has {n-1:,} species rows + probe, "
                         f"taxonomy has {len(tax):,}  -> app WILL throw at launch")
        else:
            errs += ok(f"classifier has {n-1:,} species rows + 1 probe row")

    # 5b. classifier ROW IDENTITY against the pre-drop file.
    #
    # The row count above passes for ANY 152 dropped rows, which is exactly the
    # silent mis-keying this script exists to catch: a classifier that dropped a
    # different 152 has the right size, the right hash, and the wrong names.
    #
    # Rows are L2-normalised then quantised per row, so a kept row must be
    # BYTE-IDENTICAL to its old-index row: same int8 payload, same fp32 scale.
    # Comparing bytes rather than decoded floats means no tolerance to argue
    # about, and it pins the probe row too.
    if args.classifier and args.old_classifier:
        new_raw = Path(args.classifier).read_bytes()
        old_raw = Path(args.old_classifier).read_bytes()
        n_new = len(new_raw) // (DIM + 4)
        n_old = len(old_raw) // (DIM + 4)

        if n_old - 1 != m["old_rows"]:
            errs += fail(f"old classifier has {n_old-1:,} species rows, keep-map "
                         f"describes {m['old_rows']:,}")
        elif n_new - 1 != len(kept):
            errs += fail(f"new classifier has {n_new-1:,} species rows, keep-map "
                         f"keeps {len(kept):,}")
        else:
            def row(raw, n_rows, i):
                q = raw[i * DIM:(i + 1) * DIM]
                base = n_rows * DIM
                return q, raw[base + i * 4:base + (i + 1) * 4]

            bad = 0
            for new_i, old_i in enumerate(kept):
                if row(new_raw, n_new, new_i) != row(old_raw, n_old, old_i):
                    bad += 1
                    if bad <= 5:
                        print(f"        row {new_i} is not old row {old_i} "
                              f"({tax[new_i][1]!r})")
            if bad:
                errs += fail(f"{bad:,} of {len(kept):,} kept rows do not match "
                             f"their old-index row  -> species ARE mis-keyed")
            else:
                errs += ok(f"all {len(kept):,} kept classifier rows are "
                           f"byte-identical to their old-index row")

            # The probe is the last row of both files and must survive intact.
            if row(new_raw, n_new, n_new - 1) != row(old_raw, n_old, n_old - 1):
                errs += fail("the probe row changed  -> bird/not-bird gate moved")
            else:
                errs += ok("the probe row is unchanged")
    elif args.classifier:
        print("        note: pass --old-classifier to check WHICH rows were "
              "dropped, not just how many")

    # 6. blob magic + hashes
    #
    # The magic must be checked, not merely printed. Both blobs carry the SAME
    # taxonomy hash, so swapping --occurrence and --rarity passes the hash
    # comparison for both and reports a clean run: a mistyped full-verification
    # command then produces a false green, which is worse than no check.
    for label, path, want in (("occurrence", args.occurrence, "WDOP"),
                              ("rarity", args.rarity, "WDRR")):
        if not path:
            continue
        raw = gzip.open(path, "rb").read() if path.endswith(".gz") else Path(path).read_bytes()
        magic = raw[0:4].decode(errors="replace")
        blob_hash = raw[8:16].hex()
        if magic != want:
            errs += fail(f"--{label} is a {magic} blob, expected {want}  -> "
                         f"the arguments are swapped or the wrong file was "
                         f"passed")
            continue
        if blob_hash != new_hash:
            errs += fail(f"{label} blob ({magic}) carries {blob_hash}, "
                         f"taxonomy is {new_hash}  -> parser WILL throw")
        else:
            errs += ok(f"{label} blob ({magic}) carries the new taxonomy hash")

    print()
    if errs:
        print(f"{errs} CHECK(S) FAILED -- do not ship")
        return 1

    # "all checks passed" with no artifacts to inspect is a lie: the taxonomy
    # and keep-map checks alone say nothing about whether the classifier or the
    # blobs are aligned, which is the entire point of the script. Report what
    # was NOT checked rather than implying a clean bill of health.
    skipped = [name for name, path in (("--classifier", args.classifier),
                                       ("--occurrence", args.occurrence),
                                       ("--rarity", args.rarity),
                                       ("--old-taxonomy", args.old_taxonomy),
                                       ("--old-classifier", args.old_classifier))
               if not path]
    if skipped:
        print("PARTIAL VERIFICATION -- some inputs were not inspected.")
        print(f"  not inspected: {', '.join(skipped)}")
        print("  this does NOT establish that the artifacts are aligned.")
        return 2

    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
