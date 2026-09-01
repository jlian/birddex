-- Preserve the exact eBird taxon independently from the REPORT_AS code used
-- to group dex entries. Existing rows used speciesCode for both concepts, so
-- initialize taxonCode from it as a compatibility baseline.
ALTER TABLE observation ADD COLUMN taxonCode TEXT;

UPDATE observation SET taxonCode = speciesCode WHERE speciesCode IS NOT NULL;

CREATE INDEX idx_observation_taxonCode ON observation(userId, taxonCode);