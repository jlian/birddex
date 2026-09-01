/**
 * Client-side taxonomic order lookup.
 * Maps species common names to their index in the eBird taxonomy,
 * which represents phylogenetic/family order.
 * Loaded lazily on first access to avoid impacting initial bundle.
 */

let orderMap: Map<string, number> | null = null
let birdlifeMap: Map<string, string> | null = null
let ebirdMap: Map<string, string> | null = null
let wikiTitleMap: Map<string, string> | null = null
let sciToCommon: Map<string, string> | null = null
let commonByIndex: string[] | null = null

async function loadOrderMap(): Promise<Map<string, number>> {
  if (orderMap) return orderMap
  const raw = (await import('./taxonomy.json')).default as unknown[][]
  const map = new Map<string, number>()
  const bl = new Map<string, string>()
  const eb = new Map<string, string>()
  const wiki = new Map<string, string>()
  const sci = new Map<string, string>()
  const commons: string[] = []
  for (let i = 0; i < raw.length; i++) {
    const common = raw[i][0] as string
    map.set(common.toLowerCase(), i)
    commons.push(common)
    sci.set(String(raw[i][1]).toLowerCase(), common)
    const birdlifeId = raw[i][5] as string | undefined
    if (birdlifeId) bl.set(common.toLowerCase(), birdlifeId)
    const ebirdCode = raw[i][2] as string | undefined
    if (ebirdCode) eb.set(common.toLowerCase(), ebirdCode)
    const wikiTitle = raw[i][3] as string | undefined
    if (wikiTitle) wiki.set(common.toLowerCase(), wikiTitle)
  }
  orderMap = map
  birdlifeMap = bl
  ebirdMap = eb
  wikiTitleMap = wiki
  sciToCommon = sci
  commonByIndex = commons
  return map
}

/** A hybrid's two parents, or the candidates a slash could not separate. */
export type CompoundSpecies = {
  kind: 'hybrid' | 'slash'
  /** Parent common names, in the order eBird spells them. */
  parents: string[]
}

/**
 * Resolve the parents of a hybrid or slash taxon.
 *
 * eBird generates these names mechanically, so they can be parsed rather than
 * guessed: "Western x Glaucous-winged Gull" and "Common/Somali Ostrich". Only
 * the LAST side spells out the shared group noun, so an earlier side completes
 * itself by borrowing the trailing words from it.
 *
 * This mirrors findCompoundTaxon in functions/lib/taxonomy.ts. The two exist
 * separately because this side loads a trimmed client taxonomy, and the shapes
 * are checked against each other in the tests.
 */
export async function getCompoundSpecies(
  speciesName: string
): Promise<CompoundSpecies | undefined> {
  if (!speciesName) return undefined
  const map = await loadOrderMap()
  const raw = speciesName.trim()
  const paren = raw.match(/^(.+?)\s*\(([^)]+)\)\s*$/)
  const candidates = paren ? [paren[2].trim(), paren[1].trim(), raw] : [raw]

  for (const candidate of candidates) {
    const lower = candidate.toLowerCase()
    // " x " is tested first because a parent's own name may contain a slash.
    const isHybrid = lower.includes(' x ')
    const separator = isHybrid ? ' x ' : lower.includes('/') ? '/' : ''
    if (!separator) continue

    const sides = lower.split(separator).map(side => side.trim()).filter(Boolean)
    if (sides.length < 2) continue

    const genus = sides[0].split(/\s+/)[0]
    const last = sides[sides.length - 1]
    const lastWords = last.split(/\s+/)
    const parents: string[] = []

    for (const side of sides) {
      // Scientific first: a bare epithet inherits the genus from the left.
      const full = side.includes(' ') ? side : `${genus} ${side}`
      let hit = sciToCommon?.get(full)
      if (!hit && map.has(side)) hit = side
      if (!hit && side !== last) {
        // Borrow the longest trailing phrase that resolves, so
        // "Whistling-Duck" wins over "Duck".
        for (let take = lastWords.length - 1; take >= 1 && !hit; take--) {
          const guess = `${side} ${lastWords.slice(-take).join(' ')}`
          if (map.has(guess)) hit = guess
        }
      }
      if (!hit) continue
      // Store the taxonomy's own capitalisation for display.
      const index = map.get(hit.toLowerCase())
      const display = index === undefined ? hit : displayNameAt(index)
      if (display && !parents.includes(display)) parents.push(display)
    }

    if (parents.length === 0) continue
    return { kind: isHybrid ? 'hybrid' : 'slash', parents }
  }

  return undefined
}

