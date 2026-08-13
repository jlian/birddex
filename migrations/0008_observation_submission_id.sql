ALTER TABLE observation ADD COLUMN submissionId TEXT;

-- Provenance for imported checklists. eBird submission ids are globally unique
-- and stable, so this doubles as the dedupe key for re-importing an export.
--
-- It belongs on the observation, not the outing: one eBird row is exactly one
-- (checklist, species) pair, while an outing may merge several checklists from
-- the same place and day. A single column on outing can record only one of
-- them, which is what made re-imports create duplicate outings.
--
-- Demo checklists use the reserved WINGDEX-DEMO- prefix rather than an
-- eBird-shaped id. eBird ids always start with S followed by digits, so the
-- prefix cannot collide with a real record no matter how large eBird gets.
CREATE INDEX IF NOT EXISTS idx_observation_user_submission ON observation(userId, submissionId);
