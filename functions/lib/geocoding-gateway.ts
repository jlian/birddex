import {
  normalizeGeoapifyResult,
  parseCoordinate,
  roundCoordinate,
  type GeoapifyPlacesResponse,
  type GeoapifyResponse,
  type GeocodingResult,
} from './geocoding'

const GEOAPIFY_ORIGIN = 'https://api.geoapify.com'

type Fetcher = typeof fetch

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
  ) {
    super(`Geocoding provider returned HTTP ${providerStatus}`)
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
    response = await fetcher(url, { headers: { Accept: 'application/json' } })
  } catch {
    throw new GeocodingUpstreamError(502, undefined, 0)
  }

  if (!response.ok) {
    const retryAfter = response.headers.get('Retry-After') || undefined
    const publicStatus = response.status === 429 ? 429 : 502
    throw new GeocodingUpstreamError(publicStatus, retryAfter, response.status)
  }

  try {
    return await response.json()
  } catch {
    throw new GeocodingUpstreamError(502, undefined, response.status)
  }
}

function parseGeocodingResponse(body: unknown): GeoapifyResponse {
  const results = body && typeof body === 'object' && 'results' in body
    ? (body as Partial<GeoapifyResponse>).results
    : undefined
  if (!Array.isArray(results)) throw new GeocodingUpstreamError(502, undefined, 200)
  return { results }
}

function parsePlacesResponse(body: unknown): GeoapifyPlacesResponse {
  const features = body && typeof body === 'object' && 'features' in body
    ? (body as Partial<GeoapifyPlacesResponse>).features
    : undefined
  if (!Array.isArray(features)) throw new GeocodingUpstreamError(502, undefined, 200)
  return { features }
}

function coordinateParam(value: number): string {
  return roundCoordinate(value).toFixed(3)
}

export async function reverseGeocode(
  apiKey: string | undefined,
  rawLatitude: string | null,
  rawLongitude: string | null,
  fetcher: Fetcher = fetch,
): Promise<GeocodingResult | null> {
  const latitude = parseCoordinate(rawLatitude, 'latitude')
  const longitude = parseCoordinate(rawLongitude, 'longitude')
  const lat = coordinateParam(latitude)
  const lon = coordinateParam(longitude)
  const places = parsePlacesResponse(await requestGeoapify(apiKey, '/v2/places', {
    categories: 'leisure.park,natural,national_park',
    conditions: 'named',
    filter: `circle:${lon},${lat},1000`,
    bias: `proximity:${lon},${lat}`,
    limit: '5',
  }, fetcher))
  const nearbyPlace = places.features
    .map(feature => feature.properties ? normalizeGeoapifyResult(feature.properties) : null)
    .find(result => result !== null)
  if (nearbyPlace) return nearbyPlace

  const response = parseGeocodingResponse(await requestGeoapify(apiKey, '/v1/geocode/reverse', {
    lat,
    lon,
    limit: '1',
  }, fetcher))

  return response.results.map(normalizeGeoapifyResult).find(result => result !== null) ?? null
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

  const response = parseGeocodingResponse(await requestGeoapify(apiKey, '/v1/geocode/search', {
    text: query,
    limit: '5',
    bias: 'countrycode:none',
  }, fetcher))

  return response.results
    .map(normalizeGeoapifyResult)
    .filter((result): result is GeocodingResult => result !== null)
}