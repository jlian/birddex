import {
  normalizeNominatimResult,
  parseCoordinate,
  roundCoordinate,
  scoreNominatimResult,
  type GeocodingResult,
  type NominatimResult,
} from './geocoding'

const NOMINATIM_ORIGIN = 'https://nominatim.openstreetmap.org'
const USER_AGENT = 'WingDex/1.0 (https://wingdex.app; https://github.com/jlian/wingdex)'
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const FLIGHT_TTL_MS = 15_000
const UPSTREAM_INTERVAL_MS = 1_000

type Fetcher = typeof fetch

interface CachedRow {
  response: string
  expiresAt: number
}

interface RateLimitRow {
  nextAllowedAt: number
}

interface InflightRow {
  expiresAt: number
}

export class GeocodingUpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter?: string,
  ) {
    super(`Geocoding provider returned HTTP ${status}`)
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function hashCacheKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function buildUpstreamURL(path: '/search' | '/reverse', params: Record<string, string>): URL {
  const url = new URL(path, NOMINATIM_ORIGIN)
  for (const [key, value] of Object.entries(params).sort(([left], [right]) => left.localeCompare(right))) {
    url.searchParams.set(key, value)
  }
  return url
}

async function readCached<T>(db: D1Database, cacheKey: string, now: number): Promise<T | null> {
  const row = await db
    .prepare('SELECT response, expiresAt FROM geocoding_cache WHERE cacheKey = ? AND expiresAt > ?')
    .bind(cacheKey, now)
    .first<CachedRow>()
  if (!row) return null

  try {
    return JSON.parse(row.response) as T
  } catch {
    await db.prepare('DELETE FROM geocoding_cache WHERE cacheKey = ?').bind(cacheKey).run()
    return null
  }
}

async function claimRequest(db: D1Database, cacheKey: string, ownerId: string, now: number): Promise<boolean> {
  const result = await db.prepare(
    `INSERT INTO geocoding_inflight (cacheKey, ownerId, expiresAt)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(cacheKey) DO UPDATE SET ownerId = excluded.ownerId, expiresAt = excluded.expiresAt
     WHERE geocoding_inflight.expiresAt <= ?4`
  ).bind(cacheKey, ownerId, now + FLIGHT_TTL_MS, now).run()
  return (result.meta.changes || 0) > 0
}

async function waitForClaimOrCache<T>(db: D1Database, cacheKey: string, ownerId: string): Promise<T | null> {
  while (true) {
    const now = Date.now()
    const cached = await readCached<T>(db, cacheKey, now)
    if (cached !== null) return cached
    if (await claimRequest(db, cacheKey, ownerId, now)) return null

    const inflight = await db
      .prepare('SELECT expiresAt FROM geocoding_inflight WHERE cacheKey = ?')
      .bind(cacheKey)
      .first<InflightRow>()
    const waitMs = inflight ? Math.max(25, Math.min(250, inflight.expiresAt - now)) : 25
    await sleep(waitMs)
  }
}

async function acquireUpstreamLease(db: D1Database): Promise<void> {
  while (true) {
    const now = Date.now()
    const result = await db
      .prepare('UPDATE geocoding_rate_limit SET nextAllowedAt = ?1 WHERE id = 1 AND nextAllowedAt <= ?2')
      .bind(now + UPSTREAM_INTERVAL_MS, now)
      .run()
    if ((result.meta.changes || 0) > 0) return

    const row = await db
      .prepare('SELECT nextAllowedAt FROM geocoding_rate_limit WHERE id = 1')
      .first<RateLimitRow>()
    await sleep(Math.max(25, Math.min(UPSTREAM_INTERVAL_MS, (row?.nextAllowedAt || now) - now)))
  }
}

async function extendRateLimit(db: D1Database, retryAfter: string): Promise<void> {
  const seconds = Number(retryAfter)
  if (!Number.isFinite(seconds) || seconds <= 0) return
  const retryAt = Date.now() + Math.ceil(seconds * 1000)
  await db
    .prepare('UPDATE geocoding_rate_limit SET nextAllowedAt = MAX(nextAllowedAt, ?1) WHERE id = 1')
    .bind(retryAt)
    .run()
}

async function requestNominatim<T>(
  db: D1Database,
  path: '/search' | '/reverse',
  params: Record<string, string>,
  fetcher: Fetcher,
): Promise<T> {
  const url = buildUpstreamURL(path, params)
  const cacheKey = await hashCacheKey(`v1:${url.pathname}?${url.searchParams.toString()}`)
  const now = Date.now()
  const cached = await readCached<T>(db, cacheKey, now)
  if (cached !== null) return cached

  const ownerId = crypto.randomUUID()
  const coalesced = await waitForClaimOrCache<T>(db, cacheKey, ownerId)
  if (coalesced !== null) return coalesced

  try {
    await acquireUpstreamLease(db)
    const response = await fetcher(url, {
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'en',
        'User-Agent': USER_AGENT,
      },
    })
    if (!response.ok) {
      const retryAfter = response.headers.get('Retry-After') || undefined
      if (retryAfter) await extendRateLimit(db, retryAfter)
      throw new GeocodingUpstreamError(response.status, retryAfter)
    }

    const body = await response.json() as T
    await db.prepare(
      `INSERT INTO geocoding_cache (cacheKey, response, expiresAt)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(cacheKey) DO UPDATE SET response = excluded.response, expiresAt = excluded.expiresAt`
    ).bind(cacheKey, JSON.stringify(body), Date.now() + CACHE_TTL_MS).run()
    return body
  } finally {
    await db
      .prepare('DELETE FROM geocoding_inflight WHERE cacheKey = ? AND ownerId = ?')
      .bind(cacheKey, ownerId)
      .run()
  }
}

