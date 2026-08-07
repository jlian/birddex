CREATE TABLE geocoding_cache (
  cacheKey TEXT PRIMARY KEY,
  response TEXT NOT NULL,
  expiresAt INTEGER NOT NULL
);

CREATE INDEX geocoding_cache_expiresAt_idx ON geocoding_cache(expiresAt);

CREATE TABLE geocoding_inflight (
  cacheKey TEXT PRIMARY KEY,
  ownerId TEXT NOT NULL,
  expiresAt INTEGER NOT NULL
);

CREATE TABLE geocoding_rate_limit (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  nextAllowedAt INTEGER NOT NULL
);

INSERT INTO geocoding_rate_limit (id, nextAllowedAt) VALUES (1, 0);