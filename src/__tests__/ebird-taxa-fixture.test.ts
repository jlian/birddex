import { readFileSync } from 'node:fs'
import Papa from 'papaparse'
import { describe, expect, it } from 'vitest'

import {
  exportOutingToEBirdCSV,
  parseEBirdCSV,
} from '../../functions/lib/ebird'
import {
  findCompoundTaxon,
  resolveSpeciesIdentity,
} from '../../functions/lib/taxonomy'
import taxonomy from '@/lib/taxonomy.json'
import extra from '@/lib/taxonomy-extra.json'

type Category = 'species' | 'issf' | 'slash' | 'hybrid' | 'spuh' | 'form' | 'intergrade' | 'domestic'

type ManifestEntry = {
  code: string
  common: string
  scientific: string
  stored: string
  category: Category
  order: string
  reportAs: string
}

type FixtureRow = {
  'Submission ID': string
  'Common Name': string
  'Scientific Name': string
  'Taxonomic Order': string
  Count: string
}

const FIXTURE_PATH = 'e2e/fixtures/ebird-import-taxa.csv'
const EXPECTED_HEADERS = [
  'Submission ID', 'Common Name', 'Scientific Name', 'Taxonomic Order', 'Count',
  'State/Province', 'County', 'Location ID', 'Location', 'Latitude', 'Longitude',
  'Date', 'Time', 'Protocol', 'Duration (Min)', 'All Obs Reported',
  'Distance Traveled (km)', 'Area Covered (ha)', 'Number of Observers',
  'Breeding Code', 'Observation Details', 'Checklist Comments', 'ML Catalog Numbers',
]

const EXPECTED_CATEGORY_COUNTS: Record<Category, number> = {
  species: 4,
  issf: 3,
  slash: 4,
  hybrid: 4,
  spuh: 3,
  form: 2,
  intergrade: 2,
  domestic: 3,
}