/** Common name at a taxonomy row, used to recover canonical capitalisation. */
function displayNameAt(index: number): string | undefined {
  return commonByIndex?.[index]
}

/**
 * Returns the taxonomic order index for a species name.
 * Strips parenthesized scientific name if present.
 * Returns Number.MAX_SAFE_INTEGER for unknown species.
 */
export async function getSpeciesOrder(speciesName: string): Promise<number> {
  const map = await loadOrderMap()
  const display = speciesName.split('(')[0].trim().toLowerCase()
  return map.get(display) ?? Number.MAX_SAFE_INTEGER
}

/**
 * Build a synchronous order map from already-loaded data for bulk sorting.
 * Returns a function that maps speciesName -> order.
 */
export async function buildSyncOrderLookup(
  speciesNames: string[]
): Promise<(name: string) => number> {
  const map = await loadOrderMap()
  const cache = new Map<string, number>()
  for (const name of speciesNames) {
    const display = name.split('(')[0].trim().toLowerCase()
    cache.set(name, map.get(display) ?? Number.MAX_SAFE_INTEGER)
  }
  return (name: string) => cache.get(name) ?? Number.MAX_SAFE_INTEGER
}

/**
 * A synchronous species-name to taxonomy row index lookup, for callers that key
 * data by that index. Returns -1 for unknown species, which callers must treat
 * as "no answer" rather than as row 0.
 *
 * Separate from getSpeciesOrder because that returns MAX_SAFE_INTEGER for
 * unknowns to sort them last, and using a sentinel that large as an index would
 * read far off the end of any table.
 */
export async function getSpeciesIndexLookup(): Promise<(name: string) => number> {
  const map = await loadOrderMap()
  return (name: string) => map.get(name.split('(')[0].trim().toLowerCase()) ?? -1
}

/**
 * Return the BirdLife DataZone factsheet URL for a species, or undefined if unknown.
 * Lazy-loads the taxonomy on first call (shares the cache with order lookups).
 */export async function getBirdlifeFactsheetUrl(
  speciesName: string
): Promise<string | undefined> {
  await loadOrderMap()
  const display = speciesName.split('(')[0].trim().toLowerCase()
  const id = birdlifeMap?.get(display)
  return id ? `https://datazone.birdlife.org/species/factsheet/${id}` : undefined
}

/**
 * Return the eBird species URL for a species, or undefined if unknown.
 *
 * The code is read from the bundled taxonomy rather than derived from the name.
 * eBird codes are not a pure function of the common name (Merlin is `merlin`,
 * Northern Cardinal is `norcar`, Chukar is `chukar`), so any abbreviation rule
 * gets a share of them wrong.
 */
export async function getEbirdSpeciesUrl(
  speciesName: string
): Promise<string | undefined> {
  await loadOrderMap()
  const display = speciesName.split('(')[0].trim().toLowerCase()
  const code = ebirdMap?.get(display)
  return code ? `https://ebird.org/species/${code.toLowerCase()}` : undefined
}

/**
 * Return the English Wikipedia article title for a species, or undefined.
 * Needed for identification candidates, which have no dex entry to read it off.
 */
export async function getWikiTitleForSpecies(
  speciesName: string
): Promise<string | undefined> {
  await loadOrderMap()
  return wikiTitleMap?.get(speciesName.split('(')[0].trim().toLowerCase())
}
