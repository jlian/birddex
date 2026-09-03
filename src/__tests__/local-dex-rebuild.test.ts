import { describe, it, expect } from 'vitest'
import { applyLocalObservationUpdates, enrichLocalDex, rebuildDexFromState } from '@/hooks/use-wingdex-data'
import { getTaxonMetadataByCode } from '@/lib/taxonomy-order'
import type { DexEntry, Observation, Outing } from '@/lib/types'

/**
 * The local-mode rebuild has to agree with DEX_QUERY on identity, or a species
 * merges one way offline and splits the other.
 */
const outing = (id: string, startTime: string): Outing => ({
  id, userId: 'u1', startTime, endTime: startTime, locationName: 'Somewhere', notes: '',
} as Outing)

const obs = (id: string, outingId: string, speciesName: string, speciesCode?: string, taxonCode?: string): Observation => ({
  id, outingId, speciesName, count: 1, certainty: 'confirmed', notes: '',
  ...(speciesCode ? { speciesCode } : {}),
  ...(taxonCode ? { taxonCode } : {}),
} as Observation)

describe('rebuildDexFromState', () => {
  it('keeps addedDate and notes when MIN(speciesName) changes within one group', () => {
    // The bug: an entry was looked up by display name, so adding a spelling
    // that sorts earlier relabelled the group, missed the lookup, and reset
    // addedDate to now while dropping notes.
    const outings = [outing('o1', '2025-01-01T00:00:00Z'), outing('o2', '2025-02-01T00:00:00Z')]
    const observations = [
      obs('ob1', 'o1', 'Mallard (Anas platyrhynchos)', 'mallar3'),
      obs('ob2', 'o2', 'Common Mallard', 'mallar3'),
    ]
    const existing: DexEntry[] = [{
      id: 'code:mallar3',
      speciesName: 'Mallard (Anas platyrhynchos)',
      firstSeenDate: '2025-01-01T00:00:00Z',
      lastSeenDate: '2025-01-01T00:00:00Z',
      addedDate: '2024-06-15T12:00:00Z',
      totalOutings: 1,
      totalCount: 1,
      notes: 'first lifer',
    }]

    const rebuilt = rebuildDexFromState(outings, observations, existing)
    expect(rebuilt).toHaveLength(1)
    // "Common Mallard" sorts before "Mallard (...)", so the label MOVED.
    expect(rebuilt[0].speciesName).toBe('Common Mallard')
    expect(rebuilt[0].id).toBe('code:mallar3')
    expect(rebuilt[0].addedDate).toBe('2024-06-15T12:00:00Z')
    expect(rebuilt[0].notes).toBe('first lifer')
  })

  it('still matches an older local entry that predates the id field', () => {
    const outings = [outing('o1', '2025-01-01T00:00:00Z')]
    const observations = [obs('ob1', 'o1', 'Northern Cardinal')]
    const legacy = [{
      speciesName: 'Northern Cardinal',
      firstSeenDate: '2025-01-01T00:00:00Z',
      lastSeenDate: '2025-01-01T00:00:00Z',
      addedDate: '2023-03-03T00:00:00Z',
      totalOutings: 1,
      totalCount: 1,
      notes: 'kept',
    } as unknown as DexEntry]

    const rebuilt = rebuildDexFromState(outings, observations, legacy)
    expect(rebuilt[0].addedDate).toBe('2023-03-03T00:00:00Z')
    expect(rebuilt[0].notes).toBe('kept')
  })

  it('groups two spellings sharing a code into one entry', () => {
    const outings = [outing('o1', '2025-01-01T00:00:00Z'), outing('o2', '2025-02-01T00:00:00Z')]
    const observations = [
      obs('ob1', 'o1', 'Mallard', 'mallar3'),
      obs('ob2', 'o2', 'Mallard (Anas platyrhynchos)', 'mallar3'),
    ]
    const rebuilt = rebuildDexFromState(outings, observations, [])
    expect(rebuilt).toHaveLength(1)
    expect(rebuilt[0].id).toBe('code:mallar3')
    expect(rebuilt[0].totalCount).toBe(2)
  })

  it('merges metadata from legacy aliases that collapse into one coded group', () => {
    const outings = [outing('o1', '2025-01-01T00:00:00Z'), outing('o2', '2025-02-01T00:00:00Z')]
    const observations = [
      obs('ob1', 'o1', 'Mallard', 'mallar3'),
      obs('ob2', 'o2', 'Mallard (Anas platyrhynchos)', 'mallar3'),
    ]
    const legacy = [
      {
        id: 'name:Mallard',
        speciesName: 'Mallard',
        addedDate: '2024-02-01T00:00:00Z',
        bestPhotoId: 'photo-b',
        notes: 'pond',
      },
      {
        id: 'name:Mallard (Anas platyrhynchos)',
        speciesName: 'Mallard (Anas platyrhynchos)',
        addedDate: '2024-01-01T00:00:00Z',
        bestPhotoId: 'photo-a',
        notes: 'lifer',
      },
    ].map(entry => ({
      firstSeenDate: '2025-01-01T00:00:00Z',
      lastSeenDate: '2025-01-01T00:00:00Z',
      totalOutings: 1,
      totalCount: 1,
      ...entry,
    } as DexEntry))

    const [rebuilt] = rebuildDexFromState(outings, observations, legacy)
    expect(rebuilt).toMatchObject({
      id: 'code:mallar3',
      addedDate: '2024-01-01T00:00:00Z',
      bestPhotoId: 'photo-a',
      notes: 'lifer\n\npond',
    })
  })

  it.each([
    ['coded first', true],
    ['uncoded first', false],
  ])('maps legacy metadata to the unique coded group with %s', (_label, codedFirst) => {
    const outings = [outing('o1', '2025-01-01T00:00:00Z'), outing('o2', '2025-02-01T00:00:00Z')]
    const coded = obs('coded', 'o1', 'Mallard', 'mallar3')
    const uncoded = obs('uncoded', 'o2', 'Mallard')
    const legacy = [{
      id: 'name:Mallard',
      speciesName: 'Mallard',
      firstSeenDate: '2025-01-01T00:00:00Z',
      lastSeenDate: '2025-01-01T00:00:00Z',
      totalOutings: 1,
      totalCount: 1,
      notes: 'coded metadata',
    } as DexEntry]

    const rebuilt = rebuildDexFromState(
      outings,
      codedFirst ? [coded, uncoded] : [uncoded, coded],
      legacy,
    )
    expect(rebuilt.find(entry => entry.id === 'code:mallar3')?.notes).toBe('coded metadata')
    expect(rebuilt.find(entry => entry.id === 'name:Mallard')?.notes).toBe('')
  })

  it('keeps uncoded species in their own name-keyed group', () => {
    const outings = [outing('o1', '2025-01-01T00:00:00Z')]
    const observations = [obs('ob1', 'o1', 'Mystery Bird')]
    const rebuilt = rebuildDexFromState(outings, observations, [])
    expect(rebuilt[0].id).toBe('name:Mystery Bird')
  })

  it('includes possible observations like the server dex query', () => {
    const outings = [outing('o1', '2025-01-01T00:00:00Z')]
    const possible = { ...obs('ob1', 'o1', 'Northern Cardinal', 'norcar'), certainty: 'possible' as const }
    const rebuilt = rebuildDexFromState(outings, [possible], [])
    expect(rebuilt).toHaveLength(1)
    expect(rebuilt[0].id).toBe('code:norcar')
  })

  it('uses grouping metadata when a group contains multiple exact taxa', async () => {
    await getTaxonMetadataByCode('sobkiw2')
    const outings = [outing('o1', '2025-01-01T00:00:00Z'), outing('o2', '2025-02-01T00:00:00Z')]
    const observations = [
      obs('ob1', 'o1', 'Southern Brown Kiwi', 'sobkiw1', 'sobkiw1'),
      obs('ob2', 'o2', 'Southern Brown Kiwi (South I.)', 'sobkiw1', 'sobkiw2'),
    ]

    const rebuilt = rebuildDexFromState(outings, observations, [])
    expect(rebuilt[0]).toMatchObject({
      speciesName: 'Southern Brown Kiwi',
      speciesCode: 'sobkiw1',
      commonName: 'Southern Brown Kiwi',
      scientificName: 'Apteryx australis',
    })
    expect(rebuilt[0].taxonCode).toBe('sobkiw1')
  })

  it.each([
    ['unanimous exact codes', ['sobkiw2', 'sobkiw2'], 'sobkiw2'],
    ['known and missing exact codes', ['sobkiw2', undefined], 'sobkiw1'],
    ['all missing exact codes', [undefined, undefined], 'sobkiw1'],
  ] as const)('uses consensus identity for %s', (_label, taxonCodes, expected) => {
    const outings = [outing('o1', '2025-01-01T00:00:00Z'), outing('o2', '2025-02-01T00:00:00Z')]
    const observations = taxonCodes.map((taxonCode, index) =>
      obs(`ob${index}`, `o${index + 1}`, `Kiwi label ${index}`, 'sobkiw1', taxonCode)
    )

    expect(rebuildDexFromState(outings, observations, [])[0].taxonCode).toBe(expected)
  })
})

