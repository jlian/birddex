import { describe, it, expect, vi } from 'vitest'
import {
  needsCloseConfirmation,
  resolvePhotoResults,
  filterConfirmedResults,
  clusterHasSightings,
  groupResultsBySpecies,
  friendlyErrorMessage,
  normalizeLocationName,
  resolveInferenceCoordinates,
} from '@/lib/add-photos-helpers'
import type { FlowStep, PhotoResult } from '@/lib/add-photos-helpers'

// ── resolvePhotoResults (advanceToNextPhoto guard) ──────────

describe('resolvePhotoResults', () => {
  const fallback: PhotoResult[] = [
    { photoId: 'p1', species: 'Robin', confidence: 0.9, status: 'confirmed', count: 1 },
  ]

  it('returns the explicit array when given one', () => {
    const explicit: PhotoResult[] = [
      { photoId: 'p2', species: 'Blue Jay', confidence: 0.8, status: 'confirmed', count: 1 },
    ]
    expect(resolvePhotoResults(explicit, fallback)).toBe(explicit)
  })

  it('falls back when called with undefined', () => {
    expect(resolvePhotoResults(undefined, fallback)).toBe(fallback)
  })

  it('falls back when called with a MouseEvent (onClick bug)', () => {
    const mouseEvent = new MouseEvent('click')
    const result = resolvePhotoResults(mouseEvent, fallback)
    expect(result).toBe(fallback)
    expect(result).not.toBeInstanceOf(MouseEvent)
  })

  it('falls back for any non-array value', () => {
    expect(resolvePhotoResults('oops', fallback)).toBe(fallback)
    expect(resolvePhotoResults(42, fallback)).toBe(fallback)
    expect(resolvePhotoResults(null, fallback)).toBe(fallback)
  })
})

// ── filterConfirmedResults (saveOuting filtering) ───────────

describe('filterConfirmedResults', () => {
  it('keeps confirmed and possible, drops rejected and pending', () => {
    const results: PhotoResult[] = [
      { photoId: '1', species: 'A', confidence: 1, status: 'confirmed', count: 1 },
      { photoId: '2', species: 'B', confidence: 0.5, status: 'possible', count: 1 },
      { photoId: '3', species: 'C', confidence: 0, status: 'rejected', count: 1 },
      { photoId: '4', species: 'D', confidence: 0, status: 'pending', count: 1 },
    ]
    const kept = filterConfirmedResults(results)
    expect(kept).toHaveLength(2)
    expect(kept.map(r => r.species)).toEqual(['A', 'B'])
  })

  it('returns empty array for empty input', () => {
    expect(filterConfirmedResults([])).toHaveLength(0)
  })
})

// ── clusterHasSightings (whether the outing gets written at all) ──────────

describe('clusterHasSightings', () => {
  const result = (status: PhotoResult['status']): PhotoResult => ({
    photoId: '1', species: 'A', confidence: 1, status, count: 1,
  })

  it('is false when every photo was skipped', () => {
    expect(clusterHasSightings([result('rejected'), result('rejected')])).toBe(false)
  })

  it('is false for a cluster with no photos', () => {
    expect(clusterHasSightings([])).toBe(false)
  })

  it('is true when a bird was only marked possible', () => {
    expect(clusterHasSightings([result('possible')])).toBe(true)
  })

  it('is false when nothing got past pending', () => {
    expect(clusterHasSightings([result('pending')])).toBe(false)
  })

  it('is true when one photo was confirmed among skips', () => {
    expect(clusterHasSightings([result('rejected'), result('confirmed')])).toBe(true)
  })
})

// ── groupResultsBySpecies (saveOuting aggregation) ──────────