const MANIFEST: ManifestEntry[] = [
  { code: 'gybbra1', common: 'Brant (Gray-bellied)', scientific: 'Branta bernicla (Gray-bellied)', stored: 'Brant (Gray-bellied)', category: 'form', order: '318.0', reportAs: 'brant' },
  { code: 'rocpig2', common: 'Rock Pigeon (Wild type)', scientific: 'Columba livia (Wild type)', stored: 'Rock Pigeon (Wild type)', category: 'form', order: '1854.0', reportAs: 'rocpig' },
  { code: 'whwsco', common: "Velvet/White-winged/Stejneger's Scoter", scientific: 'Melanitta fusca/deglandi/stejnegeri', stored: "Velvet/White-winged/Stejneger's Scoter (Melanitta fusca/deglandi/stejnegeri)", category: 'slash', order: '734.0', reportAs: '' },
  { code: 'y00934', common: 'Common/Somali Ostrich', scientific: 'Struthio camelus/molybdophanes', stored: 'Common/Somali Ostrich (Struthio camelus/molybdophanes)', category: 'slash', order: '8.0', reportAs: '' },
  { code: 'y01112', common: 'Rock/Hill Pigeon', scientific: 'Columba livia/rupestris', stored: 'Rock/Hill Pigeon (Columba livia/rupestris)', category: 'slash', order: '1872.0', reportAs: '' },
  { code: 'y00656', common: 'Western/Glaucous-winged Gull', scientific: 'Larus occidentalis/glaucescens', stored: 'Western/Glaucous-winged Gull (Larus occidentalis/glaucescens)', category: 'slash', order: '6601.0', reportAs: '' },
  { code: 'x00999', common: 'Baikal x Green-winged Teal (hybrid)', scientific: 'Sibirionetta formosa x Anas crecca', stored: 'Baikal x Green-winged Teal (hybrid)', category: 'hybrid', order: '616.0', reportAs: '' },
  { code: 'x01088', common: 'Greater White-fronted x Cackling/Canada Goose (hybrid)', scientific: 'Anser albifrons x Branta hutchinsii/canadensis', stored: 'Greater White-fronted x Cackling/Canada Goose (hybrid)', category: 'hybrid', order: '357.0', reportAs: '' },
  { code: 'x00051', common: 'Western x Glaucous-winged Gull (hybrid)', scientific: 'Larus occidentalis x glaucescens', stored: 'Western x Glaucous-winged Gull (hybrid)', category: 'hybrid', order: '6597.0', reportAs: '' },
  { code: 'x00414', common: 'Greater White-fronted x Cackling Goose (hybrid)', scientific: 'Anser albifrons x Branta hutchinsii', stored: 'Greater White-fronted x Cackling Goose (hybrid)', category: 'hybrid', order: '340.0', reportAs: '' },
  { code: 'dodo1', common: 'Dodo', scientific: 'Raphus cucullatus', stored: 'Dodo (Raphus cucullatus)', category: 'species', order: '2427.0', reportAs: '' },
  { code: 'rocpig', common: 'Rock Pigeon', scientific: 'Columba livia', stored: 'Rock Pigeon (Columba livia)', category: 'species', order: '1853.0', reportAs: '' },
  { code: 'amerob', common: 'American Robin', scientific: 'Turdus migratorius', stored: 'American Robin (Turdus migratorius)', category: 'species', order: '28633.0', reportAs: '' },
  { code: 'rethaw', common: 'Red-tailed Hawk', scientific: 'Buteo jamaicensis', stored: 'Red-tailed Hawk (Buteo jamaicensis)', category: 'species', order: '8506.0', reportAs: '' },
  { code: 'sobkiw2', common: 'Southern Brown Kiwi (South I.)', scientific: 'Apteryx australis australis', stored: 'Southern Brown Kiwi (South I.)', category: 'issf', order: '22.0', reportAs: 'sobkiw1' },
  { code: 'orejun', common: 'Dark-eyed Junco (Oregon)', scientific: 'Junco hyemalis [oreganus Group]', stored: 'Dark-eyed Junco (Oregon)', category: 'issf', order: '33130.0', reportAs: 'daejun' },
  { code: 'comwop1', common: 'Common Wood-Pigeon (White-necked)', scientific: 'Columba palumbus [palumbus Group]', stored: 'Common Wood-Pigeon (White-necked)', category: 'issf', order: '1886.0', reportAs: 'cowpig1' },
  { code: 'daejun3', common: 'Dark-eyed Junco (Oregon x Pink-sided)', scientific: 'Junco hyemalis [oreganus Group] x mearnsi', stored: 'Dark-eyed Junco (Oregon x Pink-sided)', category: 'intergrade', order: '33139.0', reportAs: 'daejun' },
  { code: 'daejun8', common: 'Dark-eyed Junco (Oregon x Gray-headed)', scientific: 'Junco hyemalis [oreganus Group] x caniceps', stored: 'Dark-eyed Junco (Oregon x Gray-headed)', category: 'intergrade', order: '33143.0', reportAs: 'daejun' },
  { code: 'larus', common: 'gull sp.', scientific: 'Larinae sp.', stored: 'gull sp. (Larinae sp.)', category: 'spuh', order: '6619.0', reportAs: '' },
  { code: 'passer1', common: 'passerine sp.', scientific: 'Passeriformes sp.', stored: 'passerine sp. (Passeriformes sp.)', category: 'spuh', order: '35852.0', reportAs: '' },
  { code: 'hummin', common: 'hummingbird sp.', scientific: 'Trochilidae sp.', stored: 'hummingbird sp. (Trochilidae sp.)', category: 'spuh', order: '5214.0', reportAs: '' },
  { code: 'mallar2', common: 'Mallard (Domestic type)', scientific: 'Anas platyrhynchos (Domestic type)', stored: 'Mallard (Domestic type)', category: 'domestic', order: '548.0', reportAs: 'mallar3' },
  { code: 'domgoo1', common: 'Domestic goose sp. (Domestic type)', scientific: 'Anser sp. (Domestic type)', stored: 'Domestic goose sp. (Domestic type)', category: 'domestic', order: '312.0', reportAs: '' },
  { code: 'rocpig1', common: 'Rock Pigeon (Feral Pigeon)', scientific: 'Columba livia (Feral Pigeon)', stored: 'Rock Pigeon (Feral Pigeon)', category: 'domestic', order: '1868.0', reportAs: 'rocpig' },
]

const fixtureCsv = readFileSync(FIXTURE_PATH, 'utf8')
const source = Papa.parse<FixtureRow>(fixtureCsv, { header: true, skipEmptyLines: 'greedy' })
const previews = parseEBirdCSV(fixtureCsv)

