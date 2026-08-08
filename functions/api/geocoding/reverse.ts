import { GeocodingConfigurationError, GeocodingUpstreamError, reverseGeocode } from '../../lib/geocoding-gateway'
import { createRouteResponder } from '../../lib/log'

export const onRequestGet: PagesFunction<Env> = async context => {
  const route = createRouteResponder((context.data as RequestData).log, 'geocoding/reverse/read', 'Application')
  const url = new URL(context.request.url)

  try {
    const result = await reverseGeocode(
      context.env.GEOAPIFY_KEY,
      url.searchParams.get('lat'),
      url.searchParams.get('lon'),
      fetch,
    )
    route.debug(result ? 'Geocoding result returned' : 'No geocoding result found')
    return Response.json({ result }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    if (error instanceof GeocodingConfigurationError) {
      return route.fail(503, 'Geocoding service unavailable', 'GEOAPIFY_KEY is not configured')
    }
    if (error instanceof GeocodingUpstreamError) {
      const headers: Record<string, string> = error.retryAfter ? { 'Retry-After': error.retryAfter } : {}
      return route.failWithHeaders(error.status, 'Geocoding service unavailable', headers, `Provider returned HTTP ${error.providerStatus}`)
    }
    if (error instanceof Error && error.message.startsWith('Invalid ')) {
      return route.fail(400, error.message)
    }
    throw error
  }
}