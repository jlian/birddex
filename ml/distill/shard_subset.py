#!/usr/bin/env python3
"""Subset an existing WebDataset shard set down to a species list.

WHY: pack_webdataset.py reads the loose corpus/ tree, which was DELETED
2026-07-25 (every image now lives only in the packed shards). So a new pilot
cannot be packed the original way -- it has to be extracted from the full
251-shard set at /mnt/nas/WingDex-Distill/wds/.

Carries .jpg + .emb + .cls through byte-identically, so the BioCLIP-2 targets
baked into the source shards come along for free.

Usage:
    python shard_subset.py --src "/mnt/nas/WingDex-Distill/wds/shard-*.tar" \
        --species-file nabirds_pilot_species.json \
        --out /mnt/nas/WingDex-Distill/wds-nabirds401
"""
import argparse
import glob
import json
import os
import tarfile
import time
from collections import Counter


def log(m):
    print("[%s] %s" % (time.strftime("%H:%M:%S"), m), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--species-file", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--samples-per-shard", type=int, default=10000)
    args = ap.parse_args()

    keep = set(str(int(i)) for i in json.load(open(args.species_file)))
    log("target species: %d" % len(keep))
    os.makedirs(args.out, exist_ok=True)

    srcs = sorted(glob.glob(args.src))
    log("source shards: %d" % len(srcs))
    if not srcs:
        raise SystemExit("no source shards matched")

    seen = Counter()
    n_out = 0
    written = 0
    in_shard = 0
    tar = None
    t0 = time.time()

    def close():
        nonlocal tar, in_shard, n_out
        if tar is not None:
            tar.close()
            log("  closed shard %05d (%d samples)" % (n_out, in_shard))
            tar = None
            in_shard = 0
            n_out += 1

    for si, s in enumerate(srcs):
        with tarfile.open(s) as tf:
            group = {}
            gkey = None
            for m in tf:
                if not m.isfile():
                    continue
                key, _, ext = m.name.rpartition(".")
                if gkey is not None and key != gkey:
                    group = {}
                gkey = key
                group[ext] = (m, tf.extractfile(m).read())
                if "cls" not in group:
                    continue
                cid = group["cls"][1].decode("utf-8").strip()
                if cid not in keep:
                    group = {}
                    continue
                if "jpg" not in group or "emb" not in group:
                    continue
                if tar is None:
                    p = os.path.join(args.out, "shard-%05d.tar" % n_out)
                    tar = tarfile.open(p, "w")
                for ext2 in ("jpg", "emb", "cls"):
                    mi, data = group[ext2]
                    ti = tarfile.TarInfo(name=gkey + "." + ext2)
                    ti.size = len(data)
                    ti.mtime = mi.mtime
                    ti.mode = mi.mode
                    import io as _io
                    tar.addfile(ti, _io.BytesIO(data))
                seen[cid] += 1
                written += 1
                in_shard += 1
                group = {}
                if in_shard >= args.samples_per_shard:
                    close()
        el = time.time() - t0
        log("src %d/%d  kept %s  %.0f rec/s" %
            (si + 1, len(srcs), "{:,}".format(written), written / max(1e-9, el)))
    close()

    log("DONE written={:,} shards={} species_seen={}".format(
        written, n_out, len(seen)))
    if seen:
        c = sorted(seen.values())
        log("per-species: max %d min %d median %d" % (c[-1], c[0], c[len(c) // 2]))
    missing = keep - set(seen.keys())
    if missing:
        log("WARNING %d target species had NO samples" % len(missing))
    json.dump(sorted(seen.keys()), open(os.path.join(args.out, "species.json"), "w"))
    log("wrote %s/species.json" % args.out)


if __name__ == "__main__":
    main()