describe('groupResultsBySpecies', () => {
  it('averages the confidence of every photo of a species', () => {
    const grouped = groupResultsBySpecies([
      { photoId: '1', species: 'Robin', confidence: 0.9, status: 'confirmed', count: 2 },
      { photoId: '2', species: 'Robin', confidence: 0.5, status: 'possible', count: 3 },
    ])
    const robin = grouped.get('Robin')!
    expect(robin.aiConfidence).toBeCloseTo(0.7)
    expect(robin.count).toBe(5)
    // Status and representative photo stay with the first confirmed photo.
    expect(robin.status).toBe('confirmed')
    expect(robin.photoId).toBe('1')
  })

  it('keeps the confidence of a lone photo intact', () => {
    const grouped = groupResultsBySpecies([
      { photoId: '1', species: 'Robin', confidence: 0.42, status: 'confirmed', count: 1 },
    ])
    expect(grouped.get('Robin')!.aiConfidence).toBe(0.42)
  })

  it('groups each species separately', () => {
    const grouped = groupResultsBySpecies([
      { photoId: '1', species: 'Robin', confidence: 0.8, status: 'confirmed', count: 1 },
      { photoId: '2', species: 'Blue Jay', confidence: 0.2, status: 'possible', count: 1 },
    ])
    expect([...grouped.keys()]).toEqual(['Robin', 'Blue Jay'])
    expect(grouped.get('Blue Jay')!.aiConfidence).toBe(0.2)
  })

  it('returns an empty map for empty input', () => {
    expect(groupResultsBySpecies([]).size).toBe(0)
  })
})

// ── friendlyErrorMessage ────────────────────────────────────

describe('friendlyErrorMessage', () => {
  it('extracts message from a normal Error', () => {
    expect(friendlyErrorMessage(new Error('Something broke'))).toBe('Something broke')
  })

  it('returns generic message for non-Error values', () => {
    expect(friendlyErrorMessage('string error')).toBe('Species identification failed')
    expect(friendlyErrorMessage(null)).toBe('Species identification failed')
    expect(friendlyErrorMessage(undefined)).toBe('Species identification failed')
  })

  it('returns rate-limit message for 429 errors', () => {
    const msg = friendlyErrorMessage(new Error('LLM 429: Too Many Requests'))
    expect(msg).toContain('rate limit')
    expect(msg).toContain('wait')
  })

  it('returns rate-limit message when error mentions "rate"', () => {
    const msg = friendlyErrorMessage(new Error('rate limit exceeded'))
    expect(msg).toContain('rate limit')
  })
})

// ── needsCloseConfirmation ──────────────────────────────────

describe('needsCloseConfirmation', () => {
  it('returns false for the initial upload step', () => {
    expect(needsCloseConfirmation('upload')).toBe(false)
  })

  it('returns false for the complete step', () => {
    expect(needsCloseConfirmation('complete')).toBe(false)
  })

  it.each([
    'extracting',
    'review',
    'photo-manual-crop',
    'photo-processing',
    'photo-confirm',
  ] as FlowStep[])('returns true for mid-flow step "%s"', (step) => {
    expect(needsCloseConfirmation(step)).toBe(true)
  })
})

// ── location context helpers ───────────────────────────────

describe('normalizeLocationName', () => {
  it('returns trimmed location names', () => {
    expect(normalizeLocationName('  Seattle, WA  ')).toBe('Seattle, WA')
  })

  it('drops granular leading POI labels when city/state are present', () => {
    expect(normalizeLocationName('South Beach Trail, Seattle, Washington')).toBe('Seattle, Washington')
    expect(normalizeLocationName('Parking Lot C, Seattle, Washington')).toBe('Seattle, Washington')
  })

  it('keeps meaningful park-level names', () => {
    expect(normalizeLocationName('Discovery Park, Seattle, Washington')).toBe('Discovery Park, Seattle, Washington')
  })

  it('returns empty string for unknown location', () => {
    expect(normalizeLocationName('Unknown Location')).toBe('')
    expect(normalizeLocationName('   ')).toBe('')
  })
})

describe('resolveInferenceCoordinates', () => {
  const exif = { lat: 48.9801, lon: -122.7887 }
  const searched = { lat: 47.6615, lon: -122.4256 }

  it('falls back to the searched outing location when the photo has no EXIF GPS', () => {
    expect(resolveInferenceCoordinates(true, undefined, searched, true)).toEqual(searched)
  })

  it('uses an explicit searched-location correction over EXIF GPS', () => {
    expect(resolveInferenceCoordinates(true, exif, searched, true)).toEqual(searched)
  })

  it('prefers per-photo EXIF GPS when the outing location was not overridden', () => {
    expect(resolveInferenceCoordinates(true, exif, searched, false)).toEqual(exif)
  })

  it('uses no location when geographic context is disabled', () => {
    expect(resolveInferenceCoordinates(false, exif, searched, true)).toBeUndefined()
  })
})
