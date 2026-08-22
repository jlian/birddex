DROP TABLE IF EXISTS mobile_social_intent;

CREATE TABLE account_merge_intent (
  tokenHash TEXT PRIMARY KEY,
  sourceUserId TEXT NOT NULL,
  sourceSessionId TEXT NOT NULL,
  authMethod TEXT NOT NULL
    CHECK(authMethod IN ('github', 'google', 'apple', 'passkey')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'merging', 'completed', 'failed')),
  targetUserId TEXT,
  outingCount INTEGER NOT NULL DEFAULT 0,
  observationCount INTEGER NOT NULL DEFAULT 0,
  photoCount INTEGER NOT NULL DEFAULT 0,
  completionGuard INTEGER NOT NULL DEFAULT 1 CHECK(completionGuard = 1),
  expiresAt TEXT NOT NULL,
  completedAt TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_account_merge_intent_source
ON account_merge_intent(sourceUserId, status);

CREATE UNIQUE INDEX idx_account_merge_intent_pending_session
ON account_merge_intent(sourceSessionId)
WHERE status = 'pending';

CREATE INDEX idx_account_merge_intent_expiresAt
ON account_merge_intent(expiresAt);