/**
 * The display sidecar (taxonomy-extra.json) merges eBird taxa that are NOT in
 * the classifier into the name-keyed display maps.
 *
 * The invariant that matters: those taxa must get names, codes and a sort
 * position, but NEVER a classifier row index. taxonomy.json row position keys
 * the int8 matrix and both prior blobs, so a fabricated index would read off
 * the end of a table or apply another bird's occurrence data.
 */
import { describe, it, expect } from 'vitest'

import {
  getSpeciesOrder,
  getEbirdSpeciesUrl,
  getSpeciesIndexLookup,
} from '@/lib/taxonomy-order'
import taxonomy from '@/lib/taxonomy.json'
import extra from '@/lib/taxonomy-extra.json'

describe('taxonomy display sidecar', () => {
  it('never collides with the classifier on a species code', () => {
    const classifier = new Set((taxonomy as unknown as string[][]).map(r => r[2]))
    const overlap = extra.entries.filter(e => classifier.has(e[0] as string))
    expect(overlap).toEqual([])
  })

  it('resolves an eBird code for a spuh that has no classifier row', async () => {
    expect(await getEbirdSpeciesUrl('Gull sp.')).toBe('https://ebird.org/species/larus')
  })

  it('resolves a species dropped by the extinct-taxa change', async () => {
    // Dodo was removed from the classifier in #372 but is still importable.
    expect(await getEbirdSpeciesUrl('Dodo')).toBe('https://ebird.org/species/dodo1')
  })

  it('leaves classifier species resolving exactly as before', async () => {
    expect(await getEbirdSpeciesUrl('Northern Cardinal'))
      .toBe('https://ebird.org/species/norcar')
  })

  it('gives sidecar taxa NO classifier row index', async () => {
    const idx = await getSpeciesIndexLookup()
    // -1 is the documented "no answer" sentinel; rarity-client returns 'none'.
    expect(idx('Gull sp.')).toBe(-1)
    expect(idx('Dodo')).toBe(-1)
  })

  it('still indexes classifier species inside the matrix', async () => {
    const idx = await getSpeciesIndexLookup()
    const i = idx('Northern Cardinal')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(i).toBeLessThan(taxonomy.length)
  })

  it('sorts sidecar taxa after every classifier species, but before unknowns', async () => {
    const gull = await getSpeciesOrder('Gull sp.')
    const cardinal = await getSpeciesOrder('Northern Cardinal')
    expect(cardinal).toBeLessThan(taxonomy.length)
    expect(gull).toBeGreaterThan(cardinal)
    expect(gull).toBeLessThan(Number.MAX_SAFE_INTEGER)
  })

  it('still returns MAX_SAFE_INTEGER for a name in neither file', async () => {
    expect(await getSpeciesOrder('Pidgey')).toBe(Number.MAX_SAFE_INTEGER)
  })
})
