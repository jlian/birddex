export interface GeocodingResult {
  label: string
  lat: number
  lon: number
  stateProvince?: string
  countryCode?: string
  attribution: {
    label: string
    url: string
  }
  secondaryAttribution?: {
    label: string
    url: string
  }
}

async function fetchGeocoding<T>(url: URL, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new Error(`Geocoding request failed (HTTP ${response.status})`)
  }
  return response.json() as Promise<T>
}

export async function reverseGeocode(
  latitude: number,
  longitude: number,
  signal?: AbortSignal,
): Promise<GeocodingResult | null> {
  const url = new URL('/api/geocoding/reverse', window.location.origin)
  url.searchParams.set('lat', String(latitude))
  url.searchParams.set('lon', String(longitude))
  const body = await fetchGeocoding<{ result: GeocodingResult | null }>(url, signal)
  return body.result
}

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<GeocodingResult[]> {
  const url = new URL('/api/geocoding/search', window.location.origin)
  url.searchParams.set('q', query)
  const body = await fetchGeocoding<{ results: GeocodingResult[] }>(url, signal)
  return body.results
}