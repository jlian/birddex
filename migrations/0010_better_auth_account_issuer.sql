-- Better Auth 1.7 identifies OAuth accounts by (issuer, accountId).
-- Backfill only the providers WingDex configures; an unknown provider produces
-- NULL and aborts the NOT NULL copy rather than guessing an identity authority.
CREATE TABLE account_new (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  issuer TEXT NOT NULL,
  accessToken TEXT,
  refreshToken TEXT,
  accessTokenExpiresAt TEXT,
  refreshTokenExpiresAt TEXT,
  scope TEXT,
  idToken TEXT,
  password TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO account_new (
  id, userId, accountId, providerId, issuer,
  accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt,
  scope, idToken, password, createdAt, updatedAt
)
SELECT
  id, userId, accountId, providerId,
  CASE providerId
    WHEN 'apple' THEN 'https://appleid.apple.com'
    WHEN 'google' THEN 'https://accounts.google.com'
    WHEN 'github' THEN 'local:oauth:github'
    WHEN 'credential' THEN 'local:credential'
  END,
  accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt,
  scope, idToken, password, createdAt, updatedAt
FROM account;

DROP TABLE account;
ALTER TABLE account_new RENAME TO account;

CREATE INDEX idx_account_userId ON account(userId);
CREATE UNIQUE INDEX account_issuer_accountId_uidx ON account(issuer, accountId);
