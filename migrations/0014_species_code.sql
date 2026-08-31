-- Key observations by eBird species code instead of the display name (#306).
--
-- observation.speciesName is free text, and everything downstream groups on
-- that string: dex-query.ts GROUPs BY it, dex_meta is PRIMARY KEY (userId,
-- speciesName), OutingsPage groups by it, and the iOS DataStore keeps its
-- indexes on it. A species is therefore whatever string got written at the
-- time, by whichever client wrote it.
--
-- That already caused one duplicate-dex bug (fixed in da386a71 by making both
-- clients write the canonical form). The durable risk is version skew: iOS
-- writes speciesName locally from its OWN bundled taxonomy, so a phone on last
-- month's build can spell a bird differently from the server and silently split
-- someone's dex.
--
-- WHY THE COLUMN IS NULLABLE
-- --------------------------
-- The code cannot be total. eBird exports contain taxa our classifier
-- deliberately excludes -- spuh ("Gull sp."), slash, hybrid, domestic forms --
-- plus, since the extinct-taxa change, species we removed outright. The
-- display sidecar (src/lib/taxonomy-extra.json) resolves most of those, but a
-- name that matches nothing must still be storable. Rows with a NULL code keep
-- grouping by speciesName, which is exactly today's behaviour for exactly the
-- rows that have it today.
--
-- WHY THERE IS NO BACKFILL IN THIS FILE
-- -------------------------------------
-- Resolving a name to a code needs the taxonomy and the sidecar, which are
-- TypeScript modules with a matching chain (scientific name, then binomial
-- fallback, then common name). That is not expressible in SQLite, and encoding
-- an 11k-row lookup as a giant CASE would be both unreadable and immediately
-- stale. The backfill runs as a script against the same resolveSpeciesCode the
-- import path uses, so there is one implementation of the rule.
--
-- Nothing reads speciesCode yet. This migration is additive and reversible in
-- effect: dropping the column returns the schema to its previous behaviour.

ALTER TABLE observation ADD COLUMN speciesCode TEXT;

-- Grouping key for dex-query once it moves onto the code. userId leads because
-- every query is scoped to a user first, matching idx_observation_species.
CREATE INDEX idx_observation_speciesCode ON observation(userId, speciesCode);

ALTER TABLE dex_meta ADD COLUMN speciesCode TEXT;

CREATE INDEX idx_dex_meta_speciesCode ON dex_meta(userId, speciesCode);
