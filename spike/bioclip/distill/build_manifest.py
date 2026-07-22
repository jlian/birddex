#!/usr/bin/env python3
"""Phase 1b: build the corpus photo manifest from iNat Open Data metadata (DuckDB).

Reads the gzipped metadata CSVs in place (DuckDB streams .csv.gz, no full
decompress / no 25GB import), joins photos -> observations -> taxa, filters to
our target bird taxa + open licenses, applies a per-species cap, and emits a
manifest of exactly which photos to pull from S3.

Target taxa come from matching WingDex's taxonomy.json (scientific name) against
the iNat `taxa` table. Retires the old API resolver entirely.

Outputs (in --out):
  target_taxa.csv     app_idx, common, scientific, inat_taxon_id, avail_photos
  manifest.parquet    one row per selected photo: photo_id, extension, license,
                      observer_id, inat_taxon_id, app_idx, scientific, common,
                      observation_uuid, latitude, longitude, observed_on
  manifest_stats.txt  summary: species covered, photos/species histogram

iNat metadata schema (tab-separated, header row):
  taxa:         taxon_id, ancestry, rank_level, rank, name, active
  observations: observation_uuid, observer_id, latitude, longitude,
                positional_accuracy, taxon_id, quality_grade, observed_on
  photos:       photo_uuid, photo_id, observation_uuid, observer_id,
                extension, license, width, height, position

Usage:
  python build_manifest.py --meta ~/spikes/bioclip-birdid/inat-metadata \
      --taxonomy taxonomy.json --out ~/spikes/bioclip-birdid/distill \
      --per-species 300 --min-photos 50 --research-only --require-gps
"""
import argparse
import json
import os
import sys

import duckdb

