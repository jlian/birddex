#!/usr/bin/env python3
"""Build the NABirds-aligned pilot species list.

WHY (2026-08-01): the original pilot was the top-500 species by GLOBAL iNat
photo count, which is a worldwide ranking -- Greater Rhea, Hawaiian Duck,
Swan Goose, piping-guans. NABirds is NORTH AMERICAN. The two sets overlap on
exactly SEVEN species, so every "NABirds top-1" number measured on the pilot
was computed over 7 species / 282 images, not the 496 species it claimed.
That silently invalidated the OOD comparisons the pilot existed to make.

Fix: choose the pilot species to BE the NABirds-overlapping set. All 401
NABirds taxa are present in our corpus with 184,958 images total (min 284
per species), so the pilot stays about the same size as before (244k) while
the OOD eval grows from 282 images to the full 24,633-image NABirds test
split.

TRADEOFF, record it: a NABirds-aligned pilot is North-American-biased and no
longer a random slice of the 7,555-species corpus, so recipe conclusions from
it may not transfer perfectly to the full run. We accept that to get a
trustworthy teacher/OOD signal.

Writes a JSON list of inat_taxon_id for pack_webdataset.py --species-file.

Usage:
    python build_nabirds_species.py --out nabirds_pilot_species.json
"""
import argparse
import json
import os

import duckdb


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train-manifest", default="train_manifest.parquet")
    ap.add_argument("--nb-map", default="nabirds_to_taxo.json")
    ap.add_argument("--taxonomy",
                    default="/home/jlian/wingdex/src/lib/taxonomy.json")
    ap.add_argument("--out", default="nabirds_pilot_species.json")
    ap.add_argument("--min-images", type=int, default=0,
                    help="drop species with fewer than N corpus images")
    args = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    os.chdir(here)

    nb = json.load(open(args.nb_map))
    taxo = json.load(open(args.taxonomy))
    nb_taxo = sorted(set(v for v in nb.values() if v is not None))
    print("NABirds covers %d taxonomy indices" % len(nb_taxo))

    sci = [taxo[t][1].lower() for t in nb_taxo]
    quoted = ",".join("'" + s.replace("'", "''") + "'" for s in sci)
    con = duckdb.connect()
    M = "read_parquet('" + args.train_manifest + "')"
    rows = con.execute(
        "SELECT inat_taxon_id, scientific, count(*) c FROM " + M +
        " WHERE lower(scientific) IN (" + quoted + ")" +
        " GROUP BY 1,2 ORDER BY c DESC, inat_taxon_id ASC").fetchall()
    print("present in corpus: %d species" % len(rows))

    if args.min_images > 0:
        before = len(rows)
        rows = [r for r in rows if r[2] >= args.min_images]
        print("--min-images %d: dropped %d, kept %d"
              % (args.min_images, before - len(rows), len(rows)))

    total = sum(r[2] for r in rows)
    print("total images: {:,}".format(total))
    print("per-species: max %d  min %d" % (rows[0][2], rows[-1][2]))

    ids = sorted(int(r[0]) for r in rows)
    json.dump(ids, open(args.out, "w"))
    print("wrote %s (%d species)" % (args.out, len(ids)))
    print("checksum (stability check): %d" % (sum(ids) % 1000000))


if __name__ == "__main__":
    main()
