export interface GeocodingResult {
  label: string
  lat: number
  lon: number
  stateProvince?: string
  countryCode?: string
}

async function fetchGeocoding<T>(path: string, body: object, signal?: AbortSignal): Promise<T> {
  const timeoutController = new AbortController()
  const timeout = window.setTimeout(() => timeoutController.abort(), 6_000)
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal
  try {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: combinedSignal,
    })
    if (!response.ok) {
      throw new Error(`Geocoding request failed (HTTP ${response.status})`)
    }
    return response.json() as Promise<T>
  } finally {
    window.clearTimeout(timeout)
  }
}

export async function reverseGeocode(
  latitude: number,
  longitude: number,
  signal?: AbortSignal,
): Promise<GeocodingResult | null> {
  const body = await fetchGeocoding<{ result: GeocodingResult | null }>(
    '/api/geocoding/reverse',
    { lat: latitude, lon: longitude },
    signal,
  )
  return body.result
}

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<GeocodingResult[]> {
  const body = await fetchGeocoding<{ results: GeocodingResult[] }>(
    '/api/geocoding/search',
    { query },
    signal,
  )
  return body.results
}