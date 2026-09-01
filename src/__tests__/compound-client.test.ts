import { describe, it, expect } from 'vitest'
import { getCompoundSpecies } from '../lib/taxonomy-order'

/**
 * The client-side mirror of findCompoundTaxon. Kept in step with the server
 * copy by testing the same cases; see src/__tests__/compound-taxa.test.ts.
 */
describe('getCompoundSpecies', () => {
  it('resolves both parents of a hybrid', async () => {
    const result = await getCompoundSpecies('Western x Glaucous-winged Gull (hybrid)')
    expect(result?.kind).toBe('hybrid')
    expect(result?.parents).toEqual(['Western Gull', 'Glaucous-winged Gull'])
  })

  it('borrows the group noun that only the last side spells out', async () => {
    const result = await getCompoundSpecies('Spotted x White-faced Whistling-Duck (hybrid)')
    expect(result?.parents).toEqual(['Spotted Whistling-Duck', 'White-faced Whistling-Duck'])
  })

  it('resolves both candidates of a slash', async () => {
    const result = await getCompoundSpecies('Common/Somali Ostrich')
    expect(result?.kind).toBe('slash')
    expect(result?.parents).toEqual(['Common Ostrich', 'Somali Ostrich'])
  })

  it('resolves a three-way slash', async () => {
    const result = await getCompoundSpecies("Velvet/White-winged/Stejneger's Scoter")
    expect(result?.parents).toEqual(['Velvet Scoter', 'White-winged Scoter', "Stejneger's Scoter"])
  })

  it('returns undefined for an ordinary species', async () => {
    expect(await getCompoundSpecies('Northern Cardinal (Cardinalis cardinalis)')).toBeUndefined()
    expect(await getCompoundSpecies('Mallard')).toBeUndefined()
  })

  it('returns undefined for a spuh, which has no parents to show', async () => {
    expect(await getCompoundSpecies('gull sp.')).toBeUndefined()
  })
})
