#!/usr/bin/env python3
"""Build photo_id -> observation_uuid lookup, and a leak-free val photo-id set.

WHY: the WebDataset shards carry only <photo_id>.{jpg,emb,cls} -- no
observation_uuid -- so the loader cannot group by observation on its own. A
single iNat observation often contains SEVERAL photos of the same bird from the
same moment; hashing on photo_id therefore scatters an observation's photos
across train and val.

Measured on the 500-species pilot (2026-07-25): 2,762 observations were split
across train/val, and **56.5% of val photos came from an observation that also
appeared in training**. That inflates val_cos and the held-out eval alike, which
is exactly the leakage the SSOT's "split by observation_uuid" requirement is
about. (NABirds is unaffected -- it is external data.)

FIX: hash the OBSERVATION uuid, not the photo id, and emit the resulting val
photo-id list once so both the training loader and the held-out eval can use the
same leak-free split without repacking 252GB of shards.

Usage:
  python build_obs_split.py --manifest train_manifest.parquet \
      --out obs_split.json --val-frac 0.02
"""
import argparse
import hashlib
import json
import time

import duckdb


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


def in_val(key, val_frac, seed=42):
    """Same hashing scheme as wds_loader._in_val, but applied to a GROUP key."""
    h = hashlib.blake2b(f"{seed}:{key}".encode(), digest_size=8).digest()
    return (int.from_bytes(h, "big") % 1_000_000) < int(val_frac * 1_000_000)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default="train_manifest.parquet")
    ap.add_argument("--out", default="obs_split.json")
    ap.add_argument("--val-frac", type=float, default=0.02)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--pilot-species", type=int, default=0,
                    help="0 = whole manifest; N = top-N species only")
    a = ap.parse_args()

    con = duckdb.connect()
    M = f"read_parquet('{a.manifest}')"
    where = "TRUE"
    if a.pilot_species > 0:
        top = con.execute(f"SELECT inat_taxon_id FROM {M} GROUP BY 1 "
                          f"ORDER BY count(*) DESC LIMIT {a.pilot_species}").fetchall()
        where = "inat_taxon_id IN (" + ",".join(str(r[0]) for r in top) + ")"

    rows = con.execute(
        f"SELECT photo_id, observation_uuid FROM {M} WHERE {where}").fetchall()
    log(f"{len(rows):,} rows")

    val_ids, n_train = [], 0
    no_obs = 0
    for pid, obs in rows:
        # photos with no observation fall back to photo-id hashing
        key = obs if obs else f"photo:{pid}"
        if obs is None:
            no_obs += 1
        if in_val(key, a.val_frac, a.seed):
            val_ids.append(int(pid))
        else:
            n_train += 1

    obs_of = {}
    for pid, obs in rows:
        if obs:
            obs_of.setdefault(obs, []).append(int(pid))
    val_set = set(val_ids)
    split = sum(1 for o, pids in obs_of.items()
                if any(p in val_set for p in pids) and any(p not in val_set for p in pids))

    log(f"train={n_train:,}  val={len(val_ids):,}  "
        f"({len(val_ids)/max(1,len(rows)):.4f})")
    log(f"rows with no observation_uuid: {no_obs:,}")
    log(f"observations split across train/val: {split:,}  (want 0)")

    meta = {
        "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "manifest": a.manifest,
        "val_frac": a.val_frac,
        "seed": a.seed,
        "pilot_species": a.pilot_species,
        "grouped_by": "observation_uuid",
        "n_train": n_train,
        "n_val": len(val_ids),
        "observations_split_across_sides": split,
        "val_photo_ids": sorted(val_ids),
    }
    with open(a.out, "w") as f:
        json.dump(meta, f)
    log(f"wrote {a.out}")


if __name__ == "__main__":
    main()
