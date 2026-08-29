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
  region: string | null
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
 * `toLowerCase` matches the builder's `str.lower`; the note below explains why
 * that is deliberate rather than `casefold`.
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
    // Match the builder's category test exactly. It keeps alphanumerics, maps
    // punctuation, separators and symbols (P, Z, S) to a space, and DROPS
    // everything else. A single catch-all was wrong for format characters: a
    // zero-width joiner is category Cf, so the builder deleted it while this
    // turned it into a space, folding `ab<ZWJ>cd` to `abcd` offline and
    // `ab cd` here, which the index could never match.
    .replace(/[\p{Cf}\p{Cc}\p{Co}\p{Cn}]+/gu, '')
    .replace(/[\p{P}\p{Z}\p{S}]+/gu, ' ')
    // Anything still not alphanumeric is dropped rather than separated, which
    // is what the builder's else-branch does.
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .replace(/ +/g, ' ')
    .trim()
}

/**
 * Build the FTS5 MATCH expression for a submitted query.
 *
 * EVERY token carries a trailing `*`.
 *
 * An earlier version starred only the final token, on the theory that a
 * submitted query has complete words except where the user stopped typing.
 * That is wrong, and the test for the issue's own requirement caught it:
 * `discover par` returned nothing, because `"discover"` is not a token in
 * `discovery park`. #343 requires token-prefix matching, and a user who
 * abbreviates more than one word is doing exactly that.
 *
 * The cost is real and was measured: `"park"*` matches 231,558 rows against
 * 219,289 for exact `park`, and costs 42 ms rather than 6.9 ms on the global
 * index. That is why the candidate stage below is bounded BEFORE ranking; the
 * bound is what makes full prefix matching affordable, rather than trimming
 * the requirement to fit.
 *
 * Quoting is what makes the input inert. FTS5 treats bare `AND`, `NOT`,
 * `NEAR`, `*` and `^` as operators, so an unquoted user string is a query
 * injection: `a OR b` would silently widen the search and a lone `*` would
 * error. A quoted token followed by `*` is a literal prefix term.
 */
export function ftsExpression(folded: string): string {
  const tokens = folded.split(' ').filter(Boolean)
  if (tokens.length === 0) return ''
  // A double quote is the only character with meaning inside a quoted FTS5
  // string, and it is escaped by doubling it.
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(' ')
}

/**
 * Bound the candidate set BEFORE ranking, then rank only those rows.
 *
 * The obvious single query is wrong at planet scale: `LIMIT` applies after the
 * full MATCH is evaluated and sorted, so a common prefix like `park*` would run
 * the correlated alias lookup and the sort across hundreds of thousands of rows
 * and only then keep five. On D1 that is the difference between a fast query
 * and a timeout.
 *
 * The inner query takes the top `CANDIDATE_LIMIT` rows by FTS rank alone, which
 * FTS5 satisfies from its own index, and the outer query does the expensive
 * exact-alias test and secondary ordering over that bounded set.
 *
 * A pure rank-ordered cut could drop an exact match that bm25 ranks low, so the
 * candidate stage is a UNION: the FTS-ranked head plus any row whose alias
 * matches the query exactly. Exact matches are the whole point of the ranking,
 * so they can never be cut before it runs.
 *
 * The exact arm carries its own ORDER BY rather than an unordered `LIMIT`. A
 * bare limit takes whichever rows the index happens to yield first, so for a
 * common name with more than `CANDIDATE_LIMIT` exact matches the surviving
 * subset depended on import order, and a better match could be dropped before
 * ranking ever saw it. Ordering by the same criteria the final sort uses makes
 * the cut deterministic and keeps the best rows.
 *
 * Within the exact group the FTS rank is neutralised and IMPORTANCE leads,
 * ahead of the WingDex category score.
 *
 * That is a deliberate amendment to #343 step 12, which specifies category
 * before importance, agreed with John on 2026-08-28 after the corpus showed the
 * documented order returning the wrong answer for the most obvious query in the
 * golden set.
 *
 * `central park` matches 521 places EXACTLY. Two of them score 26, the top
 * tourism tier (`zoo`/`aquarium`/`theme_park`), against 25 for the 501 plain
 * parks in that set, so category-first ranking returns parks in Tajikistan and
 * Uzbekistan ahead of the one in New York, which carries importance 156 against
 * their nothing.
 *
 * The reasoning: the category score answers "what KIND of place is this", which
 * is the right tie-breaker while candidates still differ by name. Once several
 * places share a name exactly, that question is spent and the remaining one is
 * "which of these does the searcher mean", which is what importance measures.
 * Category still breaks ties beneath it.
 *
 * bm25 is neutralised for the same reason: it cannot separate names that are
 * identical, and letting it try ranked whichever matching name was shortest.
 *
 * Non-exact candidates keep the documented order, where text relevance and
 * category still carry the signal.
 *
 * The exact test uses `place_alias`, not `places.alias`. The latter
 * concatenates every alias, so equality there would only ever fire for places
 * with exactly one name.
 */
