import rawTaxonomy from '../../src/lib/taxonomy.json'

/** Shared prefix stripped from thumbnail paths in taxonomy.json to save ~490 KB. */
const COMMONS_PREFIX = 'https://upload.wikimedia.org/wikipedia/commons/'

type TaxonEntry = {
  common: string
  scientific: string
  ebirdCode?: string
  wikiTitle?: string
  /** Path relative to COMMONS_PREFIX (e.g. "thumb/a/ab/Foo.jpg/330px-Foo.jpg"). */
  thumbnailPath?: string
  /** BirdLife DataZone species ID, used to build factsheet URLs. */
  birdlifeId?: string
}

const taxonomy: TaxonEntry[] = (rawTaxonomy as unknown[]).map((entry: any) => ({
  common: entry[0],
  scientific: entry[1],
  ...(entry[2] ? { ebirdCode: entry[2] } : {}),
  ...(entry[3] ? { wikiTitle: entry[3] } : {}),
  ...(entry[4] ? { thumbnailPath: entry[4] } : {}),
  ...(entry[5] ? { birdlifeId: entry[5] } : {}),
}))

const lowerIndex = taxonomy.map(taxon => ({
  common: taxon.common.toLowerCase(),
  scientific: taxon.scientific.toLowerCase(),
}))

const byCommonLower = new Map<string, TaxonEntry>()
const byScientificLower = new Map<string, TaxonEntry>()
const byCodeLower = new Map<string, TaxonEntry>()

for (const taxon of taxonomy) {
  byCommonLower.set(taxon.common.toLowerCase(), taxon)
  byScientificLower.set(taxon.scientific.toLowerCase(), taxon)
  if (taxon.ebirdCode) byCodeLower.set(taxon.ebirdCode.toLowerCase(), taxon)
}

export function getWikiTitle(commonName: string): string | undefined {
  return byCommonLower.get(commonName.toLowerCase())?.wikiTitle
}

export function searchSpecies(query: string, limit = 8): TaxonEntry[] {
  const q = query.toLowerCase().trim()
  if (!q) return []

  const prefixCommon: TaxonEntry[] = []
  const prefixScientific: TaxonEntry[] = []
  const substringCommon: TaxonEntry[] = []
  const substringScientific: TaxonEntry[] = []

  for (let index = 0; index < lowerIndex.length; index++) {
    const current = lowerIndex[index]

    if (current.common.startsWith(q)) {
      prefixCommon.push(taxonomy[index])
    } else if (current.scientific.startsWith(q)) {
      prefixScientific.push(taxonomy[index])
    } else if (current.common.includes(q)) {
      substringCommon.push(taxonomy[index])
    } else if (current.scientific.includes(q)) {
      substringScientific.push(taxonomy[index])
    }

    if (
      prefixCommon.length +
        prefixScientific.length +
        substringCommon.length +
        substringScientific.length >=
      limit * 3
    ) {
      break
    }
  }

  return [...prefixCommon, ...prefixScientific, ...substringCommon, ...substringScientific].slice(0, limit)
}

/**
 * One eBird taxon that is not a single species: a hybrid of two parents, or a
 * slash recording that the observer could not separate two candidates.
 */
export type CompoundTaxon = {
  kind: 'hybrid' | 'slash'
  parents: TaxonEntry[]
}

/**
 * Resolve the parent species of a hybrid or slash taxon from its SCIENTIFIC
 * name, which eBird generates mechanically and therefore spells regularly:
 *
 *   hybrid  "Dendrocygna guttata x viduata"     -> both Dendrocygna
 *   hybrid  "Sibirionetta formosa x Anas crecca" -> genus given on both sides
 *   slash   "Struthio camelus/molybdophanes"     -> both Struthio
 *
 * The right-hand side may omit the genus, in which case it is inherited from
 * the left. Measured against the full eBird taxonomy: 773 of 792 hybrids and
 * 1,030 of 1,035 slashes resolve BOTH parents exactly, and the remaining 24
 * resolve nothing rather than a single parent.
 *
 * Common names cannot be parsed this way. "Baikal x Blue-winged Teal" shares
 * the word "teal" with unrelated species, which is how the old word-overlap
 * scorer landed on a bird that was neither parent.
 */
