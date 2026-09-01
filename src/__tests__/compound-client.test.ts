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

  it('returns undefined for a spuh, including its real stored form', async () => {
    expect(await getCompoundSpecies('gull sp.')).toBeUndefined()
    for (const stored of [
      'crested guineafowl sp. (Guttera pucherani/verreauxi/edouardi)',
      'fork-tailed swift sp. (Apus pacificus/salimalii/leuconyx/cooki)',
      'golden-plover sp. (Pluvialis dominica/apricaria/fulva)',
      'sand-plover sp. (Anarhynchus mongolus/atrifrons/leschenaultii)',
      'bar-winged cinclodes sp. (Cinclodes albidiventris/albiventris/fuscus)',
      'tropical pewee sp. (Contopus punensis/cinereus/bogotensis)',
      'mouse-warbler sp. (Origma robusta/murina/Aethomyias nigrorufus)',
      'solitary vireo sp. (Vireo cassinii/solitarius/plumbeus)',
      'limestone babbler sp. (Gypsophila annamensis/calcicola/crispifrons)',
      'pied starling sp. (Gracupica contra/floweri/jalla)',
      'troupial sp. (Icterus icterus/croconotus/jamacaii)',
      'masked yellowthroat sp. (Geothlypis aequinoctialis/auricularis/velata)',
    ]) {
      expect(await getCompoundSpecies(stored), stored).toBeUndefined()
    }
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

/**
 * The identification flow cannot produce a compound taxon, so the peek sheet
 * deliberately does not resolve one. This asserts the premise rather than the
 * omission, so if a future taxonomy ever carries compound rows this fails and
 * the decision gets revisited instead of quietly becoming wrong.
 */
describe('the classifier taxonomy holds species only', () => {
  it('has no row that parses as a hybrid or a slash', async () => {
    const { default: raw } = await import('../lib/taxonomy.json')
    const rows = raw as unknown[][]
    for (const row of rows) {
      const common = row[0] as string
      expect(await getCompoundSpecies(`${common} (${row[1] as string})`), common).toBeUndefined()
    }
  })

  it('has no parenthetical, separator or sp. in any common name', async () => {
    const { default: raw } = await import('../lib/taxonomy.json')
    const offenders = (raw as unknown[][])
      .map(row => row[0] as string)
      .filter(name => /[()/]| x |sp\.$/.test(name))
    expect(offenders).toEqual([])
  })
})