# Open licenses we accept (iNat stores these strings in photos.license).
OPEN_LICENSES = ["CC0", "CC-BY", "CC-BY-NC", "CC-BY-SA",
                 "CC-BY-ND", "CC-BY-NC-SA", "CC-BY-NC-ND"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--meta", required=True, help="dir with taxa/observations/photos .csv.gz")
    ap.add_argument("--taxonomy", required=True, help="WingDex taxonomy.json")
    ap.add_argument("--out", required=True)
    ap.add_argument("--per-species", type=int, default=300, help="max photos per species")
    ap.add_argument("--min-photos", type=int, default=50, help="drop species below this")
    ap.add_argument("--research-only", action="store_true", help="quality_grade=research")
    ap.add_argument("--require-gps", action="store_true", help="only photos with lat/lon")
    ap.add_argument("--threads", type=int, default=0, help="DuckDB threads (0=auto)")
    ap.add_argument("--memory-limit", default="24GB")
    args = ap.parse_args()

    taxa_csv = os.path.join(args.meta, "taxa.csv.gz")
    obs_csv = os.path.join(args.meta, "observations.csv.gz")
    photos_csv = os.path.join(args.meta, "photos.csv.gz")
    for p in (taxa_csv, obs_csv, photos_csv):
        if not os.path.exists(p):
            sys.exit(f"missing metadata file: {p} (run fetch_metadata.py first)")

    os.makedirs(args.out, exist_ok=True)
    # WingDex taxonomy: [common, scientific, ebird, wiki_common, thumb, wiki_id]
    taxo = json.load(open(args.taxonomy))
    app_rows = [(i, r[0], r[1]) for i, r in enumerate(taxo)]

    con = duckdb.connect(os.path.join(args.out, "corpus_build.duckdb"))
    if args.threads:
        con.execute(f"PRAGMA threads={args.threads}")
    con.execute(f"PRAGMA memory_limit='{args.memory_limit}'")

    print("registering app taxonomy...", flush=True)
    con.execute("CREATE OR REPLACE TABLE app_taxa(app_idx INT, common VARCHAR, scientific VARCHAR)")
    con.executemany("INSERT INTO app_taxa VALUES (?,?,?)", app_rows)

    # read_csv over .csv.gz; iNat files are TAB-separated with a header.
    def rc(path):
        return (f"read_csv('{path}', delim='\\t', header=true, "
                f"quote='', escape='', ignore_errors=true, all_varchar=true)")

    print("matching app species -> iNat taxon ids (taxa.csv.gz)...", flush=True)
    con.execute(f"""
        CREATE OR REPLACE TABLE target_taxa AS
        SELECT app_idx, common, scientific, inat_taxon_id FROM (
          SELECT a.app_idx, a.common, a.scientific,
                 CAST(t.taxon_id AS BIGINT) AS inat_taxon_id,
                 row_number() OVER (
                   PARTITION BY a.app_idx
                   ORDER BY (t.active = 'true') DESC, CAST(t.taxon_id AS BIGINT) ASC
                 ) AS rn
          FROM app_taxa a
          JOIN {rc(taxa_csv)} t
            ON lower(t.name) = lower(a.scientific)
           AND t.rank = 'species'
        ) WHERE rn = 1
    """)
    n_matched = con.execute("SELECT count(*) FROM target_taxa").fetchone()[0]
    print(f"  matched {n_matched}/{len(app_rows)} app species to iNat taxa", flush=True)

    # observations filtered to target taxa (+ optional quality/gps)
    obs_where = ["o.taxon_id IS NOT NULL"]
    if args.research_only:
        obs_where.append("o.quality_grade = 'research'")
    if args.require_gps:
        obs_where.append("o.latitude IS NOT NULL AND o.longitude IS NOT NULL "
                         "AND o.latitude <> '' AND o.longitude <> ''")
    print("filtering observations to target taxa...", flush=True)
    con.execute(f"""
        CREATE OR REPLACE TABLE obs AS
        SELECT o.observation_uuid,
               CAST(o.taxon_id AS BIGINT) AS taxon_id,
               TRY_CAST(o.latitude AS DOUBLE) AS latitude,
               TRY_CAST(o.longitude AS DOUBLE) AS longitude,
               o.observed_on, o.quality_grade
        FROM {rc(obs_csv)} o
        JOIN target_taxa tt ON CAST(o.taxon_id AS BIGINT) = tt.inat_taxon_id
        WHERE {' AND '.join(obs_where)}
    """)
    n_obs = con.execute("SELECT count(*) FROM obs").fetchone()[0]
    print(f"  {n_obs:,} matching observations", flush=True)

    # join photos, filter to open licenses; this streams the 19GB photos.csv.gz
    lic_list = ",".join(f"'{l}'" for l in OPEN_LICENSES)
    print("joining photos.csv.gz + license filter (streams ~19GB)...", flush=True)
    con.execute(f"""
        CREATE OR REPLACE TABLE photos_open AS
        SELECT CAST(p.photo_id AS BIGINT) AS photo_id,
               p.extension, p.license,
               CAST(p.observer_id AS BIGINT) AS observer_id,
               p.observation_uuid
        FROM {rc(photos_csv)} p
        WHERE p.license IN ({lic_list})
    """)
    con.execute("""
        CREATE OR REPLACE TABLE cand AS
        SELECT po.photo_id, po.extension, po.license, po.observer_id,
               o.observation_uuid, o.taxon_id AS inat_taxon_id,
               o.latitude, o.longitude, o.observed_on,
               tt.app_idx, tt.scientific, tt.common
        FROM photos_open po
        JOIN obs o ON po.observation_uuid = o.observation_uuid
        JOIN target_taxa tt ON o.taxon_id = tt.inat_taxon_id
    """)
    n_cand = con.execute("SELECT count(*) FROM cand").fetchone()[0]
    print(f"  {n_cand:,} candidate open-licensed photos", flush=True)

    # per-species cap (deterministic: order by photo_id) + min-photos floor
    print(f"applying per-species cap={args.per_species}, min={args.min_photos}...", flush=True)
    con.execute(f"""
        CREATE OR REPLACE TABLE ranked AS
        SELECT *, row_number() OVER (PARTITION BY inat_taxon_id ORDER BY photo_id) AS rn,
               count(*) OVER (PARTITION BY inat_taxon_id) AS sp_total
        FROM cand
    """)
    con.execute(f"""
        CREATE OR REPLACE TABLE manifest AS
        SELECT photo_id, extension, license, observer_id, observation_uuid,
               inat_taxon_id, app_idx, scientific, common,
               latitude, longitude, observed_on
        FROM ranked
        WHERE rn <= {args.per_species} AND sp_total >= {args.min_photos}
    """)

    # emit target_taxa with available-photo counts
    con.execute(f"""
        COPY (
          SELECT tt.app_idx, tt.common, tt.scientific, tt.inat_taxon_id,
                 COALESCE(c.avail, 0) AS avail_photos
          FROM target_taxa tt
          LEFT JOIN (SELECT inat_taxon_id, count(*) AS avail FROM cand GROUP BY 1) c
            ON tt.inat_taxon_id = c.inat_taxon_id
          ORDER BY avail_photos DESC
        ) TO '{os.path.join(args.out, "target_taxa.csv")}' (HEADER, DELIMITER ',')
    """)
    con.execute(f"COPY manifest TO '{os.path.join(args.out, 'manifest.parquet')}' (FORMAT parquet)")

    # stats
    n_final = con.execute("SELECT count(*) FROM manifest").fetchone()[0]
    n_species = con.execute("SELECT count(DISTINCT inat_taxon_id) FROM manifest").fetchone()[0]
    hist = con.execute("""
        WITH per AS (SELECT inat_taxon_id, count(*) c FROM manifest GROUP BY 1)
        SELECT
          sum(c>=1000)::INT AS b1000, sum(c BETWEEN 500 AND 999)::INT AS b500,
          sum(c BETWEEN 200 AND 499)::INT AS b200, sum(c BETWEEN 100 AND 199)::INT AS b100,
          sum(c BETWEEN 50 AND 99)::INT AS b50, sum(c<50)::INT AS blt50
        FROM per
    """).fetchone()
    stats = (
        f"target app species matched: {n_matched}\n"
        f"final species in corpus (>= {args.min_photos} photos): {n_species}\n"
        f"total photos to download: {n_final:,}\n"
        f"est. size @ ~120KB/medium: {n_final*120/1e6:.1f} GB\n"
        f"per-species photo buckets: >=1000:{hist[0]} 500-999:{hist[1]} "
        f"200-499:{hist[2]} 100-199:{hist[3]} 50-99:{hist[4]} <50:{hist[5]}\n"
    )
    open(os.path.join(args.out, "manifest_stats.txt"), "w").write(stats)
    print("\n" + stats, flush=True)
    print(f"manifest -> {os.path.join(args.out, 'manifest.parquet')}", flush=True)


if __name__ == "__main__":
    main()
