CREATE TABLE apple_native_revocation_credential (
  authAccountId TEXT PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  accessToken TEXT NOT NULL,
  refreshToken TEXT NOT NULL,
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);