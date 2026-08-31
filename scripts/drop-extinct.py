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
    for i, row in enumerate(tax):
        if norm(row[1] if len(row) > 1 else "") in drop_sci:
            dropped.append(i)
        else:
            keep.append(i)

    old_bytes = TAX.read_bytes()
    old_hash = hashlib.sha256(old_bytes).hexdigest()[:16]
    new_tax = [tax[i] for i in keep]
    # Match the existing file's formatting so the diff is only the removals.
    new_bytes = (json.dumps(new_tax, ensure_ascii=False,
                            separators=(",", ":")) + "\n").encode()
    new_hash = hashlib.sha256(new_bytes).hexdigest()[:16]

    print(f"  taxonomy rows : {len(tax):,} -> {len(new_tax):,}  "
          f"(dropped {len(dropped)})")
    print(f"  first dropped : index {dropped[0] if dropped else '-'}"
          f"  ({tax[dropped[0]][0] if dropped else '-'})")
    print(f"  renumbered    : {len(tax) - (dropped[0] if dropped else len(tax)) - 1:,} rows")
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
       build_prior_blob.py and build_rarity_blob.py read app_idx straight
       out of that CSV, so a blob built against the old column is keyed to
       the OLD row numbers and mis-names every species after the first drop:
         python3 scripts/remap-target-taxa.py \\
           --map {args.map_out} --csv <target_taxa.csv>

    3. re-emit the int8 classifier, keeping ONLY the rows in
       taxonomy-keep-map.json kept_old_indexes, in order, then the probe row:
         ml/distill/jobs/emit_int8_classifier.py

    4. rebuild the occurrence blob against the NEW taxonomy and the
       REMAPPED csv:
         ml/distill/build_prior_blob.py --taxonomy src/lib/taxonomy.json ...

    5. rebuild the rarity blob against the NEW taxonomy and the REMAPPED csv:
         ml/distill/build_rarity_blob.py --taxonomy src/lib/taxonomy.json ...

    6. update the hash in BOTH clients:
         src/lib/taxonomy-hash.ts          TAXONOMY_SHA16 = "{new_hash}"
         ios/.../BirdIdEngine.swift        taxonomySha16  = "{new_hash}"

  Verify with scripts/verify-taxonomy-drop.py before shipping.
""")
    return 0


if __name__ == "__main__":
    sys.exit(main())
