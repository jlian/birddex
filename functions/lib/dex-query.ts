import { findCompoundTaxon, getTaxonMetadata } from './taxonomy'

export type DexRow = {
  id: string
  speciesName: string
  /**
   * eBird species code, or null for a taxon the resolver could not place.
   * The grouping key when present; speciesName is the fallback.
   */
  speciesCode?: string | null
  taxonCode?: string | null
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
// dex_meta uses this same prefixed group key as its primary identity. That lets
// coded and uncoded groups with the same display label keep separate notes and
// guarantees the metadata join cannot multiply observation counts.
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
      json_extract(MIN(json_array(obs.speciesName, obs.taxonCode)), '$[1]') AS taxonCode,
      MIN(o.startTime) AS firstSeenDate,
      MAX(o.startTime) AS lastSeenDate,
      COUNT(DISTINCT obs.outingId) AS totalOutings,
      SUM(obs.count) AS totalCount
    FROM observation obs
    JOIN outing o ON obs.outingId = o.id
    WHERE obs.userId = ?1 AND obs.certainty IN ('confirmed', 'possible')
    GROUP BY groupKey
  ),
  meta AS (
    SELECT
      dm.groupKey AS groupKey,
      dm.addedDate AS addedDate,
      dm.bestPhotoId AS bestPhotoId,
      dm.notes AS notes
    FROM dex_meta dm
    WHERE dm.userId = ?1
  )
  SELECT
    g.groupKey AS id,
    g.speciesName AS speciesName,
    g.speciesCode AS speciesCode,
    g.taxonCode AS taxonCode,
    g.firstSeenDate AS firstSeenDate,
    g.lastSeenDate AS lastSeenDate,
    m.addedDate AS addedDate,
    g.totalOutings AS totalOutings,
    g.totalCount AS totalCount,
    m.bestPhotoId AS bestPhotoId,
    COALESCE(m.notes, '') AS notes
  FROM grouped g
  LEFT JOIN meta m ON m.groupKey = g.groupKey
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
    const metadata = getTaxonMetadata(row.speciesName, row.taxonCode)
    const compound = findCompoundTaxon(row.speciesName)
    const parents = compound?.parents.map(parent => ({
      commonName: parent.common,
      scientificName: parent.scientific,
      speciesCode: parent.ebirdCode,
      wikiTitle: parent.wikiTitle,
      thumbnailUrl: parent.thumbnailPath
        ? `https://upload.wikimedia.org/wikipedia/commons/${parent.thumbnailPath}`
        : undefined,
      birdlifeId: parent.birdlifeId,
    }))
    const borrowedParent = parents?.[0]
    return {
      ...row,
      addedDate: row.addedDate || undefined,
      bestPhotoId: row.bestPhotoId || undefined,
      taxonCode: row.taxonCode || undefined,
      commonName: metadata.common,
      scientificName: metadata.scientific,
      wikiTitle: metadata.wikiTitle ?? borrowedParent?.wikiTitle,
      thumbnailUrl: metadata.thumbnailUrl ?? borrowedParent?.thumbnailUrl,
      ...(compound && parents ? {
        compound: { kind: compound.kind, parents },
        borrowedFrom: borrowedParent?.commonName,
      } : {}),
    }
  })
}
