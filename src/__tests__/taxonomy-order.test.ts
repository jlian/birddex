import { describe, it, expect } from 'vitest'
import {
  getSpeciesOrder,
  buildSyncOrderLookup,
  getEbirdSpeciesUrl,
  getWikiTitleForSpecies,
} from '../lib/taxonomy-order'

// The first three entries in taxonomy.json are:
//   index 0: "Common Ostrich"
//   index 1: "Somali Ostrich"
//   index 2: "Southern Cassowary"
// These are used as stable anchors for the tests below.

describe('getSpeciesOrder', () => {
  it('returns 0 for the first species in taxonomy', async () => {
    expect(await getSpeciesOrder('Common Ostrich')).toBe(0)
  })

  it('returns correct index for a species further in the list', async () => {
    expect(await getSpeciesOrder('Somali Ostrich')).toBe(1)
    expect(await getSpeciesOrder('Southern Cassowary')).toBe(2)
  })

  it('strips parenthesized scientific name before lookup', async () => {
    expect(await getSpeciesOrder('Common Ostrich (Struthio camelus)')).toBe(0)
  })

  it('is case-insensitive', async () => {
    expect(await getSpeciesOrder('common ostrich')).toBe(0)
    expect(await getSpeciesOrder('COMMON OSTRICH')).toBe(0)
  })

  it('returns Number.MAX_SAFE_INTEGER for an unknown species', async () => {
    expect(await getSpeciesOrder('Fake Bird That Does Not Exist')).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe('buildSyncOrderLookup', () => {
  it('returns a function that maps species names to their taxonomy index', async () => {
    const lookup = await buildSyncOrderLookup([
      'Common Ostrich',
      'Somali Ostrich',
      'Southern Cassowary',
    ])
    expect(lookup('Common Ostrich')).toBe(0)
    expect(lookup('Somali Ostrich')).toBe(1)
    expect(lookup('Southern Cassowary')).toBe(2)
  })

  it('handles species names with parenthesized scientific names', async () => {
    const lookup = await buildSyncOrderLookup([
      'Common Ostrich (Struthio camelus)',
    ])
    expect(lookup('Common Ostrich (Struthio camelus)')).toBe(0)
  })

  it('preserves order relationship: earlier taxonomy entries sort lower', async () => {
    const lookup = await buildSyncOrderLookup([
      'Southern Cassowary',
      'Common Ostrich',
    ])
    expect(lookup('Common Ostrich')).toBeLessThan(lookup('Southern Cassowary'))
  })

  it('returns Number.MAX_SAFE_INTEGER for a name not in the pre-built list', async () => {
    const lookup = await buildSyncOrderLookup(['Common Ostrich'])
    expect(lookup('Somali Ostrich')).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('returns Number.MAX_SAFE_INTEGER for an unknown species', async () => {
    const lookup = await buildSyncOrderLookup(['Fake Bird That Does Not Exist'])
    expect(lookup('Fake Bird That Does Not Exist')).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('handles an empty species list', async () => {
    const lookup = await buildSyncOrderLookup([])
    expect(lookup('Common Ostrich')).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe('getEbirdSpeciesUrl', () => {
  // These four are exactly where a name-abbreviation rule goes wrong: one-word
  // names, an initialism, and a hyphenated compound. The codes come from the
  // bundled taxonomy, so the test fails loudly if the column ever moves.
  it.each([
    ['Northern Cardinal', 'norcar'],
    ['Merlin', 'merlin'],
    ['Chukar', 'chukar'],
    ['Red-winged Blackbird', 'rewbla'],
  ])('resolves %s to the eBird code %s', async (name, code) => {
    expect(await getEbirdSpeciesUrl(name)).toBe(`https://ebird.org/species/${code}`)
  })

  it('strips the parenthesized scientific name before lookup', async () => {
    expect(await getEbirdSpeciesUrl('Northern Cardinal (Cardinalis cardinalis)'))
      .toBe('https://ebird.org/species/norcar')
  })

  it('returns undefined for an unknown species rather than guessing a code', async () => {
    expect(await getEbirdSpeciesUrl('Fake Bird That Does Not Exist')).toBeUndefined()
  })
})

describe('getWikiTitleForSpecies', () => {
  it('returns the bundled article title', async () => {
    expect(await getWikiTitleForSpecies('Northern Cardinal')).toBeTruthy()
  })

  it('returns undefined for an unknown species', async () => {
    expect(await getWikiTitleForSpecies('Fake Bird That Does Not Exist')).toBeUndefined()
  })
})
