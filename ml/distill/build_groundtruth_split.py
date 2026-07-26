#!/usr/bin/env python3
"""Sample a LEAK-FREE held-out ground-truth set from iNat photos we never touched.

WHY THIS EXISTS
---------------
The distilled student was trained to match BioCLIP-2's embeddings on 2.65M
photos. Fine-tuning it on TRUE species labels is how we try to BEAT the teacher
(distillation caps you at ~teacher: the embedding IS the target). But per the
SSOT: fine-tuning on the SAME 2.65M "mostly re-touches data the student already
saw through the teacher's eyes -> recovers the teacher, doesn't beat it."

So both the fine-tune and its eval need photos the distillation NEVER saw.

WHERE THE UNTOUCHED DATA IS
---------------------------
`build_manifest.py` applied a per-species cap ordered by photo_id, i.e. it kept
the LOWEST photo_ids per species. iNat has ~52M research-grade open-licensed
photos across our 7,555 species; we downloaded 2.65M. Everything above each
species' cap cutoff is untouched -- roughly 49M photos, concentrated in common
species (rare ones were scarcity-limited, not cap-limited, so there is no hidden
reservoir for them).

TWO LEAKAGE RULES, BOTH ENFORCED HERE
-------------------------------------
1. Exclude every photo_id already in the training manifest. (obvious)
2. Exclude every photo belonging to an OBSERVATION that appears in training.
   This is the one that bites: an observation is one bird-sighting and often has
   several photos from the same moment. Keeping photo 2 of an observation whose
   photo 1 was trained on is near-duplicate leakage. Measured on our pilot,
   photo-id-only splitting left 2,762 observations straddling train/val.

PREREQUISITE
------------
Needs the iNat AWS Open Data metadata dump (taxa/observations/photos .csv.gz,
~30GB) -- the same input `build_manifest.py` uses. It was deleted with the
scratch dir on 2026-07-25; re-fetch from s3://inaturalist-open-data/ before
running this. Nothing else is required: this script only reads metadata and
emits a photo list. Actually downloading the sampled JPEGs is a separate step
(reuse pull_images.py with the emitted manifest).

Usage:
  python build_groundtruth_split.py \\
      --meta ~/inat-metadata \\
      --train-manifest train_manifest.parquet \\
      --target-taxa target_taxa.csv \\
      --per-species 40 --out groundtruth_heldout.parquet
"""
import argparse
import os
import time

