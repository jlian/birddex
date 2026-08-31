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
// Row index into taxonomy.json, for callers that key data by classifier
// position. Sidecar taxa are deliberately absent: they have no row.
let indexMap: Map<string, number> | null = null
// Lowercased names that exist ONLY in the sidecar. Used to stop an exact
// sidecar hit from falling through to a stripped-name classifier lookup.
const extraNames = new Set<string>()

async function loadOrderMap(): Promise<Map<string, number>> {
  if (orderMap) return orderMap
  const raw = (await import('./taxonomy.json')).default as unknown[][]
  const map = new Map<string, number>()
  const idx = new Map<string, number>()
  const bl = new Map<string, string>()
  const eb = new Map<string, string>()
  const wiki = new Map<string, string>()
  for (let i = 0; i < raw.length; i++) {
    const common = raw[i][0] as string
    map.set(common.toLowerCase(), i)
    idx.set(common.toLowerCase(), i)
    const birdlifeId = raw[i][5] as string | undefined
    if (birdlifeId) bl.set(common.toLowerCase(), birdlifeId)
    const ebirdCode = raw[i][2] as string | undefined
    if (ebirdCode) eb.set(common.toLowerCase(), ebirdCode)
    const wikiTitle = raw[i][3] as string | undefined
    if (wikiTitle) wiki.set(common.toLowerCase(), wikiTitle)
  }

  // Merge the display sidecar: eBird taxa that are NOT in the classifier
  // (spuh, slash, hybrid, issf, domestic, and the extinct species dropped in
  // #372). These can all appear in an eBird export, so they need names, codes
  // and a sort position, but they must never reach the model.
  //
  // They are added to the display maps ONLY. indexMap is left alone, because a
  // classifier row index is exactly what these taxa do not have; handing a
  // caller a fabricated index would read off the end of the matrix or the
  // occurrence blob.
  //
  // sort order comes from eBird's own TAXON_ORDER, which interleaves these
  // with the real species. It is a float across the whole taxonomy, so it is
  // scaled into the tail of the index space rather than colliding with a row.
  const extra = (await import('./taxonomy-extra.json')).default as unknown as {
    entries: [string, string, string, string, number, string][]
  }
  for (const [code, common, , , taxonOrder] of extra.entries) {
    const key = common.toLowerCase()
    if (map.has(key)) continue          // classifier wins on any collision
    map.set(key, raw.length + taxonOrder)
    extraNames.add(key)
    if (code) eb.set(key, code)
  }

  orderMap = map
  indexMap = idx
  birdlifeMap = bl
  ebirdMap = eb
  wikiTitleMap = wiki
  return map
}

/**
 * Returns the taxonomic order index for a species name.
 * Strips parenthesized scientific name if present.
 * Returns Number.MAX_SAFE_INTEGER for unknown species.
 */
export async function getSpeciesOrder(speciesName: string): Promise<number> {
  const map = await loadOrderMap()
  return lookupByName(map, speciesName) ?? Number.MAX_SAFE_INTEGER
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
    cache.set(name, lookupByName(map, name) ?? Number.MAX_SAFE_INTEGER)
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
/**
 * Look a species name up in a name-keyed map, trying the WHOLE string before
 * stripping a trailing parenthetical.
 *
 * The order matters. Several canonical eBird names contain their own
 * parentheses: "Mallard (Domestic type)" is a real taxon. Stripping first turns
 * it into "Mallard" and returns the WILD Mallard's data, so a domestic bird
 * would show another species' order, URL and rarity. Only fall back to the
 * stripped form for the "Common (Scientific)" shape we store ourselves.
 */
function lookupByName<T>(map: Map<string, T> | null, name: string): T | undefined {
  if (!map) return undefined
  const whole = name.trim().toLowerCase()
  const exact = map.get(whole)
  if (exact !== undefined) return exact
  return map.get(name.split('(')[0].trim().toLowerCase())
}

export async function getSpeciesIndexLookup(): Promise<(name: string) => number> {
  await loadOrderMap()
  return (name: string) => {
    // An exact sidecar hit must return -1, not fall through to the stripped
    // name: sidecar taxa have no classifier row, and resolving
    // "Mallard (Domestic type)" to the wild Mallard's index would apply another
    // taxon's occurrence and rarity data.
    const whole = name.trim().toLowerCase()
    const exactIndex = indexMap?.get(whole)
    if (exactIndex !== undefined) return exactIndex
    if (extraNames.has(whole)) return -1
    return indexMap?.get(name.split('(')[0].trim().toLowerCase()) ?? -1
  }
}

/**
 * Return the BirdLife DataZone factsheet URL for a species, or undefined if unknown.
 * Lazy-loads the taxonomy on first call (shares the cache with order lookups).
 */export async function getBirdlifeFactsheetUrl(
  speciesName: string
): Promise<string | undefined> {
  await loadOrderMap()
  const id = lookupByName(birdlifeMap, speciesName)
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
  const code = lookupByName(ebirdMap, speciesName)
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
  return lookupByName(wikiTitleMap, speciesName)
}
