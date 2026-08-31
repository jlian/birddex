import rawTaxonomy from '../../src/lib/taxonomy.json'
import rawExtra from '../../src/lib/taxonomy-extra.json'

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

// Display sidecar: eBird taxa that are NOT in the classifier (spuh, slash,
// hybrid, issf, domestic, and the species dropped by the extinct-taxa change).
// Held in separate maps so nothing that walks `taxonomy` can pick them up: that
// array is index-aligned with the int8 matrix and both prior blobs, and these
// entries have no row in either.
const extraByCommon = new Map<string, TaxonEntry>()
const extraByScientific = new Map<string, TaxonEntry>()

for (const entry of (rawExtra as { entries: unknown[][] }).entries) {
  const [code, common, scientific] = entry as [string, string, string]
  const taxon: TaxonEntry = { common, scientific, ebirdCode: code }
  const commonKey = common.toLowerCase()
  const scientificKey = scientific.toLowerCase()
  // The classifier always wins, so an eBird revision that reuses a name cannot
  // shadow a species we actually identify.
  if (!byCommonLower.has(commonKey)) extraByCommon.set(commonKey, taxon)
  if (!byScientificLower.has(scientificKey)) {
    extraByScientific.set(scientificKey, taxon)
  }
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

export function findBestMatch(name: string): TaxonEntry | null {
  if (!name) return null

  const raw = name.trim()
  const rawLower = raw.toLowerCase()

  const exactCommon = byCommonLower.get(rawLower)
  if (exactCommon) return exactCommon

  const parenMatch = raw.match(/^(.+?)\s*\(([^)]+)\)\s*$/)
  if (parenMatch) {
    const commonPart = parenMatch[1].trim().toLowerCase()
    const scientificPart = parenMatch[2].trim().toLowerCase()

    const byScientific = byScientificLower.get(scientificPart)
    if (byScientific) return byScientific

    const byCommon = byCommonLower.get(commonPart)
    if (byCommon) return byCommon
  }

  const exactScientific = byScientificLower.get(rawLower)
  if (exactScientific) return exactScientific

  const words = raw.toLowerCase().split(/[\s\-()]+/).filter(Boolean)
  let bestScore = 0
  let bestEntry: TaxonEntry | null = null

  for (let index = 0; index < lowerIndex.length; index++) {
    const combined = `${lowerIndex[index].common} ${lowerIndex[index].scientific}`
    let score = 0

    for (const word of words) {
      if (combined.includes(word)) score++
    }

    if (score > bestScore && score >= Math.max(2, Math.ceil(words.length / 2))) {
      bestScore = score
      bestEntry = taxonomy[index]
    }
  }

  return bestEntry
}

export function normalizeSpeciesName(name: string): string {
  const match = findBestMatch(name)
  return match ? match.common : name
}

export function getEbirdCode(commonName: string): string {
  // Strip parenthesized scientific name if present, e.g. "Saffron Finch (Sicalis flaveola)" → "Saffron Finch"
  const name = commonName.split('(')[0].trim()

  const match = byCommonLower.get(name.toLowerCase())
  if (match?.ebirdCode) return match.ebirdCode
  return ''
}

export function getSpeciesByCode(code: string): TaxonEntry | undefined {
  return byCodeLower.get(code.toLowerCase())
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
export function resolveSpeciesCode(speciesName: string): string {
  if (!speciesName) return ''
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
  const exact = byCommonLower.get(whole) ?? extraByCommon.get(whole)
  if (exact?.ebirdCode) return exact.ebirdCode

  // "Common (Scientific)" is the canonical stored shape.
  const paren = raw.match(/^(.+?)\s*\(([^)]+)\)\s*$/)
  const commonPart = (paren ? paren[1] : raw).trim().toLowerCase()
  const scientificPart = paren ? paren[2].trim().toLowerCase() : ''

  // 2. scientific name, exact
  if (scientificPart) {
    const hit = byScientificLower.get(scientificPart) ?? extraByScientific.get(scientificPart)
    if (hit?.ebirdCode) return hit.ebirdCode

    // 3. trinomial -> binomial. "anas platyrhynchos domesticus" is not an
    //    eBird scientific name, but "anas platyrhynchos" is.
    const words = scientificPart.split(/\s+/)
    if (words.length > 2) {
      const binomial = words.slice(0, 2).join(' ')
      const viaBinomial =
        byScientificLower.get(binomial) ?? extraByScientific.get(binomial)
      if (viaBinomial?.ebirdCode) return viaBinomial.ebirdCode
    }
  }

  // 4. common name with any parenthetical stripped, classifier first
  const byCommon = byCommonLower.get(commonPart) ?? extraByCommon.get(commonPart)
  if (byCommon?.ebirdCode) return byCommon.ebirdCode

  return ''
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