describe('enrichLocalDex', () => {
  it('assigns stable ids to legacy coded and uncoded entries before render', async () => {
    const makeLegacy = (speciesName: string, speciesCode?: string) => ({
      speciesName,
      ...(speciesCode ? { speciesCode } : {}),
      firstSeenDate: '2025-01-01T00:00:00Z',
      lastSeenDate: '2025-01-01T00:00:00Z',
      addedDate: '2025-01-01T00:00:00Z',
      totalOutings: 0,
      totalCount: 1,
      notes: '',
    } as unknown as DexEntry)

    const payload = await enrichLocalDex({
      outings: [],
      photos: [],
      observations: [],
      dex: [makeLegacy('Mallard', 'mallar3'), makeLegacy('Mystery Bird')],
    })

    expect(payload.dex.map(entry => entry.id)).toEqual(['code:mallar3', 'name:Mystery Bird'])
  })

  it('migrates legacy observations before rebuilding so new coded rows do not split the species', async () => {
    const legacyDex = {
      id: 'name:Mallard',
      speciesName: 'Mallard',
      firstSeenDate: '2025-01-01T00:00:00Z',
      lastSeenDate: '2025-01-01T00:00:00Z',
      totalOutings: 1,
      totalCount: 1,
      notes: 'legacy notes',
    } as DexEntry
    const payload = await enrichLocalDex({
      outings: [outing('o1', '2025-01-01T00:00:00Z'), outing('o2', '2025-02-01T00:00:00Z')],
      photos: [],
      observations: [
        obs('legacy', 'o1', 'Mallard'),
        obs('new', 'o2', 'Mallard', 'mallar3', 'mallar3'),
      ],
      dex: [legacyDex],
    })

    expect(payload.observations.every(observation => observation.speciesCode === 'mallar3')).toBe(true)
    expect(payload.dex).toHaveLength(1)
    expect(payload.dex[0]).toMatchObject({ id: 'code:mallar3', totalCount: 2, totalOutings: 2 })
  })

  it('preserves dex-only entries while rebuilding migrated observation groups', async () => {
    const dexOnly = {
      id: 'name:Imported Lifer',
      speciesName: 'Imported Lifer',
      firstSeenDate: '2024-01-01T00:00:00Z',
      lastSeenDate: '2024-01-01T00:00:00Z',
      totalOutings: 0,
      totalCount: 0,
      notes: 'keep me',
    } as DexEntry
    const payload = await enrichLocalDex({
      outings: [outing('o1', '2025-01-01T00:00:00Z')],
      photos: [],
      observations: [obs('legacy', 'o1', 'Mallard')],
      dex: [dexOnly],
    })

    expect(payload.dex.map(entry => entry.id).sort()).toEqual(['code:mallar3', 'name:Imported Lifer'])
    expect(payload.dex.find(entry => entry.id === 'name:Imported Lifer')?.notes).toBe('keep me')
  })

  it('drops a stale name-keyed alias when its observation is already coded', async () => {
    const staleAlias = {
      id: 'name:Mallard',
      speciesName: 'Mallard',
      firstSeenDate: '2025-01-01T00:00:00Z',
      lastSeenDate: '2025-01-01T00:00:00Z',
      totalOutings: 1,
      totalCount: 1,
      notes: '',
    } as DexEntry
    const payload = await enrichLocalDex({
      outings: [outing('o1', '2025-01-01T00:00:00Z')],
      photos: [],
      observations: [obs('coded', 'o1', 'Mallard', 'mallar3', 'mallar3')],
      dex: [staleAlias],
    })

    expect(payload.dex.map(entry => entry.id)).toEqual(['code:mallar3'])
  })

  it('recomputes historically stale codes even when both fields are populated', async () => {
    const payload = await enrichLocalDex({
      outings: [outing('o1', '2025-01-01T00:00:00Z')],
      photos: [],
      observations: [obs('stale', 'o1', 'Northern Cardinal', 'mallar3', 'mallar3')],
      dex: [],
    })

    expect(payload.observations[0]).toMatchObject({
      speciesName: 'Northern Cardinal',
      speciesCode: 'norcar',
      taxonCode: 'norcar',
    })
    expect(payload.dex.map(entry => entry.id)).toEqual(['code:norcar'])
  })

  it('preserves stable persisted codes when an obsolete label no longer resolves', async () => {
    const payload = await enrichLocalDex({
      outings: [outing('o1', '2025-01-01T00:00:00Z')],
      photos: [],
      observations: [obs('legacy', 'o1', 'Retired Cardinal Label', 'norcar', 'norcar')],
      dex: [],
    })

    expect(payload.observations[0]).toMatchObject({
      speciesName: 'Retired Cardinal Label',
      speciesCode: 'norcar',
      taxonCode: 'norcar',
    })
    expect(payload.dex.map(entry => entry.id)).toEqual(['code:norcar'])
  })

  it('uses a legacy entry own species code without retaining its stale name alias', async () => {
    const payload = await enrichLocalDex({
      outings: [outing('o1', '2025-01-01T00:00:00Z')],
      photos: [],
      observations: [obs('current', 'o1', 'Mallard', 'mallar3', 'mallar3')],
      dex: [{
        id: 'name:Retired Mallard Label',
        speciesName: 'Retired Mallard Label',
        speciesCode: 'mallar3',
        firstSeenDate: '2024-01-01T00:00:00Z',
        lastSeenDate: '2024-01-01T00:00:00Z',
        totalOutings: 1,
        totalCount: 1,
        notes: 'keep this',
      } as DexEntry],
    })

    expect(payload.dex).toHaveLength(1)
    expect(payload.dex[0]).toMatchObject({ id: 'code:mallar3', notes: 'keep this' })
  })

  it('uses a coded legacy entry to merge an uncoded alias for an obsolete label', async () => {
    const dex = [
      {
        id: 'code:mallar3',
        speciesName: 'Retired Mallard Label',
        speciesCode: 'mallar3',
        notes: 'coded note',
      },
      {
        id: 'name:Retired Mallard Label',
        speciesName: 'Retired Mallard Label',
        notes: 'alias note',
      },
    ].map(entry => ({
        firstSeenDate: '2024-01-01T00:00:00Z',
        lastSeenDate: '2024-01-01T00:00:00Z',
        addedDate: '2024-01-01T00:00:00Z',
        totalOutings: 1,
        totalCount: 1,
        ...entry,
      } as DexEntry))
    const migrate = (entries: DexEntry[]) => enrichLocalDex({
      outings: [outing('o1', '2025-01-01T00:00:00Z')],
      photos: [],
      observations: [obs('current', 'o1', 'Mallard', 'mallar3', 'mallar3')],
      dex: entries,
    })
    const payload = await migrate(dex)
    const reversed = await migrate([...dex].reverse())

    expect(payload.dex).toHaveLength(1)
    expect(payload.dex[0]).toMatchObject({
      id: 'code:mallar3',
      notes: 'coded note\n\nalias note',
    })
    expect(reversed.dex).toEqual(payload.dex)
  })

  it('reconciles conflicting legacy exact codes to the grouping code in either order', () => {
    const outings = [outing('o1', '2025-01-01T00:00:00Z'), outing('o2', '2025-02-01T00:00:00Z')]
    const observations = [
      obs('south', 'o1', 'Southern Brown Kiwi (South I.)', 'sobkiw1', 'sobkiw2'),
      obs('stewart', 'o2', 'Southern Brown Kiwi (Stewart I.)', 'sobkiw1', 'sobkiw3'),
    ]
    const existing = ['sobkiw2', 'sobkiw3'].map(taxonCode => ({
      id: 'code:sobkiw1',
      speciesName: 'Southern Brown Kiwi',
      speciesCode: 'sobkiw1',
      taxonCode,
      firstSeenDate: '2024-01-01T00:00:00Z',
      lastSeenDate: '2024-01-01T00:00:00Z',
      addedDate: '2024-01-01T00:00:00Z',
      totalOutings: 1,
      totalCount: 1,
      notes: '',
    } as DexEntry))

    const forward = rebuildDexFromState(outings, observations, existing)
    const reversed = rebuildDexFromState(outings, observations, [...existing].reverse())
    expect(forward[0].taxonCode).toBe('sobkiw1')
    expect(reversed).toEqual(forward)
  })

  it('preserves a name-keyed alias when its coded observations are ambiguous', async () => {
    const payload = await enrichLocalDex({
      outings: [outing('o1', '2025-01-01T00:00:00Z'), outing('o2', '2025-02-01T00:00:00Z')],
      photos: [],
      observations: [
        obs('first', 'o1', 'Retired Shared Label', 'norcar', 'norcar'),
        obs('second', 'o2', 'Retired Shared Label', 'mallar3', 'mallar3'),
      ],
      dex: [{
        id: 'name:Retired Shared Label',
        speciesName: 'Retired Shared Label',
        firstSeenDate: '2024-01-01T00:00:00Z',
        lastSeenDate: '2024-01-01T00:00:00Z',
        totalOutings: 0,
        totalCount: 0,
        notes: 'unassigned metadata',
      } as DexEntry],
    })

    expect(payload.dex.map(entry => entry.id).sort()).toEqual([
      'code:mallar3',
      'code:norcar',
      'name:Retired Shared Label',
    ])
    expect(payload.dex.find(entry => entry.id === 'name:Retired Shared Label')?.notes)
      .toBe('unassigned metadata')

    const afterUpdate = rebuildDexFromState(payload.outings, payload.observations, payload.dex)
    expect(afterUpdate.find(entry => entry.id === 'name:Retired Shared Label')?.notes)
      .toBe('unassigned metadata')
  })

  it('drops an unmatched derived row after its final observation is removed', () => {
    const stale = {
      id: 'code:mallar3',
      speciesName: 'Mallard',
      speciesCode: 'mallar3',
      firstSeenDate: '2024-01-01T00:00:00Z',
      lastSeenDate: '2024-01-01T00:00:00Z',
      totalOutings: 1,
      totalCount: 1,
      notes: '',
    } as DexEntry

    expect(rebuildDexFromState([], [], [stale])).toEqual([])
  })

  it('uses the current observation mapping over stale coded dex candidates in one pass', () => {
    const outings = [outing('o1', '2025-01-01T00:00:00Z')]
    const observations = [obs('current', 'o1', 'Retired Shared Label', 'norcar', 'norcar')]
    const existing = [
      {
        id: 'code:mallar3',
        speciesName: 'Retired Shared Label',
        speciesCode: 'mallar3',
        totalOutings: 1,
        notes: '',
      },
      {
        id: 'name:Retired Shared Label',
        speciesName: 'Retired Shared Label',
        totalOutings: 1,
        notes: 'current metadata',
      },
    ].map(entry => ({
      firstSeenDate: '2024-01-01T00:00:00Z',
      lastSeenDate: '2024-01-01T00:00:00Z',
      totalCount: 1,
      ...entry,
    } as DexEntry))

    const first = rebuildDexFromState(outings, observations, existing)
    const second = rebuildDexFromState(outings, observations, first)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ id: 'code:norcar', notes: 'current metadata' })
    expect(second).toEqual(first)
  })
})

describe('applyLocalObservationUpdates', () => {
  it('recomputes identity when a local observation is renamed', async () => {
    const renamed = await applyLocalObservationUpdates(
      obs('ob1', 'o1', 'Mallard', 'mallar3', 'mallar3'),
      { speciesName: 'Northern Cardinal' },
    )

    expect(renamed).toMatchObject({
      speciesName: 'Northern Cardinal',
      speciesCode: 'norcar',
      taxonCode: 'norcar',
    })
  })

  it('clears stale identity when a local rename is unresolved', async () => {
    const renamed = await applyLocalObservationUpdates(
      obs('ob1', 'o1', 'Mallard', 'mallar3', 'mallar3'),
      { speciesName: 'Mystery Bird' },
    )

    expect(renamed.speciesCode).toBeUndefined()
    expect(renamed.taxonCode).toBeUndefined()
  })
})
