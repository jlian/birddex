import rawTaxonomy from '../../src/lib/taxonomy.json'
import rawExtra from '../../src/lib/taxonomy-extra.json'
import { resolveSpeciesIdentity, resolveSpeciesCode } from './species-code-resolve'
export { resolveSpeciesIdentity, resolveSpeciesCode } from './species-code-resolve'
export type { SpeciesIdentity } from './species-code-resolve'

/** Shared prefix stripped from thumbnail paths in taxonomy.json to save ~490 KB. */
const COMMONS_PREFIX = 'https://upload.wikimedia.org/wikipedia/commons/'

type TaxonEntry = {
  common: string
  scientific: string
  ebirdCode?: string
  reportAsCode?: string
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

// Display sidecar: eBird taxa that are NOT in the classifier (spuh, slash,
// hybrid, issf, domestic, and the species dropped by the extinct-taxa change).
// Held in separate maps so nothing that walks `taxonomy` can pick them up: that
// array is index-aligned with the int8 matrix and both prior blobs, and these
// entries have no row in either.
const extraByCommon = new Map<string, TaxonEntry>()
const extraByScientific = new Map<string, TaxonEntry>()
const extraByCode = new Map<string, TaxonEntry>()

for (const entry of (rawExtra as { entries: unknown[][] }).entries) {
  const [code, common, scientific, , , reportAsCode] = entry as [string, string, string, string, number, string]
  // Roll a domestic or subspecific form up to the species eBird reports it as.
  //
  // Without this the SAME bird resolves two ways depending on which spelling
  // was stored: "Mallard (Domestic type)" hits this map and gets the domestic
  // code mallar2, while "Mallard (Anas platyrhynchos domesticus)" misses it,
  // falls through to the binomial rollup, and gets the wild code mallar3. Two
  // codes means two dex entries for one bird, which is the split this whole
  // change exists to prevent.
  //
  // REPORT_AS is eBird's own answer to "which species does this count as", so
  // following it makes both spellings agree. 23 of the 25 domestic taxa carry
  // one; the two that do not (`Domestic goose sp.`, `Domestic duck sp.`) have
  // no species to roll up to and keep their own code.
  const taxon: TaxonEntry = {
    common,
    scientific,
    ebirdCode: code,
    ...(reportAsCode ? { reportAsCode } : {}),
  }
  const commonKey = common.toLowerCase()
  const scientificKey = scientific.toLowerCase()
  // The classifier always wins, so an eBird revision that reuses a name cannot
  // shadow a species we actually identify.
  if (!byCommonLower.has(commonKey)) extraByCommon.set(commonKey, taxon)
  if (!byScientificLower.has(scientificKey)) {
    extraByScientific.set(scientificKey, taxon)
  }
  if (!byCodeLower.has(code.toLowerCase())) extraByCode.set(code.toLowerCase(), taxon)
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

export type CompoundTaxon = {
  kind: 'hybrid' | 'slash'
  parents: TaxonEntry[]
}

export function findCompoundTaxon(name: string): CompoundTaxon | null {
  if (!name) return null

  const raw = name.trim()
  const paren = raw.match(/^(.+?)\s*\(([^)]+)\)\s*$/)
  const common = paren ? paren[1].trim() : raw
  if (/\bsp\.\s*$/i.test(common)) return null
  const candidates = paren ? [paren[2].trim(), paren[1].trim(), raw] : [raw]

  for (const candidate of candidates) {
    const lower = candidate.toLowerCase()
    const isHybrid = lower.includes(' x ')
    const separator = isHybrid ? ' x ' : lower.includes('/') ? '/' : ''
    if (!separator) continue

    const sides = lower.split(separator).map(side => side.trim()).filter(Boolean)
    if (sides.length < 2) continue

    const chosen = resolveScientificSides(sides) ?? resolveCommonSides(sides)
    if (!chosen) continue

    const parents: TaxonEntry[] = []
    for (const hit of chosen) {
      if (!parents.some(parent => parent.scientific === hit.scientific)) {
        parents.push(hit)
      }
    }
    if (parents.length < 2) continue

    return { kind: isHybrid ? 'hybrid' : 'slash', parents }
  }

  return null
}

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

function resolveCommonSides(sides: string[]): TaxonEntry[] | null {
  const hits: TaxonEntry[] = []
  for (const side of sides) {
    const hit = matchCompoundCommonSide(side, sides)
    if (!hit) return null
    hits.push(hit)
  }
  return hits
}

function matchCompoundCommonSide(side: string, sides: string[]): TaxonEntry | undefined {
  const direct = byCommonLower.get(side)
  if (direct) return direct

  const last = sides[sides.length - 1]
  if (side === last) return undefined

  const lastWords = last.split(/\s+/)
  for (let take = lastWords.length - 1; take >= 1; take--) {
    const candidate = `${side} ${lastWords.slice(-take).join(' ')}`
    const hit = byCommonLower.get(candidate)
    if (hit) return hit
  }
  return undefined
}

export function findBestMatch(name: string): TaxonEntry | null {
  if (!name) return null

  const raw = name.trim()
  const rawLower = raw.toLowerCase()

  const exactCommon = byCommonLower.get(rawLower)
  if (exactCommon) return exactCommon

  const parenMatch = raw.match(/^(.+?)\s*\((.+)\)\s*$/)
  if (parenMatch) {
    const commonPart = parenMatch[1].trim().toLowerCase()
    const scientificPart = parenMatch[2]
      .replace(/\s*\([^)]*\)\s*$/, '')
      .trim()
      .toLowerCase()

    const byScientific = byScientificLower.get(scientificPart)
    if (byScientific) return byScientific

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

export function normalizeSpeciesName(name: string): string {
  const match = findBestMatch(name)
  return match ? match.common : name
}

export function getEbirdCode(speciesName: string): string {
  return resolveSpeciesIdentity(speciesName)?.taxonCode ?? ''
}

export function getSpeciesByCode(code: string): TaxonEntry | undefined {
  const key = code.toLowerCase()
  return byCodeLower.get(key) ?? extraByCode.get(key)
}

/**
 * Resolve a stored speciesName to an eBird species code, or '' if it cannot be
 * resolved. This is the key #306 groups on.
 *
 * WHY THIS IS NOT getEbirdCode
 * ----------------------------
 * getEbirdCode strips the parenthesised part and matches the COMMON name
 * against the classifier taxonomy only. That misses two whole classes of row
 * that a real eBird export produces:
 *
 *   - non-species taxa. "Gull sp.", "Greater/Lesser Scaup", "Mallard x
 *     American Black Duck" are legitimate eBird taxa that are deliberately not
 *     in the classifier.
 *   - domestic forms, where eBird's common name and ours disagree entirely.
 *     Production holds "Pekin Duck (Anas platyrhynchos domesticus)" while
 *     eBird calls the taxon "Mallard (Domestic type)". No common-name rule
 *     connects those; only the scientific name does.
 *
 * So this consults the sidecar too and prefers the SCIENTIFIC name, which is
 * far more stable across eBird revisions than the common name. Trinomials fall
 * back to their binomial, which is what turns the two production misses above
 * into hits.
 *
 * It deliberately does NOT rewrite the stored name. Normalising import names
 * to canonical form was tried in 5b1cb31e and reverted in 3efe9080: our
 * taxonomy IS the eBird taxonomy, and the only divergence was a local edit.
 * Resolving a code alongside the name is additive; rewriting the name is what
 * caused trouble before.
 */
/**
 * Whether a scientific name names more than one taxon.
 *
 * eBird writes a hybrid as "Genus a x b" and a slash as "Genus a/b", both of
 * which exceed two words and would otherwise be truncated to their first
 * parent's binomial.
 */
function isCompoundScientific(scientific: string): boolean {
  return scientific.includes(' x ') || scientific.includes('/')
}

function resolveTaxonEntry(speciesName: string): TaxonEntry | undefined {
  if (!speciesName) return undefined
  const raw = speciesName.trim()

  // 1. The WHOLE stored string, exactly, before interpreting anything.
  //
  //    This has to come first. Several canonical eBird names contain their own
  //    parentheses: "Mallard (Domestic type)" is a real taxon with code
  //    mallar2. Stripping at the first "(" turns it into "Mallard", which
  //    resolves to the WILD Mallard mallar3, so a domestic bird would be filed
  //    under a species it is not. The classifier is checked before the sidecar
  //    so a real species always wins.
  const whole = raw.toLowerCase()
  const exact = byCommonLower.get(whole)
    ?? extraByCommon.get(whole)
    ?? byScientificLower.get(whole)
    ?? extraByScientific.get(whole)
  if (exact?.ebirdCode) return exact

  // "Common (Scientific)" is the canonical stored shape.
  const paren = raw.match(/^(.+?)\s*\((.+)\)\s*$/)
  const commonPart = (paren ? paren[1] : raw).trim().toLowerCase()
  const scientificPart = paren
    ? paren[2].replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase()
    : ''

  // 2. scientific name, exact
  if (scientificPart) {
    const hit = byScientificLower.get(scientificPart) ?? extraByScientific.get(scientificPart)
    if (hit?.ebirdCode) return hit

    // 3. trinomial -> binomial. "anas platyrhynchos domesticus" is not an
    //    eBird scientific name, but "anas platyrhynchos" is.
    // 3. trinomial -> binomial. "anas platyrhynchos domesticus" is not an
    //    eBird scientific name, but "anas platyrhynchos" is.
    //
    //    Never applied to a COMPOUND scientific name. "anas platyrhynchos x
    //    cardinalis cardinalis" is also more than two words, and truncating it
    //    files a hybrid under its first parent as though it were that species,
    //    which is the confident-wrong-answer this resolver exists to avoid. The
    //    sidecar already answers every compound eBird publishes; anything that
    //    reaches here is unlisted, so no code is the honest result.
    const words = scientificPart.split(/\s+/)
    if (words.length > 2 && !isCompoundScientific(scientificPart)) {
      const binomial = words.slice(0, 2).join(' ')
      const viaBinomial =
        byScientificLower.get(binomial) ?? extraByScientific.get(binomial)
      if (viaBinomial?.ebirdCode) return viaBinomial
    }
  }

  // 4. common name with any parenthetical stripped, classifier first
  const byCommon = byCommonLower.get(commonPart) ?? extraByCommon.get(commonPart)
  if (byCommon?.ebirdCode) return byCommon

  // 5. hybrid and intergrade names without eBird's category suffix.
  //
  //    eBird spells these "Western x Glaucous-winged Gull (hybrid)", but the
  //    suffix reads like an annotation rather than part of the name, so users
  //    and non-eBird imports routinely drop it. Those strings resolved to
  //    nothing and fell back to name grouping, which splits a bird that DOES
  //    have a code away from other records of the same cross.
  //
  //    Appending the suffix is safe rather than a guess: across the 791 sidecar
  //    hybrid and intergrade taxa, no stripped form collides with another
  //    stripped form, and none collides with a name that already resolves. So
  //    this only ever recovers an exact taxon, and it runs last, after every
  //    exact lookup above has already failed.
  if (!/\((hybrid|intergrade)\)$/i.test(whole)) {
    for (const suffix of [' (hybrid)', ' (intergrade)']) {
      const hit = extraByCommon.get(whole + suffix)
      if (hit?.ebirdCode) return hit
    }
  }

  return undefined
}

export function getTaxonMetadata(speciesName: string, taxonCode?: string | null): {
  common?: string
  scientific?: string
  ebirdCode?: string
  wikiTitle?: string
  thumbnailUrl?: string
  birdlifeId?: string
} {
  const match = (taxonCode ? getSpeciesByCode(taxonCode) : undefined)
    ?? resolveTaxonEntry(speciesName)
  if (!match) return {}
  return {
    common: match.common,
    scientific: match.scientific,
    ebirdCode: match.ebirdCode,
    wikiTitle: match.wikiTitle,
    thumbnailUrl: match.thumbnailPath
      ? `${COMMONS_PREFIX}${match.thumbnailPath}`
      : undefined,
    birdlifeId: match.birdlifeId,
  }
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