function coordinateParam(value: number): string {
  return roundCoordinate(value).toFixed(3)
}

function boundedCoordinateParam(value: number, maximum: number): string {
  return coordinateParam(Math.max(-maximum, Math.min(maximum, value)))
}

export async function reverseGeocode(
  db: D1Database,
  rawLatitude: string | null,
  rawLongitude: string | null,
  fetcher: Fetcher = fetch,
): Promise<GeocodingResult | null> {
  const latitude = roundCoordinate(parseCoordinate(rawLatitude, 'latitude'))
  const longitude = roundCoordinate(parseCoordinate(rawLongitude, 'longitude'))
  const common = {
    format: 'jsonv2',
    addressdetails: '1',
    namedetails: '1',
    'accept-language': 'en',
  }

  const nearby = await requestNominatim<NominatimResult[]>(db, '/search', {
    ...common,
    q: 'park',
    bounded: '1',
    limit: '5',
    viewbox: [
      boundedCoordinateParam(longitude - 0.02, 180),
      boundedCoordinateParam(latitude + 0.02, 90),
      boundedCoordinateParam(longitude + 0.02, 180),
      boundedCoordinateParam(latitude - 0.02, 90),
    ].join(','),
  }, fetcher)
  const nearbyResult = nearby
    .map(result => ({ result, score: scoreNominatimResult(result) }))
    .sort((left, right) => right.score - left.score)
    .find(candidate => candidate.score >= 60)
  if (nearbyResult) return normalizeNominatimResult(nearbyResult.result)

  for (const params of [
    { layer: 'natural', zoom: '15' },
    { layer: 'address', zoom: '14' },
    { layer: 'address', zoom: '10' },
  ]) {
    const result = await requestNominatim<NominatimResult>(db, '/reverse', {
      ...common,
      lat: coordinateParam(latitude),
      lon: coordinateParam(longitude),
      ...params,
    }, fetcher)
    const normalized = normalizeNominatimResult(result)
    if (normalized && (params.layer !== 'natural' || scoreNominatimResult(result) >= 60)) {
      return normalized
    }
  }

  return null
}

export async function searchPlaces(
  db: D1Database,
  rawQuery: string,
  fetcher: Fetcher = fetch,
): Promise<GeocodingResult[]> {
  const query = rawQuery.trim().replace(/\s+/g, ' ')
  if (query.length < 2 || query.length > 200) {
    throw new Error('Invalid search query')
  }

  const results = await requestNominatim<NominatimResult[]>(db, '/search', {
    format: 'jsonv2',
    q: query,
    limit: '5',
    addressdetails: '1',
    namedetails: '1',
    'accept-language': 'en',
  }, fetcher)
  return results
    .map(normalizeNominatimResult)
    .filter((result): result is GeocodingResult => result !== null)
}