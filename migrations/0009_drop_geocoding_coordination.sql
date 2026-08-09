-- Contract phase of the Geoapify expand/contract rollout.
--
-- Migration 0008 was intentionally a no-op so the still-live previous Worker,
-- which queries the geocoding tables on every request, kept working while D1
-- migrations were applied ahead of the replacement Worker deploy. By the time
-- this migration runs (the next release after the Geoapify Worker is live), no
-- Worker references these tables, so dropping them removes the stale cached
-- provider responses that would otherwise linger indefinitely and contradict
-- the privacy disclosure that WingDex retains no provider-response cache.
DROP TABLE IF EXISTS geocoding_inflight;
DROP TABLE IF EXISTS geocoding_rate_limit;
DROP INDEX IF EXISTS geocoding_cache_expiresAt_idx;
DROP TABLE IF EXISTS geocoding_cache;
