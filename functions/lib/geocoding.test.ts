import { describe, expect, it } from 'vitest'
import {
  extractRegionCodes,
  formatNominatimLabel,
  normalizeNominatimResult,
  parseCoordinate,
  roundCoordinate,
  scoreNominatimResult,
} from './geocoding'

describe('parseCoordinate', () => {
  it('accepts decimal coordinates at their inclusive bounds', () => {
    expect(parseCoordinate(' -90 ', 'latitude')).toBe(-90)
    expect(parseCoordinate('+180.0', 'longitude')).toBe(180)
  })

  it.each(['', 'Infinity', 'NaN', '0x10', '91'])('rejects invalid latitude %j', (value) => {
    expect(() => parseCoordinate(value, 'latitude')).toThrow('Invalid latitude')
  })
})

describe('roundCoordinate', () => {
  it('rounds to three decimal places and normalizes negative zero', () => {
    expect(roundCoordinate(47.62049)).toBe(47.62)
    expect(roundCoordinate(-0.0001)).toBe(0)
  })
})

describe('Nominatim normalization', () => {
  const park = {
    lat: '47.6205',
    lon: '-122.3493',
    category: 'leisure',
    type: 'park',
    namedetails: { 'name:en': 'Discovery Park' },
    address: {
      city: 'Seattle',
      state: 'Washington',
      country_code: 'us',
      'ISO3166-2-lvl4': 'US-WA',
    },
  }

  it('preserves scoring and concise labels', () => {
    expect(scoreNominatimResult(park)).toBe(100)
    expect(formatNominatimLabel(park)).toBe('Discovery Park, Seattle, Washington')
  })

  it('extracts direct and fallback region codes', () => {
    expect(extractRegionCodes(park)).toEqual({ stateProvince: 'US-WA', countryCode: 'US' })
    expect(extractRegionCodes({ address: { country_code: 'ca', state_code: 'bc' } })).toEqual({
      stateProvince: 'CA-BC',
      countryCode: 'CA',
    })
  })

  it('returns a provider-independent attributed result', () => {
    expect(normalizeNominatimResult(park)).toEqual({
      label: 'Discovery Park, Seattle, Washington',
      lat: 47.6205,
      lon: -122.3493,
      stateProvince: 'US-WA',
      countryCode: 'US',
      attribution: {
        label: 'Location data © OpenStreetMap contributors',
        url: 'https://www.openstreetmap.org/copyright',
      },
    })
  })

  it('rejects unusable provider coordinates', () => {
    expect(normalizeNominatimResult({ ...park, lat: 'unknown' })).toBeNull()
  })
})