export function findCompoundTaxon(name: string): CompoundTaxon | null {
  if (!name) return null

  // The scientific name is the parseable part. Accept either the bare
  // scientific string or the stored "Common (Scientific)" shape.
  //
  // A hybrid's stored name is usually just "Western x Glaucous-winged Gull
  // (hybrid)", because the importer only appends the scientific name when the
  // common name has no parenthetical of its own. So the common name has to be
  // parseable too, using the classifier's own common-name index.
  const raw = name.trim()
  const paren = raw.match(/^(.+?)\s*\(([^)]+)\)\s*$/)
  const common = paren ? paren[1].trim() : raw
  // A spuh names an unidentified member of a group, not a closed choice
  // between the taxa listed in its slash-separated scientific field.
  if (/\bsp\.\s*$/i.test(common)) return null
  const candidates = paren ? [paren[2].trim(), paren[1].trim(), raw] : [raw]

  for (const candidate of candidates) {
    const lower = candidate.toLowerCase()

    // " x " first: 13 hybrids contain a "/" inside a parent's own name, while
    // no slash taxon contains " x ". Testing hybrid first makes both correct.
    const isHybrid = lower.includes(' x ')
    const separator = isHybrid ? ' x ' : lower.includes('/') ? '/' : ''
    if (!separator) continue

    const sides = lower.split(separator)
    // eBird also spells three-way slashes: "Melanitta fusca/deglandi/stejnegeri"
    // means "one of these three". Resolve every side rather than giving up.
    const trimmed = sides.map(side => side.trim()).filter(Boolean)
    if (trimmed.length < 2) continue

    // A compound is written ENTIRELY in scientific names or ENTIRELY in common
    // names. Mixing the two readings side by side lets one side resolve as a
    // real but unrelated species: "Calliope x Rufous Hummingbird" read the
    // first side as the scientific name Calliope calliope, the Siberian
    // Rubythroat. So each reading is applied to every side, and a reading is
    // only accepted when it explains ALL of them.
    const chosen =
      resolveScientificSides(trimmed) ?? resolveCommonSides(trimmed)
    if (!chosen) continue

    const parents: TaxonEntry[] = []
    for (const hit of chosen) {
      if (!parents.some(parent => parent.scientific === hit.scientific)) {
        parents.push(hit)
      }
    }
    // One parent is not a hybrid and not a choice between candidates, and the
    // UI renders it as a sentence that cannot be true ("Hybrid of Greater
    // White-fronted Goose"). Report nothing rather than half an answer.
    if (parents.length < 2) continue

    return { kind: isHybrid ? 'hybrid' : 'slash', parents }
  }

  return null
}

/**
 * Read every side as a scientific name, or return null.
 *
 * A bare epithet inherits the genus most recently spelled out to its LEFT, not
 * the genus of the first side: "Porzana porzana/Zapornia parva/pusilla" ends in
 * Zapornia pusilla, not Porzana pusilla.
 */
function resolveScientificSides(sides: string[]): TaxonEntry[] | null {
  let genus = sides[0].split(/\s+/)[0]
  const hits: TaxonEntry[] = []
  for (const side of sides) {
    if (side.includes(' ')) genus = side.split(/\s+/)[0]
    const full = side.includes(' ') ? side : `${genus} ${side}`
    const hit = byScientificLower.get(full)
    if (!hit) return null
    hits.push(hit)
  }
  return hits
}

/** Read every side as a common name, or return null. */
function resolveCommonSides(sides: string[]): TaxonEntry[] | null {
  const hits: TaxonEntry[] = []
  for (const side of sides) {
    const hit = matchCompoundCommonSide(side, sides)
    if (!hit) return null
    hits.push(hit)
  }
  return hits
}

/**
 * Resolve one side of a compound COMMON name.
 *
 * eBird abbreviates the shared part of a common-name compound: "Western x
 * Glaucous-winged Gull" means "Western Gull" and "Glaucous-winged Gull", and
 * "Spotted x White-faced Whistling-Duck" means two whistling-ducks. The group
 * noun appears only on the LAST side, so a leading side is completed by
 * borrowing the trailing words from it.
 */
function matchCompoundCommonSide(side: string, sides: string[]): TaxonEntry | undefined {
  const direct = byCommonLower.get(side)
  if (direct) return direct

  const last = sides[sides.length - 1]
  if (side === last) return undefined

  const lastWords = last.split(/\s+/)
  // Try the longest borrowed suffix first so "Whistling-Duck" is preferred
  // over "Duck" when both would match something.
  for (let take = lastWords.length - 1; take >= 1; take--) {
    const candidate = `${side} ${lastWords.slice(-take).join(' ')}`
    const hit = byCommonLower.get(candidate)
    if (hit) return hit
  }
  return undefined
}