const SEARCH_SQL = `
  WITH candidates AS (
    SELECT f.rowid AS id, rank AS fts_rank
    FROM places_fts f
    WHERE places_fts MATCH ?2
    ORDER BY rank
    LIMIT ?3
  ),
  exact AS (
    SELECT a.place_id AS id, 0.0 AS fts_rank
    FROM place_alias a
    JOIN places pe ON pe.id = a.place_id
    WHERE a.alias = ?1
    ORDER BY COALESCE(pe.imp, 0) DESC, pe.score DESC, pe.osm_id
    LIMIT ?3
  ),
  pool AS (
    SELECT id, MIN(fts_rank) AS fts_rank
    FROM (SELECT * FROM candidates UNION ALL SELECT * FROM exact)
    GROUP BY id
  ),
  ranked AS (
    SELECT p.id, p.label, p.lat, p.lon, p.state, p.country, p.region, p.score, p.imp, p.osm_id,
           pool.fts_rank,
           EXISTS (SELECT 1 FROM place_alias a WHERE a.place_id = p.id AND a.alias = ?1) AS is_exact
    FROM pool
    JOIN places p ON p.id = pool.id
  )
  SELECT label, lat, lon, state, country, region
  FROM ranked
  ORDER BY is_exact DESC,
           CASE WHEN is_exact THEN 0.0 ELSE fts_rank END,
           CASE WHEN is_exact THEN -COALESCE(imp, 0) ELSE -score END,
           CASE WHEN is_exact THEN -score ELSE -COALESCE(imp, 0) END,
           osm_id
  LIMIT ?4
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
      .bind(folded, expression, CANDIDATE_LIMIT, SEARCH_LIMIT)
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

  const out: GeocodingResult[] = []
  for (const row of rows) {
    // No de-duplication by label. Two places genuinely called `Memorial Park`
    // in the same state are different destinations with different coordinates,
    // and collapsing them silently removes a valid answer. The five-result
    // limit already bounds the list.
    // The wider region, for telling same-named results apart. This mirrors
    // `formatGeoapifyContext`: a human-readable locality name, and never a
    // fragment the label already says. Issue #343 step 4 asks for useful
    // locality names, so a bare `US-WA` here would leave two same-named parks
    // in one subdivision indistinguishable. The ISO codes still travel
    // separately in `stateProvince` and `countryCode` for the eBird mapping.
    const context = [row.region, row.country]
      .filter((part): part is string => Boolean(part))
      .filter((part, index, parts) => parts.indexOf(part) === index)
      .filter(part => !row.label.includes(part))
      .join(', ')
    out.push({
      label: row.label,
      // Region codes are attached OFFLINE, so a five-result search costs no
      // extra archive reads at query time.
      ...(row.state ? { stateProvince: row.state } : {}),
      ...(row.country ? { countryCode: row.country } : {}),
      ...(context ? { context } : {}),
      lat: row.lat,
      lon: row.lon,
    })
    if (out.length >= SEARCH_LIMIT) break
  }
  return out
}
