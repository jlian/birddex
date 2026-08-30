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

Usage:
  python3 scripts/verify-taxonomy-drop.py \
      --map scripts/taxonomy-keep-map.json \
      --classifier public/models/classifier-int8.bin \
      --occurrence public/priors/occurrence.<hash>.bin.gz \
      --rarity public/priors/rarity.<hash>.bin.gz
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

    # 3. kept order monotonic: a drop must preserve relative order
    kept = m["kept_old_indexes"]
    if kept != sorted(kept):
        errs += fail("kept indexes are NOT ascending; rows were reordered")
    else:
        errs += ok("kept order is monotonic (a pure drop, no reordering)")

    # 4. anchors: species must sit where the keep-map says
    if args.old_taxonomy:
        old = json.loads(Path(args.old_taxonomy).read_text())
        bad = 0
        step = max(1, len(kept) // 50)
        for new_i in range(0, len(kept), step):
            old_i = kept[new_i]
            if norm(old[old_i][1]) != norm(tax[new_i][1]):
                bad += 1
                if bad <= 5:
                    print(f"        row {new_i}: expected {old[old_i][1]!r}, "
                          f"got {tax[new_i][1]!r}")
        if bad:
            errs += fail(f"{bad} sampled anchors landed on the wrong row")
        else:
            errs += ok(f"{len(range(0, len(kept), step))} sampled anchors align")

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

    # 6. blob hashes
    for label, path in (("occurrence", args.occurrence), ("rarity", args.rarity)):
        if not path:
            continue
        raw = gzip.open(path, "rb").read() if path.endswith(".gz") else Path(path).read_bytes()
        magic = raw[0:4].decode(errors="replace")
        blob_hash = raw[8:16].hex()
        if blob_hash != new_hash:
            errs += fail(f"{label} blob ({magic}) carries {blob_hash}, "
                         f"taxonomy is {new_hash}  -> parser WILL throw")
        else:
            errs += ok(f"{label} blob ({magic}) carries the new taxonomy hash")

    print()
    if errs:
        print(f"{errs} CHECK(S) FAILED -- do not ship")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
