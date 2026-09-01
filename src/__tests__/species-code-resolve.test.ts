/**
 * resolveSpeciesCode is the key #306 groups on, so its coverage is the whole
 * feature. These are the real strings that missed before the sidecar: two from
 * production, one from our own e2e fixture.
 */
import { describe, it, expect } from 'vitest'
import { getEbirdCode, getTaxonMetadata, resolveSpeciesCode, resolveSpeciesIdentity } from '../../functions/lib/taxonomy'

describe('resolveSpeciesCode', () => {
  it('resolves an ordinary classifier species', () => {
    expect(resolveSpeciesCode('Northern Cardinal')).toBe('norcar')
    expect(resolveSpeciesCode('Northern Cardinal (Cardinalis cardinalis)')).toBe('norcar')
    expect(resolveSpeciesCode('Cardinalis cardinalis')).toBe('norcar')
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

  it('gives a domestic form the same code from either spelling', () => {
    // The canonical eBird name and the trinomial describe ONE bird, so they
    // must produce one code or the dex splits it in two. The canonical name
    // hits the sidecar directly while the trinomial falls through to the
    // binomial rollup, and before REPORT_AS was applied to sidecar entries the
    // two disagreed: mallar2 (domestic) versus mallar3 (wild).
    expect(resolveSpeciesCode('Mallard (Domestic type)')).toBe('mallar3')
    expect(resolveSpeciesCode('Mallard (Anas platyrhynchos domesticus)')).toBe('mallar3')
    expect(resolveSpeciesCode('Graylag Goose (Domestic type)')).toBe('gragoo')
    expect(resolveSpeciesCode('Graylag Goose (Anser anser domesticus)')).toBe('gragoo')
  })

  it('keeps exact taxon identity separate from REPORT_AS grouping', () => {
    expect(resolveSpeciesIdentity('Southern Brown Kiwi (South I.)')).toEqual({
      taxonCode: 'sobkiw2',
      speciesCode: 'sobkiw1',
    })
    expect(getEbirdCode('Southern Brown Kiwi (South I.)')).toBe('sobkiw2')
    expect(getTaxonMetadata('ignored', 'sobkiw2')).toMatchObject({
      common: 'Southern Brown Kiwi (South I.)',
      scientific: 'Apteryx australis australis',
      ebirdCode: 'sobkiw2',
    })
  })

  it('rolls a subspecies up to its species, matching eBird REPORT_AS', () => {
    // Same rule, wider application: an ISSF taxon counts as its species.
    expect(resolveSpeciesCode('Dark-eyed Junco (Oregon)')).toBe('daejun')
  })

  it('resolves a domestic form that has no wild species in the classifier', () => {
    // Not every domestic form rolls up. This one only exists in eBird as a
    // domestic taxon, so it comes from the sidecar rather than a wild species.
    expect(resolveSpeciesCode('Domestic goose sp. (Domestic type)')).toBe('domgoo1')
  })

  it('does not truncate an unlisted compound to its first parent', () => {
    // The trinomial rollup exists for subspecies, but a compound scientific
    // name is also more than two words. Truncating "Anas platyrhynchos x
    // Cardinalis cardinalis" would file a hybrid under Mallard as though it
    // were that species. Every compound eBird publishes is in the sidecar, so
    // anything reaching the fallback is unlisted and no code is the honest
    // answer.
    expect(resolveSpeciesCode('Odd Cross (Anas platyrhynchos x Cardinalis cardinalis)')).toBe('')
    expect(resolveSpeciesCode('Odd Cross (Anas platyrhynchos x madeuppus)')).toBe('')
    expect(resolveSpeciesCode('Odd Slash (Anas platyrhynchos/Cardinalis cardinalis)')).toBe('')
    // A listed compound still resolves, through the sidecar rather than the fallback.
    expect(resolveSpeciesCode('Some Hybrid (Anser indicus x caerulescens)')).toBe('x00991')
    // And a genuine subspecies trinomial is untouched.
    expect(resolveSpeciesCode('Dark-eyed Junco (Junco hyemalis oreganus)')).toBe('daejun')
  })

  it('resolves a species dropped by the extinct-taxa change', () => {
    expect(resolveSpeciesCode('Dodo (Raphus cucullatus)')).toBe('dodo1')
  })

  it('returns empty string for a name in neither file', () => {
    expect(resolveSpeciesCode('Pidgey (Pokémon)')).toBe('')
    expect(resolveSpeciesCode('')).toBe('')
  })

  it('resolves a hybrid whose eBird category suffix was omitted', () => {
    // eBird spells these "Western x Glaucous-winged Gull (hybrid)", but the
    // suffix reads like an annotation, so users and non-eBird imports drop it.
    // Without this the name has a real code but grouped by name instead.
    expect(resolveSpeciesCode('Western x Glaucous-winged Gull')).toBe('x00051')
    expect(resolveSpeciesCode('Mallard x American Black Duck')).toBe('x00004')
    // The canonical spelling must keep resolving identically.
    expect(resolveSpeciesCode('Western x Glaucous-winged Gull (hybrid)')).toBe('x00051')
  })

  it('does not invent a hybrid for a name that is not one', () => {
    // The suffix is only appended after every exact lookup has failed, so a
    // real species and outright junk are both unaffected.
    expect(resolveSpeciesCode('Mallard')).toBe('mallar3')
    expect(resolveSpeciesCode('Sparrow')).toBe('')
    expect(resolveSpeciesCode('Unknown bird')).toBe('')
  })

  it('prefers the scientific name when common names collide', () => {
    // The scientific name is the more stable key across eBird revisions.
    expect(resolveSpeciesCode('Anything At All (Cardinalis cardinalis)')).toBe('norcar')
  })
})
