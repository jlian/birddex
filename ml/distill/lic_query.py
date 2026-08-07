import duckdb
con = duckdb.connect()
M = "read_parquet('manifest.parquet')"
tot = con.execute(f"SELECT count(*) FROM {M}").fetchone()[0]
nsp = con.execute(f"SELECT count(DISTINCT inat_taxon_id) FROM {M}").fetchone()[0]
print(f"FULL manifest: {tot:,} images, {nsp} species")
print("license breakdown:")
for lic, ct in con.execute(f"SELECT license, count(*) c FROM {M} GROUP BY 1 ORDER BY c DESC").fetchall():
    print(f"  {lic:12s} {ct:>9,} ({100*ct/tot:.2f}%)")

sa = con.execute(f"SELECT count(*) FROM {M} WHERE license='CC-BY-SA'").fetchone()[0]
sp_sa = con.execute(f"SELECT count(DISTINCT inat_taxon_id) FROM {M} WHERE license='CC-BY-SA'").fetchone()[0]
lost = con.execute(f"""
  WITH after AS (SELECT inat_taxon_id, count(*) c FROM {M} WHERE license<>'CC-BY-SA' GROUP BY 1)
  SELECT count(*) FROM (SELECT DISTINCT inat_taxon_id FROM {M}) all_sp
  LEFT JOIN after USING(inat_taxon_id)
  WHERE COALESCE(after.c,0) < 50
""").fetchone()[0]
print("--- if we DROP CC-BY-SA only ---")
print(f"  CC-BY-SA: {sa:,} imgs ({100*sa/tot:.2f}%), touches {sp_sa} species")
print(f"  species dropping below floor=50 if SA removed: {lost}")

# also: pure copyleft-safe set (CC0 + CC-BY only, the strictest MIT-clean option)
strict = con.execute(f"SELECT count(*) FROM {M} WHERE license IN ('CC0','CC-BY')").fetchone()[0]
print(f"--- strict CC0+CC-BY only: {strict:,} imgs ({100*strict/tot:.2f}%) ---")