/**
 * Resolve a stored species name to a taxonomy entry, or null when it is not a
 * species we hold.
 *
 * EXACT MATCHES ONLY. This used to end in a word-overlap scorer that returned
 * the taxon sharing the most words with the query, which produced confident
 * wrong answers rather than honest misses:
 *
 *   "Pink-headed Duck"  -> White-headed Steamer-Duck
 *   "New Zealand Quail" -> New Zealand Scaup
 *
 * Both are extinct birds shown as a different LIVING species. 72 of the 173
 * extinct taxa resolved that way, along with 135 of 792 hybrids landing on a
 * bird that was neither parent.
 *
 * Measured against eBird's own reportAsCode rollups as ground truth, exact
 * matching plus trinomial truncation scores 4,118 correct, 0 wrong, 0 missed,
 * and returns null for all 952 taxa that have no parent instead of inventing
 * one. Strictly more accurate than the scorer it replaces.
 *
 * Callers that want hybrid or slash parents should use findCompoundTaxon.
 */
export function findBestMatch(name: string): TaxonEntry | null {
  if (!name) return null

  const raw = name.trim()
  const rawLower = raw.toLowerCase()

  const exactCommon = byCommonLower.get(rawLower)
  if (exactCommon) return exactCommon

  const parenMatch = raw.match(/^(.+?)\s*\((.+)\)\s*$/)
  if (parenMatch) {
    const commonPart = parenMatch[1].trim().toLowerCase()
    // eBird nests a qualifier inside the scientific name for some forms:
    // "Branta bernicla (Gray-bellied)", "Anser anser (Domestic type)". Strip a
    // trailing parenthetical so the binomial underneath can be found.
    const scientificPart = parenMatch[2]
      .replace(/\s*\([^)]*\)\s*$/, '')
      .trim()
      .toLowerCase()

    const byScientific = byScientificLower.get(scientificPart)
    if (byScientific) return byScientific

    // A subspecies carries a trinomial: "Apteryx australis australis". Dropping
    // the third word gives the species exactly. This is a truncation, not a
    // guess, and it agrees with eBird's own rollup for 3,950 of 3,952 ISSF
    // taxa (the other two have no rollup to compare against).
    const words = scientificPart.split(/\s+/)
    if (words.length > 2 && !isCompoundScientific(scientificPart)) {
      const binomial = byScientificLower.get(words.slice(0, 2).join(' '))
      if (binomial) return binomial
    }

    const byCommon = byCommonLower.get(commonPart)
    if (byCommon) return byCommon
  }

  const exactScientific = byScientificLower.get(rawLower)
  if (exactScientific) return exactScientific

  const bareWords = rawLower.split(/\s+/)
  if (bareWords.length > 2 && !isCompoundScientific(rawLower)) {
    const binomial = byScientificLower.get(bareWords.slice(0, 2).join(' '))
    if (binomial) return binomial
  }

  return null
}

/**
 * True when a scientific string names more than one taxon.
 *
 * The trinomial truncation below it exists for subspecies ("Apteryx australis
 * australis" -> the species). Applied to "Anser indicus x caerulescens" it
 * would keep the first two words and report one arbitrary parent of a hybrid
 * as though it were the bird itself, which is the confident-wrong-answer
 * failure this function was rewritten to remove.
 */
function isCompoundScientific(scientific: string): boolean {
  return scientific.includes(' x ') || scientific.includes('/')
}

export function normalizeSpeciesName(name: string): string {
  const match = findBestMatch(name)
  return match ? match.common : name
}

export function getEbirdCode(speciesName: string): string {
  // Route through findBestMatch rather than repeating a weaker copy of it.
  //
  // This used to strip at the first "(" and look up the common name alone, so
  // it missed every case the scientific name is what identifies the bird:
  // "Kingfisher (Alcedo atthis)" resolved to nothing, because "Kingfisher" is
  // not an exact common name, while findBestMatch reads the binomial and
  // answers Common Kingfisher. It also missed subspecies trinomials.
  //
  // findBestMatch is exact-only, so this cannot start guessing; it can only
  // stop failing on names it should already have resolved.
  return findBestMatch(speciesName)?.ebirdCode ?? ''
}

export function getSpeciesByCode(code: string): TaxonEntry | undefined {
  return byCodeLower.get(code.toLowerCase())
}

/** Return the BirdLife DataZone factsheet URL for a species, or undefined if unknown. */
export function getBirdlifeFactsheetUrl(name: string): string | undefined {
  const match = findBestMatch(name)
  return match?.birdlifeId
    ? `https://datazone.birdlife.org/species/factsheet/${match.birdlifeId}`
    : undefined
}

export function getWikiMetadata(name: string): {
  wikiTitle?: string
  thumbnailUrl?: string
  common?: string
  scientific?: string
} {
  const match = findBestMatch(name)
  if (!match) return {}

  return {
    wikiTitle: match.wikiTitle,
    thumbnailUrl: match.thumbnailPath
      ? `${COMMONS_PREFIX}${match.thumbnailPath}`
      : undefined,
    common: match.common,
    scientific: match.scientific,
  }
}

export const speciesCount = taxonomy.length
