#!/usr/bin/env python3
"""Rebuild the deterministic pilot species set from the PACKED SHARDS.

WHY THIS EXISTS (2026-08-01): pack_webdataset.py selected the pilot species
with
    SELECT inat_taxon_id ... GROUP BY 1 ORDER BY count(*) DESC LIMIT 500
There is a TIE at exactly 492 images spanning more taxa than the remaining
slots, and duckdb breaks that tie ARBITRARILY -- three consecutive runs of the
same query returned three DIFFERENT species sets.

Two consequences:
  1. The shards that actually got packed contain 496 species, not 500.
  2. eval_nabirds.py recomputed the same query, so checkpoints compared in one
     sweep were scored on DIFFERENT NABirds image subsets (n=282 / 255 / 245)
     and their top-1 numbers were not comparable to each other.

The only trustworthy source is what is physically in the shards. This script
reads the .cls members, maps them through the manifest to taxonomy indices,
and writes both artifacts. eval_nabirds.py then loads the index cache verbatim.

Re-run only if the pilot shards are re-packed:
    python build_pilot_index.py
"""
import glob
import json
import os
import tarfile
from collections import Counter

SHARDS = "/mnt/nas/WingDex-Distill/wds-pilot500/shard-*.tar"
MANIFEST = "train_manifest.parquet"
TAXONOMY = "/home/jlian/wingdex/src/lib/taxonomy.json"
OUT_CLASSES = "pilot500_classes.json"
OUT_IDX = "pilot500_taxo_idx.json"


def read_shard_classes():
    shards = sorted(glob.glob(SHARDS))
    if not shards:
        raise SystemExit("no shards matched " + SHARDS)
    print("scanning %d shards ..." % len(shards))
    cnt = Counter()
    n = 0
    for s in shards:
        with tarfile.open(s) as tf:
            for m in tf:
                if not m.name.endswith(".cls"):
                    continue
                f = tf.extractfile(m)
                if f is None:
                    continue
                cnt[f.read().decode("utf-8").strip()] += 1
                n += 1
    print("  records: %d   distinct classes: %d" % (n, len(cnt)))
    print("  per-class count range: max %d  min %d"
          % (max(cnt.values()), min(cnt.values())))
    return sorted(cnt.keys(), key=lambda x: int(x) if x.isdigit() else -1)


def to_taxonomy_indices(classes):
    import duckdb
    taxo = json.load(open(TAXONOMY))
    sci_to_idx = {r[1].lower(): i for i, r in enumerate(taxo)}
    ids = [int(c) for c in classes]
    con = duckdb.connect()
    q = ("SELECT DISTINCT inat_taxon_id, scientific FROM read_parquet('"
         + MANIFEST + "') WHERE inat_taxon_id IN ("
         + ",".join(str(i) for i in ids) + ")")
    rows = con.execute(q).fetchall()
    idxs = set()
    missing = []
    for _tid, sci in rows:
        if not sci:
            continue
        k = sci.lower()
        if k in sci_to_idx:
            idxs.add(sci_to_idx[k])
        else:
            missing.append(sci)
    print("  manifest rows matched: %d" % len(rows))
    print("  resolved taxonomy indices: %d" % len(idxs))
    if missing:
        print("  WARNING unresolved scientific names: %d %s"
              % (len(missing), missing[:5]))
    return sorted(idxs)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    os.chdir(here)
    classes = read_shard_classes()
    json.dump(classes, open(OUT_CLASSES, "w"))
    print("wrote %s (%d classes)" % (OUT_CLASSES, len(classes)))
    idxs = to_taxonomy_indices(classes)
    json.dump(idxs, open(OUT_IDX, "w"))
    print("wrote %s (%d indices)" % (OUT_IDX, len(idxs)))
    print("checksum (stability check): %d" % (sum(idxs) % 100000))


if __name__ == "__main__":
    main()
