"""Count the untouched iNat reservoir per distilled species.

Answers: for each of the 7,555 distilled species, how many photos remain that
NEITHER the distillation NOR the existing ground-truth set has used? Applies
the same filters build_groundtruth_split.py applies, so the counts are what a
real fresh draw would yield:
  - research grade, CC0/CC-BY/CC-BY-NC, GPS present
  - photo_id not in either manifest
  - observation_uuid not in either manifest (near-duplicate rule)
  - one photo per observation

Read-only. Writes nothing.
"""
import os
import duckdb

META = "/home/jlian/wingdex/ml/inat-metadata"
TRAIN = "train_manifest.parquet"
GT = "groundtruth_heldout_distilled.parquet"
TAXA = "target_taxa.csv"

con = duckdb.connect()
# Keep well clear of the running eval: cap memory and threads.
con.execute("SET memory_limit='8GB'")
con.execute("SET threads=4")
con.execute("SET preserve_insertion_order=false")

photos = os.path.join(META, "photos.csv.gz")
obs = os.path.join(META, "observations.csv.gz")
rd = "read_csv('{}', header=true, all_varchar=true)"

print("building exclusion set (train + existing ground truth)...", flush=True)
con.execute("""
    CREATE TEMP TABLE excl AS
    SELECT DISTINCT CAST(photo_id AS BIGINT) AS photo_id,
           observation_uuid
    FROM read_parquet('""" + TRAIN + """')
    UNION
    SELECT DISTINCT CAST(photo_id AS BIGINT), observation_uuid
    FROM read_parquet('""" + GT + """')
""")
n_ex = con.execute("SELECT count(*) FROM excl").fetchone()[0]
print("  %s photos excluded" % format(n_ex, ","), flush=True)

print("restricting to DISTILLED species...", flush=True)
con.execute("""
    CREATE TEMP TABLE taxa AS
    SELECT DISTINCT CAST(inat_taxon_id AS BIGINT) AS inat_taxon_id
    FROM read_csv('""" + TAXA + """', header=true, all_varchar=true)
    WHERE inat_taxon_id IS NOT NULL
      AND CAST(inat_taxon_id AS BIGINT) IN (
        SELECT DISTINCT inat_taxon_id FROM read_parquet('""" + TRAIN + """'))
""")
n_sp = con.execute("SELECT count(*) FROM taxa").fetchone()[0]
print("  %s distilled species" % format(n_sp, ","), flush=True)

print("scanning 30GB metadata (slow part, several minutes)...", flush=True)
con.execute("""
    CREATE TEMP TABLE avail AS
    WITH cand AS (
        SELECT CAST(o.taxon_id AS BIGINT) AS sp,
               p.observation_uuid AS obs,
               row_number() OVER (PARTITION BY p.observation_uuid) AS rn
        FROM """ + rd.format(photos) + """ p
        JOIN """ + rd.format(obs) + """ o USING (observation_uuid)
        JOIN taxa t ON CAST(o.taxon_id AS BIGINT) = t.inat_taxon_id
        WHERE o.quality_grade = 'research'
          AND p.license IN ('CC0','CC-BY','CC-BY-NC')
          AND o.latitude IS NOT NULL AND o.longitude IS NOT NULL
          AND CAST(p.photo_id AS BIGINT) NOT IN (SELECT photo_id FROM excl)
          AND p.observation_uuid NOT IN (SELECT observation_uuid FROM excl)
    )
    SELECT sp, count(*) AS n FROM cand WHERE rn = 1 GROUP BY sp
""")

tot = con.execute("SELECT count(*), sum(n) FROM avail").fetchone()
print("")
print("species with ANY untouched photo: %s" % format(tot[0], ","))
print("total untouched photos:           %s" % format(tot[1] or 0, ","))
print("")
print("threshold   species   photos at that cap")
for thr in (5, 10, 20, 40, 100):
    r = con.execute(
        "SELECT count(*), sum(least(n, %d)) FROM avail WHERE n >= %d" % (thr, thr)
    ).fetchone()
    print("  >=%-6d  %6s   %10s" % (thr, format(r[0], ","), format(r[1] or 0, ",")))

print("")
print("species with NO untouched photo: %s" % format(n_sp - tot[0], ","))
