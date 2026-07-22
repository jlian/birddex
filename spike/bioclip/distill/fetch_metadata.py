#!/usr/bin/env python3
"""Phase 1b: download iNaturalist AWS Open Data metadata files (anonymous HTTPS).

The Open Data bucket is public; no AWS account/creds needed. We pull the three
metadata tables we need (tab-separated .csv.gz) straight over HTTPS:

  taxa.csv.gz          (~26 MB)  taxon_id -> name/rank/ancestry
  observations.csv.gz  (~1.6 GB) observation -> taxon_id, lat/lon, date, quality
  photos.csv.gz        (~19 GB)  photo_id -> observation, license, extension

(We skip observers/projects; not needed for the corpus.)

Resumable: uses HTTP Range to continue a partial file. Verify with --list.

Usage:
  python fetch_metadata.py --out ~/spikes/bioclip-birdid/inat-metadata
  python fetch_metadata.py --out ... --only taxa            # just the small one
  python fetch_metadata.py --list                           # show S3 sizes, no download
"""
import argparse
import os
import sys
import time
import urllib.request

BASE = "https://inaturalist-open-data.s3.amazonaws.com"
FILES = {
    "taxa": "taxa.csv.gz",
    "observations": "observations.csv.gz",
    "photos": "photos.csv.gz",
}
UA = "WingDex-distill/0.1 (research; github.com/jlian/wingdex)"


def remote_size(key):
    req = urllib.request.Request(f"{BASE}/{key}", method="HEAD", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return int(r.headers.get("Content-Length", 0))


def download(key, dest):
    """Resumable download via HTTP Range."""
    total = remote_size(key)
    have = os.path.getsize(dest) if os.path.exists(dest) else 0
    if have == total and total > 0:
        print(f"  {key}: complete ({total/1e9:.2f} GB)", flush=True)
        return
    if have > total:
        print(f"  {key}: local larger than remote, restarting", flush=True)
        have = 0
    mode = "ab" if have else "wb"
    headers = {"User-Agent": UA}
    if have:
        headers["Range"] = f"bytes={have}-"
        print(f"  {key}: resuming at {have/1e9:.2f}/{total/1e9:.2f} GB", flush=True)
    else:
        print(f"  {key}: downloading {total/1e9:.2f} GB", flush=True)
    req = urllib.request.Request(f"{BASE}/{key}", headers=headers)
    t0 = time.time()
    last = have
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, mode) as f:
        while True:
            chunk = r.read(1 << 20)  # 1 MiB
            if not chunk:
                break
            f.write(chunk)
            have += len(chunk)
            if have - last >= (256 << 20):  # progress every 256 MiB
                mb = have / 1e9
                spd = (have - last) / (time.time() - t0 + 1e-9) / 1e6
                print(f"    {key}: {mb:.2f}/{total/1e9:.2f} GB ({spd:.0f} MB/s)", flush=True)
                last = have
                t0 = time.time()
    final = os.path.getsize(dest)
    ok = "OK" if final == total else f"SIZE MISMATCH ({final} != {total})"
    print(f"  {key}: done {final/1e9:.2f} GB [{ok}]", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", help="destination dir for metadata files")
    ap.add_argument("--only", choices=list(FILES), help="download just one file")
    ap.add_argument("--list", action="store_true", help="show remote sizes and exit")
    args = ap.parse_args()

    if args.list:
        for name, key in FILES.items():
            print(f"{name:14s} {key:24s} {remote_size(key)/1e9:8.2f} GB")
        return

    if not args.out:
        sys.exit("--out required (or use --list)")
    os.makedirs(args.out, exist_ok=True)
    keys = {args.only: FILES[args.only]} if args.only else FILES
    for name, key in keys.items():
        download(key, os.path.join(args.out, key))
    print("metadata fetch complete", flush=True)


if __name__ == "__main__":
    main()
