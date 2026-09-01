import { getWikiMetadata } from './taxonomy'

export type DexRow = {
  id: string
  speciesName: string
  /**
   * eBird species code, or null for a taxon the resolver could not place.
   * The grouping key when present; speciesName is the fallback.
   */
  speciesCode?: string | null
  firstSeenDate: string
  lastSeenDate: string
  addedDate?: string | null
  totalOutings: number
  totalCount: number
  bestPhotoId?: string | null
  notes: string
}

// Group by the eBird species code when the row has one, and fall back to the
// display name when it does not.
//
// WHY A CASE RATHER THAN A PLAIN GROUP BY speciesCode
// ----------------------------------------------------
// The code cannot be total. eBird exports carry spuh ("Gull sp."), slash,
// hybrid and domestic taxa that the classifier deliberately excludes, and
// parseEBirdCSV stores whatever the CSV said. Grouping those rows by a NULL
// code would collapse every unresolvable species in a user's dex into one
// entry, which is far worse than the split this change exists to prevent.
//
// The prefix keeps the two key spaces from colliding: without it a species
// whose display name happened to equal another species' code would merge. They
// are different namespaces, so they are kept apart explicitly.
//
// WHY METADATA IS AGGREGATED SEPARATELY INSTEAD OF JOINED DIRECTLY
// ----------------------------------------------------------------
// dex_meta is still PRIMARY KEY (userId, speciesName), so ONE species code can
// legitimately have several metadata rows: exactly the duplicate-spelling case
// this change exists to consolidate. Joining dex_meta to observation before
// aggregating multiplies every observation row by the number of matching
// metadata rows, so SUM(obs.count) silently doubles. Measured: a species with
// one observation of count 5 and two metadata rows reported 10.
//
// Aggregating observations and metadata into separate CTEs and joining one row
// to one row makes the fan-out impossible.
//
// MIN(speciesName) picks the display string. Rows sharing a code are the same
// bird spelled differently, which is the exact case this change fixes, so any
// of them is correct; MIN just makes it deterministic.
export const DEX_QUERY = `
  WITH grouped AS (
    SELECT
      CASE
        WHEN obs.speciesCode IS NOT NULL THEN 'code:' || obs.speciesCode
        ELSE 'name:' || obs.speciesName
      END AS groupKey,
      MIN(obs.speciesName) AS speciesName,
      obs.speciesCode AS speciesCode,
      MIN(o.startTime) AS firstSeenDate,
      MAX(o.startTime) AS lastSeenDate,
      COUNT(DISTINCT obs.outingId) AS totalOutings,
      SUM(obs.count) AS totalCount
    FROM observation obs
    JOIN outing o ON obs.outingId = o.id
    WHERE obs.userId = ?1 AND obs.certainty IN ('confirmed', 'possible')
    GROUP BY groupKey
  ),
  -- Metadata that already carries a code. Name-keyed rows are handled by
  -- metaByName below; including them here too would attach one note to two
  -- groups when the same name exists both coded and uncoded, which is a normal
  -- state mid-rollout.
  meta AS (
    SELECT
      'code:' || dm.speciesCode AS groupKey,
      MIN(dm.addedDate) AS addedDate,
      MIN(dm.bestPhotoId) AS bestPhotoId,
      COALESCE(MIN(NULLIF(dm.notes, '')), '') AS notes
    FROM dex_meta dm
    WHERE dm.userId = ?1 AND dm.speciesCode IS NOT NULL
    GROUP BY groupKey
  ),
  -- Metadata saved BEFORE this migration, or by a writer that has not been
  -- updated yet, carries a NULL speciesCode and is keyed by name. Resolve it
  -- to the same group through an observation that shares its name, so a note
  -- written by the old path is not lost the moment the observation gains a
  -- code.
  --
  -- The join has to go through EVERY observation name in the group, not the
  -- single MIN(speciesName) the group displays. Metadata saved under a
  -- non-minimum alias would otherwise stay orphaned, which is precisely the
  -- duplicate-spelling case this change consolidates.
  --
  -- A name is bound to at most one group here: coded observations win, so a
  -- name that appears both coded and uncoded resolves to its coded group
  -- rather than attaching one note to two dex entries.
  nameToGroup AS (
    SELECT
      obs.speciesName AS speciesName,
      MIN(CASE
        WHEN obs.speciesCode IS NOT NULL THEN 'code:' || obs.speciesCode
        ELSE 'name:' || obs.speciesName
      END) AS groupKey
    FROM observation obs
    WHERE obs.userId = ?1 AND obs.certainty IN ('confirmed', 'possible')
    GROUP BY obs.speciesName
  ),
  metaByName AS (
    SELECT
      -- Prefer the group an observation with this exact name belongs to, which
      -- routes a legacy note onto the coded entry. Fall back to the plain name
      -- key so metadata for a species with no matching observation is not
      -- silently dropped.
      COALESCE(n.groupKey, 'name:' || dm.speciesName) AS groupKey,
      MIN(dm.addedDate) AS addedDate,
      MIN(dm.bestPhotoId) AS bestPhotoId,
      COALESCE(MIN(NULLIF(dm.notes, '')), '') AS notes
    FROM dex_meta dm
    LEFT JOIN nameToGroup n ON n.speciesName = dm.speciesName
    WHERE dm.userId = ?1 AND dm.speciesCode IS NULL
    GROUP BY COALESCE(n.groupKey, 'name:' || dm.speciesName)
  )
  SELECT
    g.groupKey AS id,
    g.speciesName AS speciesName,
    g.speciesCode AS speciesCode,
    g.firstSeenDate AS firstSeenDate,
    g.lastSeenDate AS lastSeenDate,
    COALESCE(m.addedDate, n.addedDate) AS addedDate,
    g.totalOutings AS totalOutings,
    g.totalCount AS totalCount,
    COALESCE(m.bestPhotoId, n.bestPhotoId) AS bestPhotoId,
    COALESCE(NULLIF(m.notes, ''), n.notes, '') AS notes
  FROM grouped g
  LEFT JOIN meta m ON m.groupKey = g.groupKey
  LEFT JOIN metaByName n ON n.groupKey = g.groupKey
  ORDER BY g.speciesName
`

/** D1-compatible database handle (only the subset we use). */
export interface DexQueryDB {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      all<T>(): Promise<{ results: T[] }>
    }
  }
}

export async function computeDex(db: DexQueryDB, userId: string): Promise<DexRow[]> {
  const result = await db.prepare(DEX_QUERY).bind(userId).all<DexRow>()
  return result.results
}

export function enrichDexEntries(rows: DexRow[]) {
  return rows.map(row => {
    const { wikiTitle, thumbnailUrl } = getWikiMetadata(row.speciesName)
    return {
      ...row,
      addedDate: row.addedDate || undefined,
      bestPhotoId: row.bestPhotoId || undefined,
      wikiTitle,
      thumbnailUrl,
    }
  })
}