import duckdb


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--meta", required=True,
                    help="dir with iNat taxa/observations/photos .csv.gz")
    ap.add_argument("--train-manifest", default="train_manifest.parquet")
    ap.add_argument("--target-taxa", default="target_taxa.csv",
                    help="species list from build_manifest.py")
    ap.add_argument("--per-species", type=int, default=40,
                    help="held-out photos to sample per species")
    ap.add_argument("--min-per-species", type=int, default=5,
                    help="drop species that cannot reach this many untouched photos")
    ap.add_argument("--out", default="groundtruth_heldout.parquet")
    ap.add_argument("--require-gps", action="store_true", default=True,
                    help="keep only GPS'd photos (the metadata fusion lever needs them)")
    ap.add_argument("--memory-limit", default="12GB",
                    help="HARD DuckDB memory cap. Without this DuckDB assumes it "
                         "may use ~80%% of visible RAM and will expand until WSL "
                         "thrashes -- that is exactly what wedged the box on "
                         "2026-07-25 (WSL is capped at 31.5GB and a training job "
                         "was also resident). build_manifest.py uses 24GB when "
                         "nothing else is running; 12GB is the safe value to "
                         "coexist with training")
    ap.add_argument("--temp-dir", default="",
                    help="DuckDB spill directory. Point this at the NAS to keep "
                         "out-of-core spill off the WSL vhdx entirely")
    ap.add_argument("--threads", type=int, default=0,
                    help="DuckDB threads (0=auto). Lower it to leave CPU for a "
                         "concurrent training job")
    a = ap.parse_args()

    taxa_csv = os.path.join(a.meta, "taxa.csv.gz")
    obs_csv = os.path.join(a.meta, "observations.csv.gz")
    photos_csv = os.path.join(a.meta, "photos.csv.gz")
    for p in (taxa_csv, obs_csv, photos_csv):
        if not os.path.exists(p):
            raise SystemExit(
                f"missing {p}\n"
                "The iNat metadata dump is required and was deleted with the "
                "scratch dir 2026-07-25. Re-fetch from s3://inaturalist-open-data/ "
                "(taxa.csv.gz, observations.csv.gz, photos.csv.gz, ~30GB)."
            )

    con = duckdb.connect()
    con.execute("PRAGMA enable_progress_bar")
    # HARD limits first -- see --memory-limit. This join streams a 19GB
    # compressed photos table and builds hash tables against 2.5M exclusion
    # rows, so it WILL go out-of-core; the only question is whether it spills
    # gracefully or eats the machine.
    con.execute(f"PRAGMA memory_limit='{a.memory_limit}'")
    log(f"duckdb memory_limit={a.memory_limit}")
    if a.threads:
        con.execute(f"PRAGMA threads={a.threads}")
        log(f"duckdb threads={a.threads}")
    if a.temp_dir:
        os.makedirs(a.temp_dir, exist_ok=True)
        con.execute(f"PRAGMA temp_directory='{a.temp_dir}'")
        log(f"duckdb spill dir={a.temp_dir}")
    rd = ("read_csv('{}', delim='\\t', header=true, quote='', escape='', "
          "ignore_errors=true, all_varchar=true)")

    log("loading training manifest (exclusion sets)...")
    con.execute(f"""
        CREATE TEMP TABLE train AS
        SELECT DISTINCT CAST(photo_id AS BIGINT) AS photo_id,
               observation_uuid
        FROM read_parquet('{a.train_manifest}')
    """)
    n_tr = con.execute("SELECT count(*) FROM train").fetchone()[0]
    n_obs = con.execute(
        "SELECT count(DISTINCT observation_uuid) FROM train").fetchone()[0]
    log(f"  {n_tr:,} trained photos across {n_obs:,} observations (both excluded)")

    log("reading target species...")
    # carry app_idx/scientific/common through: pull_images.py writes them into
    # its per-photo record, so the sampled manifest must match the schema of
    # train_manifest.parquet or the pull dies AFTER downloading each file.
    con.execute(f"""
        CREATE TEMP TABLE taxa AS
        SELECT DISTINCT
               CAST(inat_taxon_id AS BIGINT) AS inat_taxon_id,
               TRY_CAST(app_idx AS BIGINT)   AS app_idx,
               scientific,
               common
        FROM read_csv('{a.target_taxa}', header=true, all_varchar=true)
        WHERE inat_taxon_id IS NOT NULL
    """)
    n_sp = con.execute("SELECT count(*) FROM taxa").fetchone()[0]
    log(f"  {n_sp:,} target species")

    gps = "AND o.latitude IS NOT NULL AND o.longitude IS NOT NULL" if a.require_gps else ""

    log("streaming photos.csv.gz + observations.csv.gz (this is the slow part)...")
    con.execute(f"""
        CREATE TEMP TABLE candidates AS
        SELECT
            CAST(p.photo_id AS BIGINT)        AS photo_id,
            p.extension                       AS extension,
            p.license                         AS license,
            TRY_CAST(p.observer_id AS BIGINT) AS observer_id,
            p.observation_uuid                AS observation_uuid,
            CAST(o.taxon_id AS BIGINT)        AS inat_taxon_id,
            t.app_idx                         AS app_idx,
            t.scientific                      AS scientific,
            t.common                          AS common,
            CAST(o.latitude  AS DOUBLE)       AS latitude,
            CAST(o.longitude AS DOUBLE)       AS longitude,
            o.observed_on                     AS observed_on
        FROM {rd.format(photos_csv)} p
        JOIN {rd.format(obs_csv)} o USING (observation_uuid)
        JOIN taxa t ON CAST(o.taxon_id AS BIGINT) = t.inat_taxon_id
        WHERE o.quality_grade = 'research'
          AND p.license IN ('CC0','CC-BY','CC-BY-NC')
          {gps}
          AND CAST(p.photo_id AS BIGINT) NOT IN (SELECT photo_id FROM train)
          AND p.observation_uuid NOT IN (SELECT observation_uuid FROM train)
    """)
    n_cand = con.execute("SELECT count(*) FROM candidates").fetchone()[0]
    log(f"  {n_cand:,} untouched candidate photos "
        f"(no trained photo_id, no trained observation)")

    # one photo per observation, then cap per species -- keeps the held-out set
    # itself free of within-set near-duplicates too
    log(f"sampling <= {a.per_species}/species, one photo per observation...")
    con.execute(f"""
        CREATE TEMP TABLE picked AS
        WITH one_per_obs AS (
            SELECT *, row_number() OVER (PARTITION BY observation_uuid
                                         ORDER BY photo_id) AS rn_obs
            FROM candidates
        ), capped AS (
            SELECT *, row_number() OVER (PARTITION BY inat_taxon_id
                                         ORDER BY hash(photo_id)) AS rn_sp
            FROM one_per_obs WHERE rn_obs = 1
        )
        SELECT * EXCLUDE (rn_obs, rn_sp) FROM capped WHERE rn_sp <= {a.per_species}
    """)

    con.execute(f"""
        CREATE TEMP TABLE final AS
        SELECT * FROM picked
        WHERE inat_taxon_id IN (
            SELECT inat_taxon_id FROM picked
            GROUP BY 1 HAVING count(*) >= {a.min_per_species}
        )
    """)
    n_fin, n_sp_fin, n_obs_fin = con.execute(
        "SELECT count(*), count(DISTINCT inat_taxon_id), "
        "count(DISTINCT observation_uuid) FROM final").fetchone()
    log(f"  {n_fin:,} photos / {n_sp_fin:,} species / {n_obs_fin:,} observations")
    dropped = n_sp - n_sp_fin
    if dropped:
        log(f"  {dropped:,} species dropped (< {a.min_per_species} untouched photos) "
            f"-- expected: rare species were scarcity-capped, not cap-capped")

    con.execute(f"COPY final TO '{a.out}' (FORMAT PARQUET)")
    log(f"wrote {a.out}")

    # paranoia: prove the leakage rules actually held
    leak_p = con.execute(
        "SELECT count(*) FROM final WHERE photo_id IN (SELECT photo_id FROM train)"
    ).fetchone()[0]
    leak_o = con.execute(
        "SELECT count(*) FROM final WHERE observation_uuid IN "
        "(SELECT observation_uuid FROM train)").fetchone()[0]
    log(f"VERIFY leaked photo_ids={leak_p} leaked observations={leak_o} (both want 0)")
    if leak_p or leak_o:
        raise SystemExit("LEAKAGE DETECTED -- do not use this split")


if __name__ == "__main__":
    main()