describe('diverse eBird taxonomy fixture', () => {
  it('matches the checked-in taxonomy and preserves exact identities through export', () => {
    expect(source.errors).toEqual([])
    expect(source.meta.fields).toEqual(EXPECTED_HEADERS)
    expect(source.data).toHaveLength(25)
    expect(previews).toHaveLength(25)
    expect(new Set(previews.map(row => row.submissionId)).size).toBe(3)
    expect(previews.map(row => row.speciesName)).toEqual(MANIFEST.map(entry => entry.stored))

    const checkedIn = new Map<string, { common: string; scientific: string; category: Category; order?: number; reportAs: string }>()
    for (const [common, scientific, code] of taxonomy as unknown as string[][]) {
      checkedIn.set(code, { common, scientific, category: 'species', reportAs: '' })
    }
    for (const [code, common, scientific, category, order, reportAs] of extra.entries as [string, string, string, Category, number, string][]) {
      checkedIn.set(code, { common, scientific, category, order, reportAs })
    }

    const categoryCounts = Object.fromEntries(
      Object.keys(EXPECTED_CATEGORY_COUNTS).map(category => [
        category,
        MANIFEST.filter(entry => entry.category === category).length,
      ])
    )
    expect(categoryCounts).toEqual(EXPECTED_CATEGORY_COUNTS)

    MANIFEST.forEach((expected, index) => {
      const fixtureRow = source.data[index]
      const preview = previews[index]
      const bundled = checkedIn.get(expected.code)

      expect(fixtureRow).toMatchObject({
        'Common Name': expected.common,
        'Scientific Name': expected.scientific,
        'Taxonomic Order': expected.order,
      })
      expect(bundled).toMatchObject({
        common: expected.common,
        scientific: expected.scientific,
        category: expected.category,
        reportAs: expected.reportAs,
      })
      if (bundled?.order != null) expect(String(bundled.order)).toBe(expected.order.replace(/\.0$/, ''))

      expect(resolveSpeciesIdentity(preview.speciesName)).toEqual({
        taxonCode: expected.code,
        speciesCode: expected.reportAs || expected.code,
      })

      const exported = exportOutingToEBirdCSV({
        id: `taxa-${index}`,
        startTime: preview.date,
        locationName: preview.location,
        lat: preview.lat,
        lon: preview.lon,
        stateProvince: preview.stateProvince,
        protocol: preview.protocol,
        numberObservers: preview.numberObservers,
        allObsReported: preview.allObsReported,
      }, [{
        speciesName: preview.speciesName,
        taxonCode: expected.code,
        count: preview.count,
        certainty: 'confirmed',
        notes: preview.observationNotes,
        submissionId: preview.submissionId,
      }], false)
      const [exportedRow] = Papa.parse<string[]>(exported).data
      const [genus, ...species] = expected.scientific.split(/\s+/)

      expect(exportedRow.slice(1, 4)).toEqual([expected.common, genus, species.join(' ')])
    })
  })

  it('parses resolvable compounds and rejects spuhs and nested compounds', () => {
    expect(findCompoundTaxon("Velvet/White-winged/Stejneger's Scoter")?.parents.map(parent => parent.common))
      .toEqual(['Velvet Scoter', 'White-winged Scoter', "Stejneger's Scoter"])
    expect(findCompoundTaxon('Common/Somali Ostrich')?.parents.map(parent => parent.common))
      .toEqual(['Common Ostrich', 'Somali Ostrich'])
    expect(findCompoundTaxon('Baikal x Green-winged Teal (hybrid)')?.parents.map(parent => parent.common))
      .toEqual(['Baikal Teal', 'Green-winged Teal'])
    expect(findCompoundTaxon('Western x Glaucous-winged Gull (hybrid)')?.parents.map(parent => parent.common))
      .toEqual(['Western Gull', 'Glaucous-winged Gull'])
    expect(findCompoundTaxon('Greater White-fronted x Cackling/Canada Goose (hybrid)')).toBeNull()
    expect(findCompoundTaxon('passerine sp. (Passeriformes sp.)')).toBeNull()
    expect(findCompoundTaxon('gull sp. (Larinae sp.)')).toBeNull()
  })
})