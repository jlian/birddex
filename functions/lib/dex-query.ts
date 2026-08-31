import { getWikiMetadata } from './taxonomy'

export type DexRow = {
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
// WHY A COALESCE RATHER THAN A PLAIN GROUP BY speciesCode
// -------------------------------------------------------
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
// MIN(speciesName) picks the display string. Rows sharing a code are the same
// bird spelled differently, which is the exact case this change fixes, so any
// of them is correct; MIN just makes it deterministic.
export const DEX_QUERY = `
  SELECT
    MIN(obs.speciesName) AS speciesName,
    obs.speciesCode AS speciesCode,
    MIN(o.startTime) AS firstSeenDate,
    MAX(o.startTime) AS lastSeenDate,
    MIN(dm.addedDate) AS addedDate,
    COUNT(DISTINCT obs.outingId) AS totalOutings,
    SUM(obs.count) AS totalCount,
    MIN(dm.bestPhotoId) AS bestPhotoId,
    COALESCE(MIN(dm.notes), '') AS notes
  FROM observation obs
  JOIN outing o ON obs.outingId = o.id
  LEFT JOIN dex_meta dm
    ON dm.userId = obs.userId
   AND (
     (obs.speciesCode IS NOT NULL AND dm.speciesCode = obs.speciesCode)
     OR (obs.speciesCode IS NULL AND dm.speciesName = obs.speciesName)
   )
  WHERE obs.userId = ?1 AND obs.certainty IN ('confirmed', 'possible')
  GROUP BY CASE
    WHEN obs.speciesCode IS NOT NULL THEN 'code:' || obs.speciesCode
    ELSE 'name:' || obs.speciesName
  END
  ORDER BY speciesName
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
