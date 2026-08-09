import { describe, expect, it } from 'vitest'
import {
  extractRegionCodes,
  formatGeoapifyLabel,
  normalizeGeoapifyResult,
  parseCoordinate,
  roundCoordinate,
} from './geocoding'

describe('parseCoordinate', () => {
  it('accepts decimal coordinates at their inclusive bounds', () => {
    expect(parseCoordinate(' -90 ', 'latitude')).toBe(-90)
    expect(parseCoordinate('+180.0', 'longitude')).toBe(180)
  })

  it.each(['', 'Infinity', 'NaN', '0x10', '91'])('rejects invalid latitude %j', value => {
    expect(() => parseCoordinate(value, 'latitude')).toThrow('Invalid latitude')
  })
})

describe('roundCoordinate', () => {
  it('rounds to three decimal places and normalizes negative zero', () => {
    expect(roundCoordinate(47.62049)).toBe(47.62)
    expect(roundCoordinate(-0.0001)).toBe(0)
  })
})

describe('Geoapify normalization', () => {
  const park = {
    name: 'Discovery Park',
    formatted: 'Discovery Park, Seattle, WA, United States of America',
    lat: 47.6205,
    lon: -122.3493,
    city: 'Seattle',
    state: 'Washington',
    state_code: 'WA',
    country_code: 'us',
  }

  it('creates a concise label', () => {
    expect(formatGeoapifyLabel(park)).toBe('Discovery Park, Seattle, Washington')
    expect(formatGeoapifyLabel({ formatted: 'Fallback address' })).toBe('Fallback address')
  })

  it('extracts valid region codes', () => {
    expect(extractRegionCodes(park)).toEqual({ stateProvince: 'US-WA', countryCode: 'US' })
    expect(extractRegionCodes({ country_code: 'ca', state_code: 'CA-BC' })).toEqual({
      stateProvince: 'CA-BC',
      countryCode: 'CA',
    })
    expect(extractRegionCodes({ country_code: 'invalid', state_code: 'WA' })).toEqual({
      stateProvince: undefined,
      countryCode: undefined,
    })
  })

  it('returns a provider-independent result', () => {
    expect(normalizeGeoapifyResult(park)).toEqual({
      label: 'Discovery Park, Seattle, Washington',
      lat: 47.6205,
      lon: -122.3493,
      stateProvince: 'US-WA',
      countryCode: 'US',
    })
  })

  it('rejects unusable provider results', () => {
    expect(normalizeGeoapifyResult({ ...park, lat: 'unknown' })).toBeNull()
    expect(normalizeGeoapifyResult({ lat: 47, lon: -122 })).toBeNull()
  })
})
