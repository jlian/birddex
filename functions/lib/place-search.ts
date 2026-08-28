import type { GeocodingResult } from './geocoding'

/**
 * Forward place search against the local D1 FTS5 index.
 *
 * Replaces the Geoapify call behind `searchPlaces()`. The response shape is
 * unchanged, so web and iOS clients need no protocol migration.
 *
 * The index is built offline by `scripts/osm-places/`, from the SAME filtered
 * OSM corpus as the reverse-geocoding PMTiles archive. Both sides share the
 * inclusion rules in `place-rank.ts`, so a place cannot be a valid search
 * result and an invalid reverse-geocode answer, or the reverse.
 */

/** Maximum results returned to a client, per issue #343 step 12. */
export const SEARCH_LIMIT = 5

/** Candidate rows read before ranking. */
const CANDIDATE_LIMIT = 200

export class SearchUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SearchUnavailableError'
  }
}

interface SearchRow {
  label: string
  lat: number
  lon: number
  state: string | null
  country: string | null
}

/**
 * Fold a query the same way the offline builder folded the index.
 *
 * This MUST match `fold()` in `scripts/osm-places/build-search-records.py`. If
 * the two drift, queries stop matching rows that plainly contain the words,
 * and the failure is silent: a search simply returns nothing.
 *
 * NFKD then strip combining marks, so an ASCII `donana` finds `Doñana`.
 * Punctuation becomes a space, so `Saint-Louis` matches `Saint Louis`.
 * `toLowerCase` is applied to the decomposed form for the same reason the
 * builder uses `casefold`.
 */
export function foldQuery(input: string): string {
  return input
    .normalize('NFKD')
    // Strip EVERY combining mark, matching Python's `unicodedata.combining`
    // test. An earlier version used the U+0300-U+036F block, which covers only
    // Latin/Greek/Cyrillic marks: Hebrew niqqud and Arabic harakat survived,
    // were then treated as punctuation, and split one word into several. The
    // Hebrew for "shalom" folded to three tokens here and one token in the
    // builder, so the index and the query could never agree.
    .replace(/\p{M}/gu, '')
    // `toLowerCase`, matching `str.lower` in the offline builder rather than
    // Python's `casefold`. `casefold` is linguistically better in isolation,
    // folding the German sharp s to `ss`, but JavaScript has no equivalent.
    // An audit of the BMP found 104 characters where the two rules differ, so
    // special-casing them here would be a list that rots. Matching the rule
    // both languages implement natively cannot drift, and
    // `place-search-folding.test.ts` runs the real Python to prove it.
    .toLowerCase()
    // Anything that is not a letter or digit becomes a separator. `\p{L}` and
    // `\p{N}` keep non-Latin scripts intact, which a naive [a-z0-9] would not.
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/**
 * Build the FTS5 MATCH expression for a submitted query.
 *
 * Every token is quoted and exact EXCEPT the last, which keeps a trailing `*`.
 *
 * That split is deliberate. #343 requires token-prefix matching, so a submitted
 * partial name such as `discover par` has to find Discovery Park. But a star on
 * EVERY token is what makes a query slow: against the global index `"park"*`
 * matches 231,558 rows and costs 42 ms on its own, against 6.9 ms for exact
 * `park`, and the extra rows are `parkway` and `parkland`.
 *
 * Starring only the final token keeps prefix search where a user actually stops
 * typing, while the earlier tokens narrow the candidate set cheaply first.
 *
 * Quoting is also what makes the input inert. FTS5 treats bare `AND`, `NOT`,
 * `NEAR`, `*` and `^` as operators, so an unquoted user string is a query
 * injection: `a OR b` would silently widen the search and a lone `*` would
 * error. Quoted tokens are literal text.
 */
export function ftsExpression(folded: string): string {
  const tokens = folded.split(' ').filter(Boolean)
  if (tokens.length === 0) return ''
  // A double quote is the only character with meaning inside a quoted FTS5
  // string, and it is escaped by doubling it.
  const quote = (token: string) => `"${token.replace(/"/g, '""')}"`
  const head = tokens.slice(0, -1).map(quote)
  const tail = `${quote(tokens[tokens.length - 1])}*`
  return [...head, tail].join(' ')
}

/**
 * Rank text quality first, then the WingDex category, then importance.
 *
 * The exact-alias test leads the sort deliberately. `bm25` alone cannot
 * distinguish an exact full-name match from a prefix hit inside a longer name,
 * so a search for `central park` ranked `Centralni park` above the real
 * Central Park. An exact normalised match is the strongest signal a searcher
 * can give.
 *
 * It tests `place_alias`, not `places.alias`. The latter concatenates every
 * alias for FTS indexing, so `alias = 'casablanca'` is FALSE for a place whose
 * column reads `casablanca ... casa ...`, and the boost would reach only
 * places that happen to have exactly one name.
 *
 * `osm_id` breaks the final tie so the order is total: without it, two equally
 * scored rows could swap between requests and a result list would look
 * unstable for no reason.
 */
const SEARCH_SQL = `
  SELECT p.label, p.lat, p.lon, p.state, p.country
  FROM places_fts f
  JOIN places p ON p.id = f.rowid
  WHERE places_fts MATCH ?2
  ORDER BY (EXISTS (SELECT 1 FROM place_alias a WHERE a.place_id = p.id AND a.alias = ?1)) DESC,
           bm25(places_fts),
           p.score DESC,
           COALESCE(p.imp, 0) DESC,
           p.osm_id
  LIMIT ?3
`

export async function searchPlacesLocal(
  db: D1Database | undefined,
  rawQuery: string,
): Promise<GeocodingResult[]> {
  const query = rawQuery.trim().replace(/\s+/g, ' ')
  if (query.length < 2 || query.length > 200) {
    throw new Error('Invalid search query')
  }
  if (!db) {
    throw new SearchUnavailableError('Place search database is not bound')
  }

  const folded = foldQuery(query)
  // Folding can empty a query that passed the length check, for example a
  // string of only punctuation. An empty MATCH expression is an FTS5 syntax
  // error, so return no results rather than a 500.
  if (!folded) return []

  const expression = ftsExpression(folded)

  let rows: SearchRow[]
  try {
    const result = await db
      .prepare(SEARCH_SQL)
      .bind(folded, expression, CANDIDATE_LIMIT)
      .all<SearchRow>()
    rows = result.results ?? []
  } catch (cause) {
    // A D1 failure is not a client error and must not look like an empty
    // result set, which would render as "no places found" and send the user
    // hunting for a place that exists.
    throw new SearchUnavailableError(
      `Place search query failed: ${cause instanceof Error ? cause.message : 'unknown error'}`,
    )
  }

  const seen = new Set<string>()
  const out: GeocodingResult[] = []
  for (const row of rows) {
    // Collapse rows that would render identically. The corpus legitimately
    // holds many places sharing a name, but two entries reading exactly
    // "Discovery Park, US-WA" in a five-item list are noise, not choice.
    const key = `${row.label}|${row.state ?? ''}|${row.country ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      label: row.label,
      // Region codes are attached OFFLINE, so a five-result search costs no
      // extra archive reads at query time.
      ...(row.state ? { stateProvince: row.state } : {}),
      ...(row.country ? { countryCode: row.country } : {}),
      ...(row.state || row.country ? { context: row.state || row.country || '' } : {}),
      lat: row.lat,
      lon: row.lon,
    })
    if (out.length >= SEARCH_LIMIT) break
  }
  return out
}
