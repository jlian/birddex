import { assertWingDexApiResponse } from '@/lib/api-error'
import { fetchWithLocalAuthRetry } from '@/lib/local-auth-fetch'

export interface GeocodingResult {
  label: string
  context?: string
  lat: number
  lon: number
  stateProvince?: string
  countryCode?: string
}

/** ISO 3166 codes for the jurisdiction a coordinate sits in. */
export interface RegionCodes {
  stateProvince?: string
  countryCode?: string
}

/**
 * A reverse-geocode outcome. `result` is the named place, null when the archive
 * has no named place near the coordinate. `regionCodes` is independent: a
 * coordinate offshore or in unmapped land often has an ISO state/country code
 * with no named place, and the eBird export still wants those codes.
 */
export interface ReverseGeocodeResult {
  result: GeocodingResult | null
  regionCodes: RegionCodes
}

async function fetchGeocoding<T>(path: string, body: object, signal?: AbortSignal): Promise<T> {
  const timeoutController = new AbortController()
  const timeout = window.setTimeout(() => timeoutController.abort(), 6_000)
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal
  try {
    const response = await fetchWithLocalAuthRetry(path, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: combinedSignal,
    })
    await assertWingDexApiResponse(response, 'Geocoding request failed')
    return response.json() as Promise<T>
  } finally {
    window.clearTimeout(timeout)
  }
}

export async function reverseGeocode(
  latitude: number,
  longitude: number,
  signal?: AbortSignal,
): Promise<ReverseGeocodeResult> {
  const body = await fetchGeocoding<{
    result: GeocodingResult | null
    regionCodes?: RegionCodes
  }>(
    '/api/geocoding/reverse',
    { lat: latitude, lon: longitude },
    signal,
  )
  return { result: body.result, regionCodes: body.regionCodes ?? {} }
}

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<GeocodingResult[]> {
  const body = await fetchGeocoding<{ results: GeocodingResult[] }>(
    '/api/geocoding/search',
    { query },
    signal,
  )
  return body.results
}