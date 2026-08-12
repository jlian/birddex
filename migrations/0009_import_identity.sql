CREATE TABLE importIdentity (
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  sourceKey TEXT NOT NULL,
  rowCount INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (userId, source, sourceKey)
);

INSERT OR IGNORE INTO importIdentity (userId, source, sourceKey)
SELECT DISTINCT userId, 'submission', trim(submissionId)
FROM observation
WHERE submissionId IS NOT NULL AND trim(submissionId) <> '';
