import { describe, it, expect } from 'vitest'
import { findBestMatch, findCompoundTaxon } from '../../functions/lib/taxonomy'

/**
 * eBird taxa that are not a single species.
 *
 * A HYBRID is a biological bird with two parent species. A SLASH is an
 * unresolved identification: "one of these, I could not tell which". They carry
 * the same two-parent data and mean opposite things, so they are reported
 * separately and the UI must not render them identically.
 *
 * Both are parsed from the name rather than from a lookup table, because eBird
 * generates these names mechanically and spells them regularly.
 */
describe('findCompoundTaxon', () => {
  it('resolves both parents of a hybrid from the common name', () => {
    const result = findCompoundTaxon('Western x Glaucous-winged Gull (hybrid)')
    expect(result?.kind).toBe('hybrid')
    expect(result?.parents.map(parent => parent.common))
      .toEqual(['Western Gull', 'Glaucous-winged Gull'])
  })

  it('borrows the group noun that only the last side spells out', () => {
    // "Spotted x White-faced Whistling-Duck" means two whistling-ducks; the
    // first side is abbreviated and has to inherit "Whistling-Duck".
    const result = findCompoundTaxon('Spotted x White-faced Whistling-Duck (hybrid)')
    expect(result?.parents.map(parent => parent.common))
      .toEqual(['Spotted Whistling-Duck', 'White-faced Whistling-Duck'])
  })

  it('resolves a hybrid whose parents are in different genera', () => {
    // "Sibirionetta formosa x Anas crecca": the right side names its own genus.
    const result = findCompoundTaxon('Baikal x Green-winged Teal (hybrid)')
    expect(result?.parents.map(parent => parent.common))
      .toEqual(['Baikal Teal', 'Green-winged Teal'])
  })

  it('resolves both candidates of a slash', () => {
    const result = findCompoundTaxon('Common/Somali Ostrich')
    expect(result?.kind).toBe('slash')
    expect(result?.parents.map(parent => parent.common))
      .toEqual(['Common Ostrich', 'Somali Ostrich'])
  })

  it('resolves a three-way slash', () => {
    const result = findCompoundTaxon("Velvet/White-winged/Stejneger's Scoter")
    expect(result?.parents.map(parent => parent.common))
      .toEqual(['Velvet Scoter', 'White-winged Scoter', "Stejneger's Scoter"])
  })

  it('parses the scientific name when it is the stored form', () => {
    const result = findCompoundTaxon('Struthio camelus/molybdophanes')
    expect(result?.kind).toBe('slash')
    expect(result?.parents).toHaveLength(2)
  })

  it('prefers hybrid when a parent name contains a slash', () => {
    // 13 hybrids contain "/" inside a parent's own name. Testing " x " first
    // keeps them hybrids rather than mis-reading them as slashes.
    const result = findCompoundTaxon('Mallard x American Black Duck (hybrid)')
    expect(result?.kind).toBe('hybrid')
  })

  it('returns null for an ordinary species', () => {
    expect(findCompoundTaxon('Northern Cardinal (Cardinalis cardinalis)')).toBeNull()
    expect(findCompoundTaxon('Mallard')).toBeNull()
  })

  it('returns null for a genus-level spuh, which has no parents to show', () => {
    expect(findCompoundTaxon('gull sp.')).toBeNull()
    expect(findCompoundTaxon('Passerine sp.')).toBeNull()
  })

  it('does not read one side as a scientific name and the other as a common name', () => {
    // "Calliope" is both an abbreviated common name and the genus of the
    // Siberian Rubythroat (Calliope calliope). Reading side by side reported a
    // hummingbird hybrid as half rubythroat. A reading is only accepted when it
    // explains EVERY side.
    expect(findCompoundTaxon('Calliope x Rufous Hummingbird (hybrid)')?.parents.map(p => p.common))
      .toEqual(['Calliope Hummingbird', 'Rufous Hummingbird'])
    expect(findCompoundTaxon('Calliope x Broad-tailed Hummingbird (hybrid)')?.parents.map(p => p.common))
      .toEqual(['Calliope Hummingbird', 'Broad-tailed Hummingbird'])
    // "Guira" is the genus of the Guira Cuckoo and also the abbreviated first
    // side of a tanager slash.
    expect(findCompoundTaxon('Guira/Rufous-headed Tanager')?.parents.map(p => p.common))
      .toEqual(['Guira Tanager', 'Rufous-headed Tanager'])
  })

  it('inherits the genus most recently spelled out, not the first one', () => {
    // "pusilla" follows "Zapornia parva", so it is Zapornia pusilla
    // (Baillon's Crake), not Porzana pusilla.
    expect(findCompoundTaxon('Porzana porzana/Zapornia parva/pusilla')?.parents.map(p => p.common))
      .toEqual(['Spotted Crake', 'Little Crake', "Baillon's Crake"])
  })

  it('returns null rather than a single parent', () => {
    // A one-parent answer renders as "Hybrid of Greater White-fronted Goose",
    // a sentence that cannot be true. These carry a nested separator or a spuh
    // side that is not a species, so no honest pair exists.
    expect(findCompoundTaxon('Greater White-fronted x Cackling/Canada Goose (hybrid)')).toBeNull()
    expect(findCompoundTaxon('Canvasback x scaup sp. (hybrid)')).toBeNull()
    expect(findCompoundTaxon('Mallard x Mexican/Mottled Duck (hybrid)')).toBeNull()
    expect(findCompoundTaxon("Brewster's x Chestnut-sided Warbler (hybrid)")).toBeNull()
  })
})

describe('findBestMatch resolves subspecies without guessing', () => {
  it('rolls a trinomial up to its species', () => {
    expect(findBestMatch('Dark-eyed Junco (Junco hyemalis oreganus)')?.common)
      .toBe('Dark-eyed Junco')
  })

  it('handles a qualifier nested inside the scientific name', () => {
    // eBird writes "Branta bernicla (Gray-bellied)" for some forms.
    expect(findBestMatch('Brant (Gray-bellied)')?.common).toBe('Brant')
    expect(findBestMatch('Graylag Goose (Domestic type)')?.common).toBe('Graylag Goose')
  })

  it('does not resolve a compound taxon to one arbitrary parent', () => {
    // The old word-overlap scorer returned a single species here, which made a
    // hybrid look like an ordinary sighting of one parent.
    expect(findBestMatch('Western x Glaucous-winged Gull (hybrid)')).toBeNull()
    expect(findBestMatch('Common/Somali Ostrich')).toBeNull()
  })

  it('does not truncate a compound scientific name into a binomial', () => {
    // Trinomial truncation is for subspecies. Applied to a hybrid it kept the
    // first two words and reported one parent as though it were the bird.
    expect(findBestMatch('Anser indicus x caerulescens')).toBeNull()
    expect(findBestMatch('Hybrid label (Anser indicus x caerulescens)')).toBeNull()
    expect(findBestMatch('Struthio camelus/molybdophanes')).toBeNull()
  })
})
