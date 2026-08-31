#!/usr/bin/env python3
"""Drop EX/EW species from taxonomy.json and report what must be rebuilt.

WHY A SCRIPT RATHER THAN AN EDIT
--------------------------------
Species are keyed by ROW INDEX into taxonomy.json in three places: the int8
text classifier (row i of the matrix IS species i), the occurrence blob and the
rarity blob. Dropping rows renumbers every later species, so all four artifacts
must be regenerated together against the SAME new file.

All three consumers verify at load, so a half-applied change fails loudly
rather than mis-keying silently:
  - BirdIdEngine throws speciesCountMismatch if names.count != rowCount - 1
  - both blob parsers throw on a taxonomy-hash mismatch

This script does step 1 and prints the exact remaining steps with the new hash.
It writes the KEPT INDEX MAP so the classifier re-emit drops the same rows.

Usage:
  python3 scripts/drop-extinct.py --list scripts/extinct-species.json
  python3 scripts/drop-extinct.py --list ... --apply
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TAX = ROOT / "src" / "lib" / "taxonomy.json"


def norm(s):
    return re.sub(r"\s+", " ", str(s or "")).strip().lower()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", required=True,
                    help="output of emit-extinct-list.py")
    ap.add_argument("--apply", action="store_true",
                    help="write the files; otherwise dry-run")
    ap.add_argument("--map-out", default=str(ROOT / "scripts" / "taxonomy-keep-map.json"))
    args = ap.parse_args()

    tax = json.loads(TAX.read_text())
    spec = json.loads(Path(args.list).read_text())
    drop_sci = {norm(s["scientific"]) for s in spec["species"]}

    if spec.get("taxonomy_rows") != len(tax):
        msg = (f"list was built against {spec.get('taxonomy_rows')} rows, "
               f"taxonomy.json now has {len(tax)}")
        # A stale list must not be allowed to write. Re-running the documented
        # --apply command against an already-dropped taxonomy matches zero rows,
        # so it would rewrite taxonomy.json unchanged and emit a keep-map that
        # is the identity, silently overwriting the real map that records which
        # 152 rows went. The classifier re-emit reads that map, so the damage
        # only surfaces later as mis-keyed species.
        if args.apply:
            sys.exit(f"ERROR: {msg}\n"
                     f"       Re-run scripts/emit-extinct-list.py against the "
                     f"current taxonomy, or drop --apply to dry-run.")
        print(f"WARNING: {msg}", file=sys.stderr)

    keep, dropped = [], []
    matched_sci = set()
    for i, row in enumerate(tax):
        sci = norm(row[1] if len(row) > 1 else "")
        if sci in drop_sci:
            dropped.append(i)
            matched_sci.add(sci)
        else:
            keep.append(i)

    # The row-count check above is necessary but not sufficient: a list built
    # against a DIFFERENT taxonomy with the same number of rows passes it, then
    # matches only some of its species here. The drop would still look
    # successful, the artifacts would still agree with each other, and the
    # unmatched extinct species would simply survive. Every name in the list
    # must land on a row.
    missing = sorted(drop_sci - matched_sci)
    if missing:
        print(f"\nERROR: {len(missing)} of {len(drop_sci)} species in the "
              f"exclusion list did not match a taxonomy row:", file=sys.stderr)
        for sci in missing[:20]:
            print(f"    {sci}", file=sys.stderr)
        if len(missing) > 20:
            print(f"    ... and {len(missing) - 20} more", file=sys.stderr)
        sys.exit("the list does not describe this taxonomy; refusing to "
                 "continue")

    old_bytes = TAX.read_bytes()
    old_hash = hashlib.sha256(old_bytes).hexdigest()[:16]
    new_tax = [tax[i] for i in keep]
    # Serialise EXACTLY as the committed taxonomy.json is stored: the whole
    # array on one line. This is what makes the drop reproducible, since the
    # keep-map new_sha16, the client constants and both blob headers all key
    # off these bytes.
    #
    # KNOWN COST, deliberately not changed here: one line means a 152-row drop
    # renders as 11,169 deletions and 1 insertion, so a reviewer cannot see
    # WHICH species went. Writing one row per line fixes the diff and
    # round-trips the pre-drop file byte for byte, but it moves the taxonomy
    # hash (61cd7f2a1e3093e9 -> bcfc23ea0c5f9bdd) and therefore requires
    # rebuilding the occurrence blob, the rarity blob, both meta files, the iOS
    # golden fixture and four source constants together. Changing the
    # serializer WITHOUT that rebuild is worse than either option: the script
    # then cannot reproduce the artifacts this PR ships.
    new_bytes = (json.dumps(new_tax, ensure_ascii=False,
                            separators=(",", ":")) + "\n").encode()
    new_hash = hashlib.sha256(new_bytes).hexdigest()[:16]

    print(f"  taxonomy rows : {len(tax):,} -> {len(new_tax):,}  "
          f"(dropped {len(dropped)})")
    print(f"  first dropped : index {dropped[0] if dropped else '-'}"
          f"  ({tax[dropped[0]][0] if dropped else '-'})")
    # Rows AFTER the first removal that survive to be renumbered. Counting
    # len(tax) - first - 1 overcounts, because the later dropped rows do not
    # survive to be renumbered at all.
    renumbered = sum(1 for i in keep if dropped and i > dropped[0])
    print(f"  renumbered    : {renumbered:,} rows")
    print(f"  sha256[:16]   : {old_hash} -> {new_hash}")

    if not args.apply:
        print("\n  DRY RUN. Re-run with --apply to write.")
        return 0

    TAX.write_bytes(new_bytes)
    Path(args.map_out).write_text(json.dumps(
        dict(old_rows=len(tax), new_rows=len(new_tax),
             kept_old_indexes=keep, dropped_old_indexes=dropped,
             old_sha16=old_hash, new_sha16=new_hash), indent=1) + "\n")
    print(f"\n  wrote {TAX}")
    print(f"  wrote {args.map_out}")
    print(f"""
  REMAINING STEPS, all four artifacts must ship together:

    2. remap app_idx in the target taxa CSV, THEN re-emit the classifier.
       jobs/build_prior_blob_month.py reads app_idx STRAIGHT out of that CSV,
       so an occurrence blob built against the old column is keyed to the OLD
       row numbers and mis-names every species after the first drop. The
       rarity blob does not read the CSV at all, but it is derived FROM the
       occurrence blob, so it inherits the same mis-keying.
       Pass --old-taxonomy: without it the CSV is bound to the taxonomy by
       index arithmetic alone, and a CSV from a different {len(tax)}-row
       taxonomy would remap cleanly into a mis-keyed blob:
         git show <pre-drop-sha>:src/lib/taxonomy.json > /tmp/old-taxonomy.json
         python3 scripts/remap-target-taxa.py \\
           --map {args.map_out} --csv <target_taxa.csv> \\
           --old-taxonomy /tmp/old-taxonomy.json

    3. re-emit the int8 classifier, keeping ONLY the rows in
       taxonomy-keep-map.json kept_old_indexes, in order, then the probe row.
       --keep-map is NOT optional here: it defaults to empty, and without it
       the emitter writes every source row and produces a classifier with the
       OLD species count:
         python3 ml/distill/jobs/emit_int8_classifier.py \\
           --keep-map {args.map_out}

    4. rebuild the occurrence blob against the NEW taxonomy and the
       REMAPPED csv. It MUST be the month builder with --v4: the older
       ml/distill/build_prior_blob.py writes VERSION = 2, and step 5 rejects
       anything below v4, so that path cannot complete. The shipped blob was
       built with --v4 and k 0.3:
         python3 ml/distill/jobs/build_prior_blob_month.py --v4 --k 0.3 \\
           --taxonomy src/lib/taxonomy.json \\
           --target-taxa <remapped target_taxa.csv> \\
           --occurrence <occurrence_month.parquet> --out <new blob>

    5. rebuild the rarity blob. It takes NO csv: it reads the occurrence
       blob from step 4 and re-keys off that, so step 4 must land first:
         ml/distill/build_rarity_blob.py --taxonomy src/lib/taxonomy.json \\
           --occurrence public/priors/occurrence.<new-hash>.bin.gz ...

    6. update the hash in BOTH clients:
         src/lib/taxonomy-hash.ts          TAXONOMY_SHA16 = "{new_hash}"
         ios/.../BirdIdEngine.swift        taxonomySha16  = "{new_hash}"

  Verify with scripts/verify-taxonomy-drop.py before shipping.
""")
    return 0


if __name__ == "__main__":
    sys.exit(main())
