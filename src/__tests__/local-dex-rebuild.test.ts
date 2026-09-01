import { describe, it, expect } from 'vitest'
import { rebuildDexFromState } from '@/hooks/use-wingdex-data'
import type { DexEntry, Observation, Outing } from '@/lib/types'

/**
 * The local-mode rebuild has to agree with DEX_QUERY on identity, or a species
 * merges one way offline and splits the other.
 */
const outing = (id: string, startTime: string): Outing => ({
  id, userId: 'u1', startTime, endTime: startTime, locationName: 'Somewhere', notes: '',
} as Outing)

const obs = (id: string, outingId: string, speciesName: string, speciesCode?: string): Observation => ({
  id, outingId, speciesName, count: 1, certainty: 'confirmed', notes: '',
  ...(speciesCode ? { speciesCode } : {}),
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
})
