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

  it('does not read one side as a scientific name and the other as a common name', async () => {
    // "Calliope" is also the genus of the Siberian Rubythroat, and "Guira" the
    // genus of the Guira Cuckoo. A reading must explain EVERY side.
    expect((await getCompoundSpecies('Calliope x Rufous Hummingbird (hybrid)'))?.parents)
      .toEqual(['Calliope Hummingbird', 'Rufous Hummingbird'])
    expect((await getCompoundSpecies('Calliope x Broad-tailed Hummingbird (hybrid)'))?.parents)
      .toEqual(['Calliope Hummingbird', 'Broad-tailed Hummingbird'])
    expect((await getCompoundSpecies('Guira/Rufous-headed Tanager'))?.parents)
      .toEqual(['Guira Tanager', 'Rufous-headed Tanager'])
  })

  it('inherits the genus most recently spelled out, not the first one', async () => {
    expect((await getCompoundSpecies('Porzana porzana/Zapornia parva/pusilla'))?.parents)
      .toEqual(['Spotted Crake', 'Little Crake', "Baillon's Crake"])
  })

  it('returns undefined rather than a single parent', async () => {
    // "Hybrid of Greater White-fronted Goose" is a sentence that cannot be true.
    expect(await getCompoundSpecies('Greater White-fronted x Cackling/Canada Goose (hybrid)')).toBeUndefined()
    expect(await getCompoundSpecies('Canvasback x scaup sp. (hybrid)')).toBeUndefined()
    expect(await getCompoundSpecies('Mallard x Mexican/Mottled Duck (hybrid)')).toBeUndefined()
    expect(await getCompoundSpecies("Brewster's x Chestnut-sided Warbler (hybrid)")).toBeUndefined()
  })

  it('prefers hybrid when a parent name contains a slash', async () => {
    expect((await getCompoundSpecies('Mallard x American Black Duck (hybrid)'))?.kind).toBe('hybrid')
  })

  it('parses the scientific name when it is the stored form', async () => {
    const result = await getCompoundSpecies('Struthio camelus/molybdophanes')
    expect(result?.kind).toBe('slash')
    expect(result?.parents).toEqual(['Common Ostrich', 'Somali Ostrich'])
  })
})
