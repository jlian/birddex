-- Preserve the exact eBird taxon independently from the REPORT_AS code used
-- to group dex entries. Existing rows used speciesCode for both concepts, so
-- Leave historical rows NULL until the taxonomy backfill resolves their exact
-- identity. speciesCode may be a REPORT_AS parent and is not safe to copy.
ALTER TABLE observation ADD COLUMN taxonCode TEXT;

CREATE INDEX idx_observation_taxonCode ON observation(userId, taxonCode);