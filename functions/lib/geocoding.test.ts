import { describe, expect, it } from 'vitest'
import {
  extractRegionCodes,
  formatGeoapifyContext,
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

  it('labels the place with its locality and keeps the region as context', () => {
    expect(formatGeoapifyLabel(park)).toBe('Discovery Park, Seattle')
    expect(formatGeoapifyContext(park)).toBe('Washington')
    expect(formatGeoapifyLabel({ formatted: 'Fallback address' })).toBe('Fallback address')
    expect(formatGeoapifyLabel({ name: 'Seattle', city: 'Seattle' })).toBe('Seattle')
    expect(formatGeoapifyContext({ name: 'Discovery Park' })).toBeUndefined()
    expect(formatGeoapifyContext({ ...park, country: 'United States' })).toBe('Washington, United States')
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
      label: 'Discovery Park, Seattle',
      context: 'Washington',
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
