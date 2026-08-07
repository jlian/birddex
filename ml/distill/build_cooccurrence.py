#!/usr/bin/env python3
"""Build a species co-occurrence table from the corpus GPS (training signal).

Used for hard-example weighting during distillation: species that are both
visually confusable AND geographically co-occurring are the ones inference-time
range priors CANNOT separate, so the student must learn to tell them apart. This
script produces the "which species share locations" half of that signal (the
visual-confusability half comes from teacher-embedding similarity at train time).

Method: bin every GPS'd corpus photo into an Equal-Earth-ish grid cell (default
~27km, matching WingDex's range grid), then count, for each species pair, how
many grid cells they share. Emits:

  cooccurrence.parquet   species_a, species_b, shared_cells, jaccard
  species_cells.parquet  inat_taxon_id, cell_count, obs_count  (per-species range breadth)

~99.8% of corpus photos have GPS (verified 2026-07-21), so this is well-grounded.
Observation-based (where birds are actually photographed), not modeled polygons.

Runs in minutes; NOT on the critical path (only needed before the optional
hard-example-weighting experiment). Uses corpus GPS only (no R2 download).

Usage:
  python build_cooccurrence.py --manifest manifest.parquet --out . --cell-km 27 \
      --min-shared 2
"""
import argparse
import math
import os

import duckdb


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--cell-km", type=float, default=27.0, help="grid cell size in km")
    ap.add_argument("--min-shared", type=int, default=2,
                    help="min shared cells to record a pair (drop 1-off noise)")
    ap.add_argument("--threads", type=int, default=0)
    args = ap.parse_args()

    # deg-per-cell: ~111 km per degree latitude. Simple equirectangular binning is
    # fine for co-occurrence (we only need 'same neighborhood', not exact area).
    deg = args.cell_km / 111.0

    con = duckdb.connect()
    if args.threads:
        con.execute(f"PRAGMA threads={args.threads}")
    M = f"read_parquet('{args.manifest}')"
    os.makedirs(args.out, exist_ok=True)

    # grid cell id per photo (only GPS'd rows)
    con.execute(f"""
        CREATE OR REPLACE TABLE cells AS
        SELECT DISTINCT inat_taxon_id,
               CAST(floor(latitude / {deg}) AS BIGINT) AS gy,
               CAST(floor(longitude / {deg}) AS BIGINT) AS gx
        FROM {M}
        WHERE latitude IS NOT NULL AND longitude IS NOT NULL
    """)

    # per-species range breadth
    obs = con.execute(f"""
        SELECT count(*) FROM {M} WHERE latitude IS NOT NULL
    """).fetchone()[0]
    con.execute(f"""
        COPY (
          SELECT c.inat_taxon_id, count(*) AS cell_count,
                 (SELECT count(*) FROM {M} m
                  WHERE m.inat_taxon_id = c.inat_taxon_id AND m.latitude IS NOT NULL) AS obs_count
          FROM cells c GROUP BY c.inat_taxon_id ORDER BY cell_count DESC
        ) TO '{os.path.join(args.out, "species_cells.parquet")}' (FORMAT parquet)
    """)

    # pair co-occurrence: self-join cells on (gx,gy), count shared cells per pair.
    # a<b to avoid dupes/self-pairs. jaccard = shared / (cells_a + cells_b - shared).
    con.execute(f"""
        CREATE OR REPLACE TABLE pair_shared AS
        SELECT a.inat_taxon_id AS species_a, b.inat_taxon_id AS species_b,
               count(*) AS shared_cells
        FROM cells a JOIN cells b
          ON a.gx = b.gx AND a.gy = b.gy AND a.inat_taxon_id < b.inat_taxon_id
        GROUP BY 1, 2
        HAVING count(*) >= {args.min_shared}
    """)
    con.execute(f"""
        CREATE OR REPLACE TABLE sp_cells AS
        SELECT inat_taxon_id, count(*) AS n FROM cells GROUP BY 1
    """)
    con.execute(f"""
        COPY (
          SELECT p.species_a, p.species_b, p.shared_cells,
                 p.shared_cells * 1.0 /
                   (ca.n + cb.n - p.shared_cells) AS jaccard
          FROM pair_shared p
          JOIN sp_cells ca ON p.species_a = ca.inat_taxon_id
          JOIN sp_cells cb ON p.species_b = cb.inat_taxon_id
          ORDER BY jaccard DESC
        ) TO '{os.path.join(args.out, "cooccurrence.parquet")}' (FORMAT parquet)
    """)

    npairs = con.execute(
        f"SELECT count(*) FROM read_parquet('{os.path.join(args.out, 'cooccurrence.parquet')}')"
    ).fetchone()[0]
    nsp = con.execute("SELECT count(*) FROM sp_cells").fetchone()[0]
    print(f"gps observations binned: {obs:,}", flush=True)
    print(f"species with cells: {nsp}", flush=True)
    print(f"co-occurring pairs (>= {args.min_shared} shared cells): {npairs:,}", flush=True)
    print(f"-> {os.path.join(args.out, 'cooccurrence.parquet')}", flush=True)
    print(f"-> {os.path.join(args.out, 'species_cells.parquet')}", flush=True)


if __name__ == "__main__":
    main()
