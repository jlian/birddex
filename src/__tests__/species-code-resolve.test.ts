/**
 * resolveSpeciesCode is the key #306 groups on, so its coverage is the whole
 * feature. These are the real strings that missed before the sidecar: two from
 * production, one from our own e2e fixture.
 */
import { describe, it, expect } from 'vitest'
import { resolveSpeciesCode } from '../../functions/lib/taxonomy'

describe('resolveSpeciesCode', () => {
  it('resolves an ordinary classifier species', () => {
    expect(resolveSpeciesCode('Northern Cardinal')).toBe('norcar')
    expect(resolveSpeciesCode('Northern Cardinal (Cardinalis cardinalis)')).toBe('norcar')
  })

  it('resolves a spuh from the e2e fixture', () => {
    expect(resolveSpeciesCode('Gull sp.')).toBe('larus')
  })

  it('resolves the production domestic forms via the binomial fallback', () => {
    // Neither string matches any eBird common name, so only the scientific
    // name connects them, after the trinomial is cut back to its binomial.
    // Both roll up into their WILD species, which is right and consistent:
    // Anas platyrhynchos is the wild Mallard and Gallus gallus the wild Red
    // Junglefowl, both real classifier species, so they win over eBird's
    // "(Domestic type)" sidecar entries. Rolling a domestic form up into its
    // wild species is what eBird's own REPORT_AS does.
    expect(resolveSpeciesCode('Pekin Duck (Anas platyrhynchos domesticus)')).toBe('mallar3')
    expect(resolveSpeciesCode('Domestic Chicken (Gallus gallus domesticus)')).toBe('redjun')
  })

  it('resolves a domestic form that has no wild species in the classifier', () => {
    // Not every domestic form rolls up. This one only exists in eBird as a
    // domestic taxon, so it comes from the sidecar rather than a wild species.
    expect(resolveSpeciesCode('Domestic goose sp. (Domestic type)')).toBe('domgoo1')
  })

  it('resolves a species dropped by the extinct-taxa change', () => {
    expect(resolveSpeciesCode('Dodo (Raphus cucullatus)')).toBe('dodo1')
  })

  it('returns empty string for a name in neither file', () => {
    expect(resolveSpeciesCode('Pidgey (Pokémon)')).toBe('')
    expect(resolveSpeciesCode('')).toBe('')
  })

  it('prefers the scientific name when common names collide', () => {
    // The scientific name is the more stable key across eBird revisions.
    expect(resolveSpeciesCode('Anything At All (Cardinalis cardinalis)')).toBe('norcar')
  })
})
