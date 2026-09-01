import { describe, expect, it } from 'vitest'
import { findBestMatch, findCompoundTaxon, getEbirdCode } from '../../functions/lib/taxonomy'

describe('findCompoundTaxon', () => {
  it('resolves both parents of a hybrid from the common name', () => {
    const result = findCompoundTaxon('Western x Glaucous-winged Gull (hybrid)')
    expect(result?.kind).toBe('hybrid')
    expect(result?.parents.map(parent => parent.common))
      .toEqual(['Western Gull', 'Glaucous-winged Gull'])
  })

  it('borrows the group noun that only the last side spells out', () => {
    const result = findCompoundTaxon('Spotted x White-faced Whistling-Duck (hybrid)')
    expect(result?.parents.map(parent => parent.common))
      .toEqual(['Spotted Whistling-Duck', 'White-faced Whistling-Duck'])
  })

  it('resolves hybrids whose parents are in different genera', () => {
    const result = findCompoundTaxon('Baikal x Green-winged Teal (hybrid)')
    expect(result?.parents.map(parent => parent.common))
      .toEqual(['Baikal Teal', 'Green-winged Teal'])
  })

  it('resolves two- and three-way slashes', () => {
    expect(findCompoundTaxon('Common/Somali Ostrich')?.parents.map(parent => parent.common))
      .toEqual(['Common Ostrich', 'Somali Ostrich'])
    expect(findCompoundTaxon("Velvet/White-winged/Stejneger's Scoter")?.parents.map(parent => parent.common))
      .toEqual(['Velvet Scoter', 'White-winged Scoter', "Stejneger's Scoter"])
  })

  it('uses one reading for every side and inherits the latest explicit genus', () => {
    expect(findCompoundTaxon('Calliope x Rufous Hummingbird (hybrid)')?.parents.map(parent => parent.common))
      .toEqual(['Calliope Hummingbird', 'Rufous Hummingbird'])
    expect(findCompoundTaxon('Porzana porzana/Zapornia parva/pusilla')?.parents.map(parent => parent.common))
      .toEqual(['Spotted Crake', 'Little Crake', "Baillon's Crake"])
  })

  it('refuses spuhs, nested separators, and one-parent answers', () => {
    expect(findCompoundTaxon('golden-plover sp. (Pluvialis dominica/apricaria/fulva)')).toBeNull()
    expect(findCompoundTaxon('Greater White-fronted x Cackling/Canada Goose (hybrid)')).toBeNull()
    expect(findCompoundTaxon('Canvasback x scaup sp. (hybrid)')).toBeNull()
  })
})

describe('exact species matching', () => {
  it('resolves qualifiers and trinomials without guessing', () => {
    expect(findBestMatch('Brant (Branta bernicla (Gray-bellied))')?.common).toBe('Brant')
    expect(findBestMatch('Dark-eyed Junco (Junco hyemalis oreganus)')?.common).toBe('Dark-eyed Junco')
    expect(findBestMatch('Pink-headed Duck')).toBeNull()
  })

  it('does not truncate a compound into one parent', () => {
    expect(findBestMatch('Anser indicus x caerulescens')).toBeNull()
    expect(findBestMatch('Hybrid label (Anser indicus x caerulescens)')).toBeNull()
  })

  it('uses the sidecar-aware resolver for eBird links', () => {
    expect(getEbirdCode('Kingfisher (Alcedo atthis)')).toBe('comkin1')
    expect(getEbirdCode('Gull sp.')).toBe('larus')
    expect(getEbirdCode('Dodo')).toBe('dodo1')
    expect(getEbirdCode('Sparrow')).toBe('')
  })
})