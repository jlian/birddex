#!/usr/bin/env python3
"""Phase 1b: pull corpus images from the iNat Open Data S3 bucket (parallel HTTPS).

Reads manifest.parquet (from build_manifest.py) and downloads each photo from
the PUBLIC bucket over plain HTTPS. These are static S3 objects, NOT the
rate-limited API, so we parallelize hard (default 16 workers).

  URL:  https://inaturalist-open-data.s3.amazonaws.com/photos/<photo_id>/medium.<ext>
  dest: <out>/corpus/<inat_taxon_id>/<photo_id>.<ext>

Resumable: skips files already on disk. Writes a download_manifest.jsonl of
successes (with license/attribution/GPS for the license audit) and a
failures.log. Safe to re-run to fill gaps.

Usage:
  python pull_images.py --manifest manifest.parquet \
      --out ~/spikes/bioclip-birdid/distill --size medium --workers 16
"""
import argparse
import json
import os
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

import duckdb

BASE = "https://inaturalist-open-data.s3.amazonaws.com/photos"
UA = "WingDex-distill/0.1 (research; github.com/jlian/wingdex)"

_write_lock = threading.Lock()


def fetch_one(row, corpus_dir, size):
    photo_id = row["photo_id"]
    ext = (row["extension"] or "jpg").strip() or "jpg"
    tid = row["inat_taxon_id"]
    sp_dir = os.path.join(corpus_dir, str(tid))
    dest = os.path.join(sp_dir, f"{photo_id}.{ext}")
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return ("skip", row, None)
    url = f"{BASE}/{photo_id}/{size}.{ext}"
    try:
        os.makedirs(sp_dir, exist_ok=True)
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
        tmp = dest + ".part"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, dest)
        return ("ok", row, len(data))
    except Exception as e:  # noqa: BLE001
        return ("fail", row, str(e))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True, help="manifest.parquet")
    ap.add_argument("--out", required=True, help="corpus/ + logs go here")
    ap.add_argument("--size", default="medium",
                    choices=["original", "large", "medium", "small", "thumb"])
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--limit", type=int, default=0, help="0=all; else pilot on first N")
    args = ap.parse_args()

    corpus_dir = os.path.join(args.out, "corpus")
    os.makedirs(corpus_dir, exist_ok=True)
    dl_manifest = os.path.join(args.out, "download_manifest.jsonl")
    fail_log = os.path.join(args.out, "failures.log")

    con = duckdb.connect()
    q = f"SELECT * FROM read_parquet('{args.manifest}')"
    if args.limit:
        q += f" LIMIT {args.limit}"
    rows = con.execute(q).fetchdf().to_dict("records")
    print(f"{len(rows):,} photos in manifest, {args.workers} workers, size={args.size}", flush=True)

    ok = skip = fail = 0
    total_bytes = 0
    with open(dl_manifest, "a") as mf, open(fail_log, "a") as ff, \
            ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = [ex.submit(fetch_one, r, corpus_dir, args.size) for r in rows]
        for i, fut in enumerate(as_completed(futs)):
            status, row, info = fut.result()
            if status == "ok":
                ok += 1
                total_bytes += info
                rec = {
                    "photo_id": int(row["photo_id"]),
                    "inat_taxon_id": int(row["inat_taxon_id"]),
                    "app_idx": int(row["app_idx"]),
                    "scientific": row["scientific"],
                    "common": row["common"],
                    "license": row["license"],
                    "observer_id": (int(row["observer_id"])
                                    if row["observer_id"] is not None else None),
                    "observation_uuid": row["observation_uuid"],
                    "latitude": row["latitude"],
                    "longitude": row["longitude"],
                    "observed_on": row["observed_on"],
                    "extension": row["extension"],
                    "bytes": info,
                }
                with _write_lock:
                    mf.write(json.dumps(rec, default=str) + "\n")
            elif status == "skip":
                skip += 1
            else:
                fail += 1
                with _write_lock:
                    ff.write(f"{row['photo_id']}\t{info}\n")
            if (i + 1) % 2000 == 0:
                print(f"  {i+1:,}/{len(rows):,}  ok={ok} skip={skip} fail={fail} "
                      f"{total_bytes/1e9:.1f}GB", flush=True)
    print(f"done: ok={ok} skip={skip} fail={fail} total={total_bytes/1e9:.2f}GB", flush=True)
    if fail:
        print(f"  {fail} failures logged to {fail_log}; re-run to retry (resumable)", flush=True)


if __name__ == "__main__":
    main()
