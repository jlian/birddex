export const OPENSTREETMAP_ATTRIBUTION = {
  label: 'Location data © OpenStreetMap contributors',
  url: 'https://www.openstreetmap.org/copyright',
} as const

export type CoordinateKind = 'latitude' | 'longitude'

export interface NominatimResult {
  place_id?: number
  lat?: string
  lon?: string
  name?: string
  display_name?: string
  category?: string
  type?: string
  namedetails?: Record<string, string>
  address?: Record<string, string>
}

export interface GeocodingResult {
  label: string
  lat: number
  lon: number
  stateProvince?: string
  countryCode?: string
  attribution: typeof OPENSTREETMAP_ATTRIBUTION
}

const DECIMAL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/

export function parseCoordinate(value: string | null, kind: CoordinateKind): number {
  const trimmed = value?.trim() || ''
  const maximum = kind === 'latitude' ? 90 : 180
  if (!DECIMAL_NUMBER.test(trimmed)) {
    throw new Error(`Invalid ${kind}`)
  }

  const coordinate = Number(trimmed)
  if (!Number.isFinite(coordinate) || Math.abs(coordinate) > maximum) {
    throw new Error(`Invalid ${kind}`)
  }
  return coordinate
}

export function roundCoordinate(coordinate: number): number {
  const rounded = Number(coordinate.toFixed(3))
  return Object.is(rounded, -0) ? 0 : rounded
}

function normalizeStateProvinceCode(raw?: string): string | undefined {
  const value = raw?.trim().toUpperCase()
  if (!value) return undefined
  return /^[A-Z]{2}-[A-Z0-9]{1,6}$/.test(value) ? value : undefined
}

export function extractRegionCodes(result: NominatimResult): {
  stateProvince?: string
  countryCode?: string
} {
  const address = result.address
  if (!address) return {}

  const countryCode = address.country_code?.trim().toUpperCase() || undefined
  const directState =
    normalizeStateProvinceCode(address['ISO3166-2-lvl4']) ||
    normalizeStateProvinceCode(address['ISO3166-2-lvl3']) ||
    normalizeStateProvinceCode(address['ISO3166-2-lvl5'])

  if (directState || !countryCode) {
    return { stateProvince: directState, countryCode }
  }

  const stateCode =
    address.state_code?.trim().toUpperCase() ||
    address.region_code?.trim().toUpperCase()
  if (stateCode && /^[A-Z0-9]{1,6}$/.test(stateCode)) {
    return { stateProvince: `${countryCode}-${stateCode}`, countryCode }
  }

  return { countryCode }
}

export function scoreNominatimResult(result: NominatimResult | null): number {
  if (!result) return 0
  const category = result.category?.toLowerCase() || ''
  const type = result.type?.toLowerCase() || ''
  const address = result.address || {}
  const hasName = Boolean(result.name || result.namedetails?.['name:en'] || result.namedetails?.name)

  let score = 0
  if (category === 'leisure' && type === 'park') score += 100
  else if (category === 'boundary' && type === 'protected_area') score += 95
  else if (category === 'natural') score += 80
  else if (category === 'waterway') score += 72
  else if (category === 'place' && ['suburb', 'neighbourhood', 'village', 'town'].includes(type)) score += 60
  else if (category === 'boundary' && type === 'administrative') score += 45

  if (hasName) score += 5
  if (address.city || address.town || address.village || address.county) score += 5
  return Math.min(score, 100)
}

export function formatNominatimLabel(result: NominatimResult): string {
  const address = result.address || {}
  const primary =
    result.namedetails?.['name:en'] ||
    result.namedetails?.name ||
    result.name ||
    address.park ||
    address.nature_reserve ||
    address.recreation_ground ||
    address.leisure ||
    address.tourism ||
    address.amenity ||
    address.neighbourhood ||
    address.suburb ||
    address.village ||
    address.town ||
    address.city ||
    address.county ||
    address.state
  const locality =
    address.neighbourhood ||
    address.suburb ||
    address.village ||
    address.town ||
    address.city ||
    address.county

  return [primary, locality, address.state]
    .filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index)
    .slice(0, 3)
    .join(', ')
}

export function normalizeNominatimResult(result: NominatimResult): GeocodingResult | null {
  let lat: number
  let lon: number
  try {
    lat = parseCoordinate(result.lat || null, 'latitude')
    lon = parseCoordinate(result.lon || null, 'longitude')
  } catch {
    return null
  }

  const label = formatNominatimLabel(result) || result.display_name?.trim() || ''
  if (!label) return null

  return {
    label,
    lat,
    lon,
    ...extractRegionCodes(result),
    attribution: OPENSTREETMAP_ATTRIBUTION,
  }
}