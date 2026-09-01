import rawSpeciesCodeMap from './species-code-map.json'

export type SpeciesIdentity = {
  taxonCode: string
  speciesCode: string
}

type CodePair = [taxonCode: string, speciesCode: string]
type SpeciesCodeMap = Record<string, CodePair>

let speciesCodeMap: SpeciesCodeMap | undefined

function getSpeciesCodeMap(): SpeciesCodeMap {
  return speciesCodeMap ??= rawSpeciesCodeMap as unknown as SpeciesCodeMap
}

function lookup(name: string): SpeciesIdentity | undefined {
  const pair = getSpeciesCodeMap()[name]
  return pair ? { taxonCode: pair[0], speciesCode: pair[1] } : undefined
}

export function resolveSpeciesIdentity(speciesName: string): SpeciesIdentity | undefined {
  if (!speciesName) return undefined
  const raw = speciesName.trim()
  const whole = raw.toLowerCase()
  const exact = lookup(whole)
  if (exact) return exact

  const paren = raw.match(/^(.+?)\s*\((.+)\)\s*$/)
  const commonPart = (paren ? paren[1] : raw).trim().toLowerCase()
  const scientificPart = paren
    ? paren[2].replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase()
    : ''

  if (scientificPart) {
    const scientific = lookup(scientificPart)
    if (scientific) return scientific

    const words = scientificPart.split(/\s+/)
    if (words.length > 2 && !scientificPart.includes(' x ') && !scientificPart.includes('/')) {
      const binomial = lookup(words.slice(0, 2).join(' '))
      if (binomial) return binomial
    }
  }

  const common = lookup(commonPart)
  if (common) return common

  for (const suffix of [' (hybrid)', ' (intergrade)']) {
    const compound = lookup(whole + suffix)
    if (compound) return compound
  }
  return undefined
}

export function resolveSpeciesCode(speciesName: string): string {
  return resolveSpeciesIdentity(speciesName)?.speciesCode ?? ''
}
