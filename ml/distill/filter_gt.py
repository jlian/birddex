"""T2: filter the ground-truth split down to species the distillation actually saw.

The sampler never intersected with train_manifest, so it pulled in 2,058 species
that FAILED the corpus's >=50-photo floor (median 24 photos worldwide). Those
classes cannot be learned from 5-49 examples and dilute the classifier.

Pure subset op on the existing parquet -- no need to re-run the 25-min 19GB join,
and the images are already on disk.
"""
import duckdb

D = "/home/jlian/wingdex/ml/distill"
con = duckdb.connect()
con.execute("PRAGMA memory_limit='8GB'")

before = con.execute(
    f"SELECT count(*), count(DISTINCT inat_taxon_id) FROM read_parquet('{D}/groundtruth_heldout.parquet')").fetchone()
print(f"before: {before[0]:,} photos / {before[1]:,} species")

con.execute(f"""
    CREATE TEMP TABLE clean AS
    SELECT * FROM read_parquet('{D}/groundtruth_heldout.parquet')
    WHERE inat_taxon_id IN (
        SELECT DISTINCT inat_taxon_id FROM read_parquet('{D}/train_manifest.parquet'))
""")
after = con.execute(
    "SELECT count(*), count(DISTINCT inat_taxon_id) FROM clean").fetchone()
print(f"after : {after[0]:,} photos / {after[1]:,} species")
print(f"dropped: {before[0]-after[0]:,} photos / {before[1]-after[1]:,} species")

con.execute(f"COPY clean TO '{D}/groundtruth_heldout_distilled.parquet' (FORMAT PARQUET)")
print(f"wrote {D}/groundtruth_heldout_distilled.parquet")

# sanity: every remaining species must be in the manifest
leak = con.execute(f"""
    SELECT count(*) FROM clean WHERE inat_taxon_id NOT IN
    (SELECT DISTINCT inat_taxon_id FROM read_parquet('{D}/train_manifest.parquet'))
""").fetchone()[0]
print(f"VERIFY undistilled species remaining: {leak} (want 0)")
