"""Build a HARD negatives set: real wildlife photos that are NOT birds.

Imagenette negatives are chainsaws and golf balls. Nothing is bird-shaped,
so the 3.0% pass rate measured there is a floor rather than a guarantee.
The negatives that decide whether an abstention gate is shippable are what a
birder actually photographs by mistake: squirrels, deer, chipmunks,
butterflies, lizards, and frogs, usually perched on a branch in the same
kind of frame a bird would occupy.

iNat taxa.csv.gz carries an ancestry path, and class Aves is taxon 3, so
birds can be excluded exactly rather than by name matching. Photos come from
the same S3 bucket the corpus used.

Emits hard-negatives/<taxon>/<photo_id>.<ext> plus a manifest.
"""
import argparse
import csv
import gzip
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ML = "/home/jlian/wingdex/ml"
META = os.path.join(ML, "inat-metadata")
OUT = os.path.join(ML, "hard-negatives")
UA = "WingDex/1.0 (research; github.com/jlian/wingdex)"
AVES = "3"

# Genera a birder photographs by accident, or that share a bird-like frame.
WANTED = [
    "Sciurus", "Tamias", "Tamiasciurus", "Marmota",
    "Odocoileus", "Procyon", "Lepus", "Sylvilagus",
    "Danaus", "Papilio", "Bombus", "Vanessa",
    "Sceloporus", "Anolis", "Thamnophis", "Plestiodon",
    "Ursus", "Canis", "Vulpes", "Mephitis",
    "Trachemys", "Lithobates", "Anaxyrus", "Pseudacris",
]


def is_bird(ancestry):
    """True when class Aves appears as a path element, not a substring."""
    return AVES in (ancestry or "").split("/")


def pick_taxa():
    """taxon_id -> label, for research-grade non-bird targets."""
    hits = {}
    with gzip.open(os.path.join(META, "taxa.csv.gz"), "rt") as f:
        r = csv.DictReader(f, delimiter=chr(9))
        for row in r:
            if row.get("rank") != "species":
                continue
            name = row.get("name") or ""
            genus = name.split(" ")[0]
            if genus not in WANTED:
                continue
            if is_bird(row.get("ancestry")):
                continue
            hits[row["taxon_id"]] = name
    return hits


def pick_observations(taxa, per_taxon):
    """observation_uuid -> taxon_id, capped per taxon."""
    want = {}
    counts = {}
    with gzip.open(os.path.join(META, "observations.csv.gz"), "rt") as f:
        r = csv.DictReader(f, delimiter=chr(9))
        for row in r:
            t = row.get("taxon_id")
            if t not in taxa:
                continue
            if row.get("quality_grade") != "research":
                continue
            if counts.get(t, 0) >= per_taxon:
                continue
            counts[t] = counts.get(t, 0) + 1
            want[row["observation_uuid"]] = t
    return want


def pick_photos(obs):
    """One photo per observation, position 0, permissive license only."""
    out = []
    seen = set()
    ok_lic = ("CC0", "CC-BY", "CC-BY-NC")
    with gzip.open(os.path.join(META, "photos.csv.gz"), "rt") as f:
        r = csv.DictReader(f, delimiter=chr(9))
        for row in r:
            o = row.get("observation_uuid")
            if o not in obs or o in seen:
                continue
            if row.get("position") != "0":
                continue
            if row.get("license") not in ok_lic:
                continue
            seen.add(o)
            out.append((row["photo_id"], row["extension"], obs[o]))
    return out


def fetch(job):
    pid, ext, taxon = job
    d = os.path.join(OUT, str(taxon))
    os.makedirs(d, exist_ok=True)
    dest = os.path.join(d, "%s.%s" % (pid, ext))
    if os.path.exists(dest) and os.path.getsize(dest) > 1000:
        return "skip"
    url = "https://inaturalist-open-data.s3.amazonaws.com/photos/%s/medium.%s" % (pid, ext)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
        tmp = dest + ".part"
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, dest)
        return "ok"
    except urllib.error.HTTPError as e:
        return "http%d" % e.code
    except Exception as e:
        return "err:%s" % type(e).__name__


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-taxon", type=int, default=25)
    ap.add_argument("--workers", type=int, default=24)
    a = ap.parse_args()

    csv.field_size_limit(10 ** 7)
    os.makedirs(OUT, exist_ok=True)

    t0 = time.time()
    taxa = pick_taxa()
    print("non-bird target species: %d" % len(taxa), flush=True)
    if not taxa:
        sys.exit("no taxa matched, refusing to continue")

    obs = pick_observations(taxa, a.per_taxon)
    print("observations selected: %d  (%.0fs)" % (len(obs), time.time() - t0), flush=True)

    photos = pick_photos(obs)
    random.Random(0).shuffle(photos)
    print("photos to fetch: %d  (%.0fs)" % (len(photos), time.time() - t0), flush=True)

    counts = {}
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        for n, status in enumerate(ex.map(fetch, photos)):
            counts[status] = counts.get(status, 0) + 1
            if n and n % 200 == 0:
                print("  %d/%d" % (n, len(photos)), flush=True)

    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump({"taxa": taxa, "count": len(photos)}, f)

    print("")
    print("=== done in %.0fs ===" % (time.time() - t0))
    for k, v in sorted(counts.items()):
        print("  %-12s %d" % (k, v))


if __name__ == "__main__":
    main()
