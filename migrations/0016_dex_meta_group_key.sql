-- Metadata belongs to a dex group, not its display label. A coded and uncoded
-- group can legitimately share one label, so (userId, speciesName) cannot
-- identify both. Rebuild the table around the same prefixed key DEX_QUERY uses.
CREATE TABLE dex_meta_grouped (
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  groupKey TEXT NOT NULL,
  speciesName TEXT NOT NULL,
  speciesCode TEXT,
  addedDate TEXT,
  bestPhotoId TEXT REFERENCES photo(id) ON DELETE SET NULL,
  notes TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (userId, groupKey)
);

WITH keyed AS (
  SELECT
    dm.*,
    CASE
      WHEN dm.speciesCode IS NOT NULL THEN 'code:' || dm.speciesCode
      ELSE COALESCE(
        (
          SELECT 'code:' || obs.speciesCode
          FROM observation obs
          WHERE obs.userId = dm.userId
            AND obs.speciesName = dm.speciesName
            AND obs.speciesCode IS NOT NULL
          LIMIT 1
        ),
        'name:' || dm.speciesName
      )
    END AS resolvedGroupKey
  FROM dex_meta dm
)
INSERT INTO dex_meta_grouped (
  userId, groupKey, speciesName, speciesCode, addedDate, bestPhotoId, notes
)
SELECT
  userId,
  resolvedGroupKey,
  MIN(speciesName),
  CASE WHEN resolvedGroupKey LIKE 'code:%' THEN substr(resolvedGroupKey, 6) END,
  MIN(addedDate),
  MIN(bestPhotoId),
  COALESCE(GROUP_CONCAT(NULLIF(notes, ''), char(10) || char(10)), '')
FROM keyed
GROUP BY userId, resolvedGroupKey;

DROP TABLE dex_meta;
ALTER TABLE dex_meta_grouped RENAME TO dex_meta;

CREATE INDEX idx_dex_meta_userId ON dex_meta(userId);
CREATE INDEX idx_dex_meta_bestPhotoId ON dex_meta(bestPhotoId);
CREATE INDEX idx_dex_meta_speciesCode ON dex_meta(userId, speciesCode);