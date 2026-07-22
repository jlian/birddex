#!/usr/bin/env python3
"""Resumable, rate-limited iNaturalist bird image downloader for distillation.

Reads species.json (from select_species.py) and downloads research-grade,
openly-licensed (CC) photos per species into:

  <out>/corpus/<inat_taxon_id>/<photo_id>.jpg
  <out>/manifest.jsonl        # one row per downloaded image (license audit)

Design:
  - Only research_grade observations with a CC / CC0 / public-domain photo
    license (excludes "all rights reserved" so the corpus stays open).
  - Rate-limited (<=~60 req/min) with --sleep; resumable via manifest so it can
    run in chunks across days without refetching.
  - --per-species caps images per species (long-tailed dataset otherwise).
  - Records license + attribution + observation id per image for the eventual
    open-weight license audit.

Usage:
  python download_inat.py --out ~/spikes/bioclip-birdid/distill \
      --per-species 200 --sleep 1.1
  python download_inat.py --out ... --per-species 200 --limit-species 25   # pilot
"""
import argparse
import json
import os
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SPECIES = os.path.join(HERE, "species.json")

INAT_OBS = "https://api.inaturalist.org/v1/observations"
USER_AGENT = "WingDex-distill/0.1 (research; github.com/jlian/wingdex)"

# iNat photo license codes we accept (open). "all rights reserved" (None/"") excluded.
OPEN_LICENSES = {"cc0", "cc-by", "cc-by-nc", "cc-by-sa", "cc-by-nc-sa", "cc-by-nd", "cc-by-nc-nd"}


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def _download(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    tmp = dest + ".part"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, dest)
    return len(data)


def medium_url(photo_url):
    """iNat photo urls come as .../square.jpg; swap to medium for training."""
    return photo_url.replace("/square.", "/medium.")


def load_done(manifest_path):
    done = set()
    if os.path.exists(manifest_path):
        for line in open(manifest_path):
            try:
                done.add(json.loads(line)["photo_id"])
            except Exception:  # noqa: BLE001
                continue
    return done


def fetch_species(taxon_id, want, sleep):
    """Yield photo dicts for a taxon, paging observations until `want` collected."""
    collected = 0
    page = 1
    per_page = 200
    while collected < want:
        q = urllib.parse.urlencode({
            "taxon_id": taxon_id,
            "quality_grade": "research",
            "photo_license": ",".join(OPEN_LICENSES),
            "photos": "true",
            "order_by": "votes",   # community-favored photos tend to be cleaner
            "per_page": per_page,
            "page": page,
        })
        data = _get(f"{INAT_OBS}?{q}")
        results = data.get("results", [])
        if not results:
            break
        for obs in results:
            # GPS: iNat returns "location" as "lat,lon" (obscured/randomized for
            # threatened taxa; absent when the observer withheld it). Captured so
            # range priors can be used as a training-time signal.
            lat = lon = None
            loc = obs.get("location")
            if loc and "," in loc:
                try:
                    lat_s, lon_s = loc.split(",", 1)
                    lat, lon = float(lat_s), float(lon_s)
                except ValueError:
                    lat = lon = None
            geoprivacy = obs.get("geoprivacy") or obs.get("taxon_geoprivacy")
            for photo in obs.get("photos", []):
                lic = (photo.get("license_code") or "").lower()
                if lic not in OPEN_LICENSES:
                    continue
                url = photo.get("url")
                if not url:
                    continue
                yield {
                    "photo_id": photo["id"],
                    "url": medium_url(url),
                    "license_code": lic,
                    "attribution": photo.get("attribution"),
                    "observation_id": obs.get("id"),
                    "observed_on": obs.get("observed_on"),
                    "lat": lat,
                    "lon": lon,
                    "geoprivacy": geoprivacy,
                }
                collected += 1
                if collected >= want:
                    return
        page += 1
        if page > 50:  # safety
            break
        time.sleep(sleep)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="output root (corpus/ + manifest.jsonl go here)")
    ap.add_argument("--species", default=SPECIES)
    ap.add_argument("--per-species", type=int, default=200)
    ap.add_argument("--limit-species", type=int, default=0, help="0 = all; else pilot on first N")
    ap.add_argument("--sleep", type=float, default=1.1)
    args = ap.parse_args()

    spec = json.load(open(args.species))["species"]
    if args.limit_species:
        spec = spec[: args.limit_species]

    corpus_dir = os.path.join(args.out, "corpus")
    os.makedirs(corpus_dir, exist_ok=True)
    manifest_path = os.path.join(args.out, "manifest.jsonl")
    done = load_done(manifest_path)
    print(f"{len(spec)} species, {len(done)} images already in manifest", flush=True)

    total_new = 0
    with open(manifest_path, "a") as mf:
        for si, sp in enumerate(spec):
            tid = sp["inat_taxon_id"]
            sp_dir = os.path.join(corpus_dir, str(tid))
            os.makedirs(sp_dir, exist_ok=True)
            got = 0
            for photo in fetch_species(tid, args.per_species, args.sleep):
                if photo["photo_id"] in done:
                    got += 1
                    continue
                dest = os.path.join(sp_dir, f"{photo['photo_id']}.jpg")
                try:
                    nbytes = _download(photo["url"], dest)
                except Exception as e:  # noqa: BLE001
                    print(f"    ! {photo['url']}: {e}", flush=True)
                    time.sleep(args.sleep * 3)
                    continue
                row = {
                    "app_idx": sp["idx"],
                    "inat_taxon_id": tid,
                    "scientific": sp["scientific"],
                    "common": sp["common"],
                    "path": os.path.relpath(dest, args.out),
                    "bytes": nbytes,
                    **photo,
                }
                mf.write(json.dumps(row) + "\n")
                mf.flush()
                done.add(photo["photo_id"])
                got += 1
                total_new += 1
                time.sleep(args.sleep)
            print(f"[{si+1}/{len(spec)}] {sp['common']:30s} taxon={tid} +{got}", flush=True)
    print(f"done, {total_new} new images this run", flush=True)


if __name__ == "__main__":
    main()
