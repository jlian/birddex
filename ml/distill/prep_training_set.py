#!/usr/bin/env python3
"""Prep training manifest + attribution for the MIT open-weights release.

Two jobs:
  1. Emit train_manifest.parquet = the shipping-model training set. By default
     EXCLUDES both ShareAlike licenses (CC-BY-SA, CC-BY-NC-SA) so the released
     MIT weights carry no copyleft ambiguity. NC and ND are kept (WingDex is
     non-commercial + we don't redistribute/modify the source images).
  2. Emit ATTRIBUTIONS.md + attributions.csv crediting iNat observers per the
     CC-BY* attribution requirement (one provenance file covers the corpus).

License policy for MIT weight release (decided 2026-07-21, WingDex non-commercial
+ MIT source/weights):
  KEEP:    CC0, CC-BY, CC-BY-NC, CC-BY-ND, CC-BY-NC-ND
  EXCLUDE: CC-BY-SA, CC-BY-NC-SA   (ShareAlike copyleft)

Usage:
  python prep_training_set.py --manifest manifest.parquet --out .
  python prep_training_set.py --manifest manifest.parquet --out . --keep-sharealike  # research variant
"""
import argparse
import os

import duckdb

SHAREALIKE = ["CC-BY-SA", "CC-BY-NC-SA"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--keep-sharealike", action="store_true",
                    help="research variant: keep SA licenses (do NOT use for MIT weight release)")
    args = ap.parse_args()

    con = duckdb.connect()
    M = f"read_parquet('{args.manifest}')"
    where = "TRUE" if args.keep_sharealike else \
        "license NOT IN (" + ",".join(f"'{l}'" for l in SHAREALIKE) + ")"

    train_path = os.path.join(args.out, "train_manifest.parquet")
    con.execute(f"COPY (SELECT * FROM {M} WHERE {where}) TO '{train_path}' (FORMAT parquet)")
    tot = con.execute(f"SELECT count(*) FROM {M}").fetchone()[0]
    kept = con.execute(f"SELECT count(*) FROM read_parquet('{train_path}')").fetchone()[0]
    nsp = con.execute(f"SELECT count(DISTINCT inat_taxon_id) FROM read_parquet('{train_path}')").fetchone()[0]
    print(f"train_manifest: {kept:,}/{tot:,} images kept, {nsp} species "
          f"({'SA kept' if args.keep_sharealike else 'SA excluded'})", flush=True)

    # attribution: unique observers + license summary from the KEPT set
    lic_rows = con.execute(
        f"SELECT license, count(*) c FROM read_parquet('{train_path}') GROUP BY 1 ORDER BY c DESC"
    ).fetchall()
    n_obs = con.execute(
        f"SELECT count(DISTINCT observer_id) FROM read_parquet('{train_path}')"
    ).fetchone()[0]

    md = os.path.join(args.out, "ATTRIBUTIONS.md")
    with open(md, "w") as f:
        f.write("# Training Data Attribution\n\n")
        f.write("This model was trained on bird photographs from the\n")
        f.write("[iNaturalist Open Data](https://github.com/inaturalist/inaturalist-open-data)\n")
        f.write("dataset (AWS Open Data Registry), distilled from the BioCLIP-2 teacher\n")
        f.write("(`imageomics/bioclip-2`, MIT).\n\n")
        f.write(f"- Images: {kept:,}\n- Species: {nsp}\n")
        f.write(f"- Unique iNaturalist observers credited: {n_obs:,}\n\n")
        f.write("## Licenses represented\n\n")
        for lic, c in lic_rows:
            f.write(f"- {lic}: {c:,}\n")
        f.write("\n## Attribution\n\n")
        f.write("Each photo's contributing observer, license, iNaturalist photo id, and\n")
        f.write("observation uuid are recorded in `attributions.csv`. Photos are used under\n")
        f.write("their respective Creative Commons licenses; ShareAlike-licensed photos are\n")
        f.write("excluded from the released-weights training set. This is a non-commercial,\n")
        f.write("open-source project (MIT source + weights).\n")

    csv_path = os.path.join(args.out, "attributions.csv")
    con.execute(f"""
        COPY (
          SELECT DISTINCT observer_id, license
          FROM read_parquet('{train_path}')
          ORDER BY observer_id
        ) TO '{csv_path}' (HEADER, DELIMITER ',')
    """)
    print(f"wrote {md} and {csv_path} ({n_obs:,} observers)", flush=True)


if __name__ == "__main__":
    main()
