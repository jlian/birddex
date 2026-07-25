#!/usr/bin/env python3
"""Gate 1: integrity check for the packed WebDataset shards.

Verifies the shards on the NAS are a faithful, complete, readable copy of what
the manifest + cached teacher embeddings say they should be, BEFORE anyone
deletes the local corpus.

Checks:
  1. shards.json exists and every shard it lists is present on disk
  2. every shard opens as a valid tar and has a sane member count
  3. sample counts sum to what shards.json claims
  4. every sample has all three members (.jpg/.emb/.cls) -- no half-written pairs
  5. random-sampled embeddings still match the source npz BIT-FOR-BIT
  6. random-sampled taxon ids still match the manifest
  7. random-sampled jpgs actually decode as images

Exit code 0 = all gates pass. Non-zero = do NOT delete anything.
"""
import argparse
import glob
import io
import json
import os
import random
import sys
import tarfile

import numpy as np


def log(m):
    print(m, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wds", default="/mnt/nas/WingDex-Distill/wds")
    ap.add_argument("--embeddings-dir", default="embeddings")
    ap.add_argument("--train-manifest", default="train_manifest.parquet")
    ap.add_argument("--sample", type=int, default=300,
                    help="how many samples to deep-verify against source")
    ap.add_argument("--deep-shards", type=int, default=0,
                    help="0 = scan ALL shards for member integrity (slower but "
                         "that is the point of a pre-deletion gate)")
    ap.add_argument("--max-dup-gap", type=int, default=1400,
                    help="tolerated shortfall between rows-written and distinct "
                         "tar keys, caused by duplicate photo_ids in the source "
                         "manifest (measured: 1,368). Beyond this = real loss")
    a = ap.parse_args()

    failures = []

    # --- 1. shards.json ---
    meta_path = os.path.join(a.wds, "shards.json")
    if not os.path.exists(meta_path):
        log(f"FAIL: no shards.json at {meta_path}")
        return 1
    meta = json.load(open(meta_path))
    listed = meta.get("shards", [])
    claimed_total = meta.get("samples_written", 0)
    log(f"shards.json: {len(listed)} shards, {claimed_total:,} samples claimed")
    log(f"  skipped at pack time: no-embedding={meta.get('skipped_no_embedding', 0):,} "
        f"no-image={meta.get('skipped_no_image', 0):,}")

    on_disk = sorted(glob.glob(os.path.join(a.wds, "shard-*.tar")))
    log(f"on disk: {len(on_disk)} shard files")
    listed_names = {e["shard"] for e in listed}
    disk_names = {os.path.basename(p) for p in on_disk}
    missing = listed_names - disk_names
    extra = disk_names - listed_names
    if missing:
        failures.append(f"{len(missing)} shards in shards.json are MISSING on disk: "
                        f"{sorted(missing)[:5]}")
    if extra:
        log(f"  note: {len(extra)} shard files not listed in shards.json "
            f"(likely a partial/aborted run): {sorted(extra)[:5]}")

    # --- 2/3/4. open every shard, count members, check triples ---
    total_samples = 0
    bad_shards = []
    incomplete = 0
    scan = on_disk if not a.deep_shards else on_disk[: a.deep_shards]
    log(f"scanning {len(scan)} shards for tar validity + complete triples...")
    for i, p in enumerate(scan):
        try:
            keys = {}
            with tarfile.open(p, "r") as t:
                for m in t:
                    if not m.isfile():
                        continue
                    key, _, ext = m.name.rpartition(".")
                    keys.setdefault(key, set()).add(ext)
            n_complete = sum(1 for k, exts in keys.items()
                             if {"jpg", "emb", "cls"} <= exts)
            n_bad = len(keys) - n_complete
            incomplete += n_bad
            total_samples += n_complete
            if n_bad:
                failures.append(f"{os.path.basename(p)}: {n_bad} incomplete samples")
        except Exception as e:
            bad_shards.append((os.path.basename(p), str(e)))
        if (i + 1) % 50 == 0:
            log(f"  ...{i+1}/{len(scan)} shards, {total_samples:,} samples so far")

    if bad_shards:
        failures.append(f"{len(bad_shards)} shards failed to open: {bad_shards[:3]}")
    log(f"scanned: {total_samples:,} complete samples, {incomplete} incomplete")

    if not a.deep_shards and claimed_total and total_samples != claimed_total:
        # The packer counts ROWS WRITTEN; a tar counts DISTINCT KEYS. The source
        # manifest contains duplicate photo_ids (the same photo filed under more
        # than one taxon -- measured 2026-07-24: 2,503,107 rows vs 2,501,739
        # distinct photo_ids = 1,368 dup rows). Duplicates share a sample key, so
        # they collapse when counted by key. Tolerate a shortfall up to the known
        # duplicate count; anything beyond that is real data loss.
        gap = claimed_total - total_samples
        if gap < 0 or gap > a.max_dup_gap:
            failures.append(f"sample count mismatch: tar={total_samples:,} "
                            f"vs shards.json={claimed_total:,} (gap={gap:,}, "
                            f"tolerated up to {a.max_dup_gap:,} for known "
                            f"duplicate photo_ids)")
        else:
            log(f"  note: {gap:,} fewer distinct keys than rows written -- "
                f"expected, the manifest has duplicate photo_ids (same photo "
                f"under >1 taxon); within the {a.max_dup_gap:,} tolerance")

    # --- 5/6/7. deep-verify a random sample against the ORIGINAL sources ---
    log(f"deep-verifying {a.sample} random samples against source npz + manifest...")
    random.seed(1234)
    pick_shards = random.sample(on_disk, min(len(on_disk), 12))
    got = {}
    for p in pick_shards:
        try:
            with tarfile.open(p, "r") as t:
                cur = {}
                for m in t:
                    if not m.isfile():
                        continue
                    key, _, ext = m.name.rpartition(".")
                    cur.setdefault(key, {})[ext] = t.extractfile(m).read()
                    if len(cur) > a.sample // len(pick_shards) + 5:
                        break
                for k, d in list(cur.items())[: a.sample // len(pick_shards) + 1]:
                    if {"jpg", "emb", "cls"} <= set(d):
                        got[int(k)] = d
        except Exception as e:
            failures.append(f"deep-verify could not read {os.path.basename(p)}: {e}")
    log(f"  pulled {len(got)} samples from {len(pick_shards)} shards")

    # 5. embeddings bit-for-bit
    idx = {}
    shard_paths = sorted(glob.glob(os.path.join(a.embeddings_dir, "shard_*.npz")))
    for si, sp in enumerate(shard_paths):
        with np.load(sp) as d:
            for r, pid in enumerate(d["photo_ids"]):
                pid = int(pid)
                if pid in got:
                    idx[pid] = (si, r)
    emb_checked = emb_bad = 0
    cache = {}
    for pid, (si, r) in idx.items():
        if si not in cache:
            cache[si] = np.load(shard_paths[si])["embeddings"]
        src = cache[si][r].astype(np.float16)
        packed = np.frombuffer(got[pid]["emb"], dtype=np.float16)
        if not np.array_equal(src, packed):
            emb_bad += 1
        emb_checked += 1
    log(f"  embeddings: checked={emb_checked} mismatches={emb_bad}")
    if emb_bad:
        failures.append(f"{emb_bad} embedding mismatches vs source npz")
    if emb_checked == 0:
        failures.append("could not check ANY embeddings against source")

    # 6. taxon ids vs manifest
    try:
        import duckdb
        from collections import defaultdict
        con = duckdb.connect()
        pids = ",".join(str(p) for p in list(got.keys()))
        rows = con.execute(
            f"SELECT photo_id, inat_taxon_id FROM read_parquet('{a.train_manifest}') "
            f"WHERE photo_id IN ({pids})"
        ).fetchall()
        # A photo_id can legitimately appear under MORE THAN ONE taxon in the
        # manifest (1,368 such duplicate rows). The packed .cls only has to match
        # ONE of them, so compare against the set, not row-by-row -- otherwise
        # every duplicate is falsely reported as a mismatch.
        valid = defaultdict(set)
        for p, t in rows:
            valid[int(p)].add(int(t))
        tax_bad = sum(1 for p, opts in valid.items()
                      if int(got[p]["cls"].decode()) not in opts)
        n_dup = sum(1 for opts in valid.values() if len(opts) > 1)
        if n_dup:
            log(f"  note: {n_dup} sampled photo_ids exist under >1 taxon in the "
                f"manifest (source data duplicates, not a packing error)")
        log(f"  taxon ids: checked={len(valid)} photo_ids mismatches={tax_bad}")
        if tax_bad:
            failures.append(f"{tax_bad} taxon-id mismatches vs manifest")
    except Exception as e:
        failures.append(f"taxon check failed: {e}")

    # 7. jpgs decode
    try:
        from PIL import Image
        dec_bad = 0
        for pid, d in list(got.items())[:100]:
            try:
                Image.open(io.BytesIO(d["jpg"])).convert("RGB").load()
            except Exception:
                dec_bad += 1
        log(f"  jpeg decode: checked={min(100, len(got))} failures={dec_bad}")
        if dec_bad:
            failures.append(f"{dec_bad} jpgs failed to decode")
    except Exception as e:
        failures.append(f"decode check failed: {e}")

    log("")
    if failures:
        log("=== GATE 1 FAILED -- DO NOT DELETE THE LOCAL CORPUS ===")
        for f in failures:
            log(f"  - {f}")
        return 1
    log("=== GATE 1 PASSED: shards are complete, readable, and faithful ===")
    log(f"    {total_samples:,} samples across {len(on_disk)} shards")
    return 0


if __name__ == "__main__":
    sys.exit(main())
