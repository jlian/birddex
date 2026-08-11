ALTER TABLE outing ADD COLUMN submissionId TEXT;

-- Provenance for imported checklists. eBird submission ids are globally unique
-- and stable, so this doubles as the dedupe key for re-importing an export.
--
-- Demo checklists use the reserved WINGDEX-DEMO- prefix rather than an
-- eBird-shaped id. eBird ids always start with S followed by digits, so the
-- prefix cannot collide with a real record no matter how large eBird gets.
CREATE INDEX IF NOT EXISTS idx_outing_user_submission ON outing(userId, submissionId);
