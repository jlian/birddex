-- Index the two ON DELETE SET NULL foreign keys.
--
-- photo(id) is referenced by observation.representativePhotoId and
-- dex_meta.bestPhotoId, both ON DELETE SET NULL. Neither column was indexed, so
-- deleting one photo forced SQLite to scan all of observation (and all of
-- dex_meta) to find rows pointing at it. Deleting an outing cascades to its
-- photos, so the scans multiply: one delete per photo, one full table scan each.
--
-- Measured on wingdex-db-dev before this migration:
--   DELETE FROM outing WHERE id=? AND userId=?   15,592 rows read per call
--   DELETE FROM "user" WHERE id=?                13,497 rows read per call
--   PRAGMA foreign_key_check                     54,400 rows read per call
--
-- Deleting a single outing should read single-digit rows. The account-deletion
-- and demo-data clear testing on 2026-08-09 drove ~1M reads in one hour on the
-- free tier's 5M/day budget, which is what triggered Cloudflare's enforcement
-- notice ahead of 2026-09-01.
--
-- The ON DELETE CASCADE foreign keys are already covered (idx_photo_outingId,
-- idx_observation_outingId, and the per-table userId indexes), so only these two
-- SET NULL columns were left doing full scans.

CREATE INDEX IF NOT EXISTS idx_observation_representativePhotoId
  ON observation(representativePhotoId);

CREATE INDEX IF NOT EXISTS idx_dex_meta_bestPhotoId
  ON dex_meta(bestPhotoId);
