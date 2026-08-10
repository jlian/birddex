export type CoordinateKind = 'latitude' | 'longitude'

export interface GeoapifyResult {
  name?: string
  formatted?: string
  address_line1?: string
  address_line2?: string
  categories?: string[]
  lat?: number | string
  lon?: number | string
  country?: string
  country_code?: string
  state_code?: string
  state?: string
  city?: string
  town?: string
  village?: string
  suburb?: string
  district?: string
  county?: string
}

export interface GeoapifyResponse {
  results: GeoapifyResult[]
}

export interface GeoapifyPlacesResponse {
  features: Array<{ properties?: GeoapifyResult }>
}

export interface GeocodingResult {
  label: string
  context?: string
  lat: number
  lon: number
  stateProvince?: string
  countryCode?: string
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

function normalizeCountryCode(raw?: string): string | undefined {
  const value = raw?.trim().toUpperCase()
  return value && /^[A-Z]{2}$/.test(value) ? value : undefined
}

function normalizeStateProvinceCode(raw: string | undefined, countryCode: string | undefined): string | undefined {
  const value = raw?.trim().toUpperCase()
  if (!value || !countryCode) return undefined
  if (new RegExp(`^${countryCode}-[A-Z0-9]{1,6}$`).test(value)) return value
  return /^[A-Z0-9]{1,6}$/.test(value) ? `${countryCode}-${value}` : undefined
}

export function extractRegionCodes(result: GeoapifyResult): {
  stateProvince?: string
  countryCode?: string
} {
  const countryCode = normalizeCountryCode(result.country_code)
  return {
    stateProvince: normalizeStateProvinceCode(result.state_code, countryCode),
    countryCode,
  }
}

function localityOf(result: GeoapifyResult): string | undefined {
  return result.city || result.town || result.village || result.suburb || result.district || result.county
}

function uniqueParts(values: Array<string | undefined>): string[] {
  return values
    .map(value => value?.trim())
    .filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index)
}

// The place and where it sits, e.g. "Discovery Park, Seattle".
export function formatGeoapifyLabel(result: GeoapifyResult): string {
  const parts = uniqueParts([result.name || result.address_line1, localityOf(result)])
  return parts.join(', ') || result.formatted?.trim() || ''
}

// The wider region, for telling same-named results apart.
export function formatGeoapifyContext(result: GeoapifyResult): string | undefined {
  const label = formatGeoapifyLabel(result)
  const parts = uniqueParts([result.state, result.country]).filter(value => !label.includes(value))
  return parts.join(', ') || undefined
}

function providerCoordinate(value: number | string | undefined, kind: CoordinateKind): number {
  return parseCoordinate(value === undefined ? null : String(value), kind)
}

export function normalizeGeoapifyResult(result: GeoapifyResult): GeocodingResult | null {
  let lat: number
  let lon: number
  try {
    lat = providerCoordinate(result.lat, 'latitude')
    lon = providerCoordinate(result.lon, 'longitude')
  } catch {
    return null
  }

  const label = formatGeoapifyLabel(result)
  if (!label) return null

  return {
    label,
    context: formatGeoapifyContext(result),
    lat,
    lon,
    ...extractRegionCodes(result),
  }
}