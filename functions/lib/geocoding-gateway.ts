import {
  normalizeGeoapifyResult,
  parseCoordinate,
  roundCoordinate,
  type GeoapifyPlacesResponse,
  type GeoapifyResponse,
  type GeocodingResult,
} from './geocoding'

const GEOAPIFY_ORIGIN = 'https://api.geoapify.com'
const GEOAPIFY_DEADLINE_MS = 5_000

// Re-exported so the geocoding routes keep their existing import.
export { rateLimitKey } from './rate-limit'

type Fetcher = typeof fetch
export type GeocodingStage = 'places lookup' | 'reverse fallback' | 'search'
export type GeocodingFailure = 'timeout' | 'network' | 'provider status' | 'unusable payload'

export class GeocodingConfigurationError extends Error {
  constructor() {
    super('Geocoding provider is not configured')
  }
}

export class GeocodingUpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter?: string,
    readonly providerStatus: number = status,
    readonly stage: GeocodingStage = 'search',
    readonly failure: GeocodingFailure = providerStatus === 0
      ? status === 504 ? 'timeout' : 'network'
      : 'provider status',
  ) {
    super(`Geocoding ${stage} failed: ${failure}`)
  }
}

type GeoapifyPath = '/v1/geocode/search' | '/v1/geocode/reverse' | '/v2/places'

function buildUpstreamURL(path: GeoapifyPath, params: Record<string, string>): URL {
  const url = new URL(path, GEOAPIFY_ORIGIN)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return url
}

async function requestGeoapify(
  apiKey: string | undefined,
  path: GeoapifyPath,
  params: Record<string, string>,
  fetcher: Fetcher,
  signal: AbortSignal,
  stage: GeocodingStage,
): Promise<unknown> {
  if (!apiKey?.trim()) throw new GeocodingConfigurationError()

  const url = buildUpstreamURL(path, {
    ...params,
    format: 'json',
    lang: 'en',
    apiKey,
  })

  let response: Response
  try {
    response = await fetcher(url, { headers: { Accept: 'application/json' }, signal })
  } catch {
    if (signal.aborted) throw new GeocodingUpstreamError(504, undefined, 0, stage, 'timeout')
    throw new GeocodingUpstreamError(502, undefined, 0, stage, 'network')
  }

  if (!response.ok) {
    const retryAfter = response.headers.get('Retry-After') || undefined
    const publicStatus = response.status === 429 ? 429 : 502
    throw new GeocodingUpstreamError(publicStatus, retryAfter, response.status, stage, 'provider status')
  }

  try {
    return await response.json()
  } catch {
    throw new GeocodingUpstreamError(502, undefined, response.status, stage, 'unusable payload')
  }
}

function parseGeocodingResponse(body: unknown, stage: GeocodingStage): GeoapifyResponse {
  const results = body && typeof body === 'object' && 'results' in body
    ? (body as Partial<GeoapifyResponse>).results
    : undefined
  if (!Array.isArray(results)) throw new GeocodingUpstreamError(502, undefined, 200, stage, 'unusable payload')
  return { results }
}

function parsePlacesResponse(body: unknown): GeoapifyPlacesResponse {
  const features = body && typeof body === 'object' && 'features' in body
    ? (body as Partial<GeoapifyPlacesResponse>).features
    : undefined
  if (!Array.isArray(features)) throw new GeocodingUpstreamError(502, undefined, 200, 'places lookup', 'unusable payload')
  return { features }
}

function coordinateParam(value: number): string {
  return roundCoordinate(value).toFixed(3)
}

// A sanctuary or reserve names an outing better than the large park containing it.
const RESERVE_CATEGORIES = new Set(['leisure.park.nature_reserve', 'natural.protected_area'])

export async function reverseGeocode(
  apiKey: string | undefined,
  rawLatitude: string | null,
  rawLongitude: string | null,
  fetcher: Fetcher = fetch,
  onReverseFallback?: () => void,
): Promise<{ result: GeocodingResult | null; nearby: GeocodingResult[] }> {
  const latitude = parseCoordinate(rawLatitude, 'latitude')
  const longitude = parseCoordinate(rawLongitude, 'longitude')
  const lat = coordinateParam(latitude)
  const lon = coordinateParam(longitude)
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), GEOAPIFY_DEADLINE_MS)
  try {
    const places = parsePlacesResponse(await requestGeoapify(apiKey, '/v2/places', {
      // Geoapify does not union a comma-separated list, so extra categories only narrow
      // the match. `leisure` is the one value that covers parks and nature reserves.
      categories: 'leisure',
      conditions: 'named',
      filter: `circle:${lon},${lat},1000`,
      bias: `proximity:${lon},${lat}`,
      limit: '8',
    }, fetcher, controller.signal, 'places lookup'))
    const candidates = places.features
      .map(feature => feature.properties)
      .filter((properties): properties is NonNullable<typeof properties> => Boolean(properties))
      .map(properties => ({ place: normalizeGeoapifyResult(properties), categories: properties.categories ?? [] }))
      .filter((candidate): candidate is { place: GeocodingResult; categories: string[] } => candidate.place !== null)
    const reserveIndex = candidates.findIndex(candidate =>
      candidate.categories.some(category => RESERVE_CATEGORIES.has(category)))
    if (reserveIndex > 0) candidates.unshift(...candidates.splice(reserveIndex, 1))
    const nearby = candidates.map(candidate => candidate.place)
    if (nearby.length > 0) return { result: nearby[0], nearby }

    onReverseFallback?.()
    const response = parseGeocodingResponse(await requestGeoapify(apiKey, '/v1/geocode/reverse', {
      lat,
      lon,
      limit: '1',
    }, fetcher, controller.signal, 'reverse fallback'), 'reverse fallback')

    return {
      result: response.results.map(normalizeGeoapifyResult).find(result => result !== null) ?? null,
      nearby: [],
    }
  } finally {
    clearTimeout(deadline)
  }
}

export async function searchPlaces(
  apiKey: string | undefined,
  rawQuery: string,
  fetcher: Fetcher = fetch,
): Promise<GeocodingResult[]> {
  const query = rawQuery.trim().replace(/\s+/g, ' ')
  if (query.length < 2 || query.length > 200) {
    throw new Error('Invalid search query')
  }

  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), GEOAPIFY_DEADLINE_MS)
  try {
    const response = parseGeocodingResponse(await requestGeoapify(apiKey, '/v1/geocode/search', {
      text: query,
      limit: '5',
      // Geoapify defaults to countrycode:auto; its current Forward Geocoding docs
      // explicitly prescribe countrycode:none to avoid IP-country prioritization.
      // proximity: narrows the response to a single result, so it is not usable here.
      bias: 'countrycode:none',
    }, fetcher, controller.signal, 'search'), 'search')

    return response.results
      .map(normalizeGeoapifyResult)
      .filter((result): result is GeocodingResult => result !== null)
  } finally {
    clearTimeout(deadline)
  }
}