import {
  normalizeGeoapifyResult,
  parseCoordinate,
  type GeoapifyResponse,
  type GeocodingResult,
} from './geocoding'
import {
  getPMTiles,
  lookupPlacesWithRegion,
  type ReadonlyR2Bucket,
  type RegionCodes,
} from './osm-places'

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

/**
 * Reverse geocode from the LOCAL OSM archive.
 *
 * Ordered first because it is better on every axis that matters here: no
 * provider charge, provider quota, or provider network hop (p50 18 ms measured
 * against local R2 versus a 5 s provider deadline), and it answers with the
 * place a photo was actually taken in rather than the nearest postal address.
 * The route still applies WingDex's own abuse limit.
 *
 * It returns null ONLY when there is no bucket bound, which the reverse route
 * turns into a 503 because a Worker with no archive is misconfigured rather
 * than out of answers. A bound archive whose tile holds no named place returns
 * an OBJECT with a null `result` instead, which is a successful lookup: there
 * is no provider behind this any more, so that is the final answer for the
 * coordinate and the app renders its "no named place" state. The route and its
 * tests rely on that distinction, so the two must not be collapsed.
 *
 * A MISSING or CORRUPT archive throws instead, because that is a real fault
 * worth seeing rather than a quiet degradation to blank outing names. The
 * reverse route turns it into a 503.
 *
 * Region codes come from a SECOND containment pass against the `admin` layer.
 * They are attached to every candidate rather than only the winner, because
 * picking a different place from the list does not move the coordinate, so the
 * jurisdiction is identical for all of them. An archive built before that layer
 * existed simply yields no codes, which is what the eBird export already treats
 * as "unknown".
 *
 * The codes are ALSO returned separately as `regionCodes`, because they are
 * independent of the named place: the `admin` layer answers "which jurisdiction"
 * and the `parks` layer answers "what is it called", and a coordinate can carry
 * one without the other. A point offshore or in unmapped land often has an ISO
 * code but no named place, so the region pass runs and its codes are returned
 * even when `result` is null. `result` stays null in that case so the UI's
 * "no named place found" state is preserved.
 */
export async function reverseGeocodeLocal(
  bucket: ReadonlyR2Bucket | undefined,
  latitude: number,
  longitude: number,
): Promise<{
  result: GeocodingResult | null
  nearby: GeocodingResult[]
  regionCodes: RegionCodes
} | null> {
  if (!bucket) return null
  const pmtiles = getPMTiles(bucket)
  // ONE tile read for both answers. Both layers live in the same z/x/y tile, so
  // calling the two lookups separately fetched and decoded identical bytes
  // twice: measured against the planet archive, that second call was a real
  // extra R2 range GET of 10 to 18 KB on every request, because the tile body
  // sits far past the cacheable directory prefix in a 1.6 GB archive.
  const { places: hits, regionCodes: codes } = await lookupPlacesWithRegion(pmtiles, latitude, longitude)
  if (hits.length === 0) return { result: null, nearby: [], regionCodes: codes }
  // The archive names a place but does not move the pin: the coordinate the
  // photo carries is more precise than any polygon centroid we could derive.
  const shape = (hit: { name: string }): GeocodingResult => ({
    label: hit.name,
    lat: latitude,
    lon: longitude,
    ...codes,
  })
  const nearby = hits.map(shape)
  return { result: nearby[0], nearby, regionCodes: codes }
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