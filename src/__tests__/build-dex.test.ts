import { describe, it, expect } from 'vitest'
import { buildDexFromState } from '@/hooks/use-wingdex-data'
import type { Outing, Observation, DexEntry } from '@/lib/types'

// ── Helpers ─────────────────────────────────────────────────

function makeOuting(overrides: Partial<Outing> = {}): Outing {
  return {
    id: 'outing-1',
    userId: 'u1',
    startTime: '2025-06-01T08:00:00Z',
    endTime: '2025-06-01T10:00:00Z',
    locationName: 'Test Park',
    notes: '',
    createdAt: '2025-06-01T08:00:00Z',
    ...overrides,
  }
}

function makeObs(overrides: Partial<Observation> = {}): Observation {
  return {
    id: 'obs-1',
    outingId: 'outing-1',
    speciesName: 'Blue Jay',
    count: 1,
    certainty: 'confirmed',
    notes: '',
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────

describe('buildDexFromState', () => {
  it('returns empty array for no observations', () => {
    expect(buildDexFromState([makeOuting()], [], [])).toEqual([])
  })

  it('returns empty array for no outings', () => {
    const obs = [makeObs()]
    // Observation references outing-1 which doesn't exist → skipped
    expect(buildDexFromState([], obs, [])).toEqual([])
  })

  it('creates a dex entry for a single confirmed observation', () => {
    const outings = [makeOuting()]
    const observations = [makeObs()]
    const result = buildDexFromState(outings, observations, [])

    expect(result).toHaveLength(1)
    expect(result[0].speciesName).toBe('Blue Jay')
    expect(result[0].totalCount).toBe(1)
    expect(result[0].totalOutings).toBe(1)
    expect(result[0].firstSeenDate).toBe('2025-06-01T08:00:00Z')
    expect(result[0].lastSeenDate).toBe('2025-06-01T08:00:00Z')
  })

  it('includes possible observations but skips pending and rejected', () => {
    const outings = [makeOuting()]
    const observations = [
      makeObs({ certainty: 'possible' }),
      makeObs({ id: 'obs-2', certainty: 'rejected' }),
      makeObs({ id: 'obs-3', certainty: 'pending' }),
    ]
    const result = buildDexFromState(outings, observations, [])
    expect(result).toHaveLength(1)
    expect(result[0].totalCount).toBe(1)
  })

  it('aggregates count and outings across multiple observations', () => {
    const outings = [
      makeOuting({ id: 'outing-1', startTime: '2025-06-01T08:00:00Z' }),
      makeOuting({ id: 'outing-2', startTime: '2025-07-15T09:00:00Z' }),
    ]
    const observations = [
      makeObs({ id: 'obs-1', outingId: 'outing-1', count: 3 }),
      makeObs({ id: 'obs-2', outingId: 'outing-2', count: 5 }),
    ]
    const result = buildDexFromState(outings, observations, [])

    expect(result).toHaveLength(1)
    expect(result[0].totalCount).toBe(8)
    expect(result[0].totalOutings).toBe(2)
  })

  it('computes firstSeenDate and lastSeenDate correctly', () => {
    const outings = [
      makeOuting({ id: 'outing-1', startTime: '2025-08-01T08:00:00Z' }),
      makeOuting({ id: 'outing-2', startTime: '2025-03-15T09:00:00Z' }),
      makeOuting({ id: 'outing-3', startTime: '2025-12-20T14:00:00Z' }),
    ]
    const observations = [
      makeObs({ id: 'obs-1', outingId: 'outing-1' }),
      makeObs({ id: 'obs-2', outingId: 'outing-2' }),
      makeObs({ id: 'obs-3', outingId: 'outing-3' }),
    ]
    const result = buildDexFromState(outings, observations, [])

    expect(result[0].firstSeenDate).toBe('2025-03-15T09:00:00Z')
    expect(result[0].lastSeenDate).toBe('2025-12-20T14:00:00Z')
  })

  it('preserves addedDate and notes from existing dex entries', () => {
    const outings = [makeOuting()]
    const observations = [makeObs()]
    const existingDex: DexEntry[] = [{
      id: 'name:Blue Jay',
      speciesName: 'Blue Jay',
      firstSeenDate: '2025-01-01T00:00:00Z',
      lastSeenDate: '2025-01-01T00:00:00Z',
      addedDate: '2025-01-01T12:00:00Z',
      totalOutings: 1,
      totalCount: 1,
      notes: 'My favorite bird',
    }]
    const result = buildDexFromState(outings, observations, existingDex)

    expect(result[0].addedDate).toBe('2025-01-01T12:00:00Z')
    expect(result[0].notes).toBe('My favorite bird')
  })

  it('preserves bestPhotoId from latest observation with photo', () => {
    const outings = [makeOuting()]
    const observations = [
      makeObs({ id: 'obs-1', representativePhotoId: 'photo-1' }),
      makeObs({ id: 'obs-2', representativePhotoId: 'photo-2' }),
    ]
    const result = buildDexFromState(outings, observations, [])
    // The last one with a photo wins (reversed search finds obs-2 first)
    expect(result[0].bestPhotoId).toBe('photo-2')
  })

  it('sorts results alphabetically by speciesName', () => {
    const outings = [makeOuting()]
    const observations = [
      makeObs({ id: 'obs-1', speciesName: 'Red-tailed Hawk' }),
      makeObs({ id: 'obs-2', speciesName: 'American Robin' }),
      makeObs({ id: 'obs-3', speciesName: 'Blue Jay' }),
    ]
    const result = buildDexFromState(outings, observations, [])

    expect(result.map(e => e.speciesName)).toEqual([
      'American Robin',
      'Blue Jay',
      'Red-tailed Hawk',
    ])
  })

  it('counts unique outings correctly when same outing has multiple observations of same species', () => {
    const outings = [makeOuting()]
    const observations = [
      makeObs({ id: 'obs-1', outingId: 'outing-1', count: 2 }),
      makeObs({ id: 'obs-2', outingId: 'outing-1', count: 3 }),
    ]
    const result = buildDexFromState(outings, observations, [])

    expect(result[0].totalCount).toBe(5)
    // Same outing, so unique outings = 1
    expect(result[0].totalOutings).toBe(1)
  })

  it('consolidates observations from CSV import, photo upload, and manual add into one dex entry when names use canonical format', () => {
    const outings = [makeOuting()]
    const observations = [
      // Simulates CSV import (always "Common Name (Scientific Name)")
      makeObs({ id: 'obs-csv', speciesName: 'Great Blue Heron (Ardea herodias)', count: 2, notes: 'Imported from eBird' }),
      // Simulates AI photo upload (also "Common Name (Scientific Name)")
      makeObs({ id: 'obs-upload', speciesName: 'Great Blue Heron (Ardea herodias)', count: 1, representativePhotoId: 'photo-1' }),
      // Simulates manual add (now normalized to same format via findBestMatch)
      makeObs({ id: 'obs-manual', speciesName: 'Great Blue Heron (Ardea herodias)', count: 1, notes: 'Manually added' }),
    ]
    const result = buildDexFromState(outings, observations, [])

    // All three should converge into a single dex entry
    expect(result).toHaveLength(1)
    expect(result[0].speciesName).toBe('Great Blue Heron (Ardea herodias)')
    expect(result[0].totalCount).toBe(4)
    expect(result[0].totalOutings).toBe(1)
    expect(result[0].bestPhotoId).toBe('photo-1')
  })
})
