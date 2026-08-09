import { GeocodingConfigurationError, GeocodingUpstreamError, reverseGeocode } from '../../lib/geocoding-gateway'
import { createRouteResponder } from '../../lib/log'

export const onRequestPost: PagesFunction<Env> = async context => {
  const route = createRouteResponder((context.data as RequestData).log, 'geocoding/reverse/read', 'Application')

  try {
    const body = await context.request.json() as { lat?: unknown; lon?: unknown }
    const result = await reverseGeocode(
      context.env.GEOAPIFY_KEY,
      body.lat === undefined ? null : String(body.lat),
      body.lon === undefined ? null : String(body.lon),
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
      const detail = error.status === 504
        ? 'Location lookup timed out after 5 seconds; retry the lookup'
        : `Location lookup provider failed with HTTP ${error.providerStatus || 'network error'}; retry the lookup`
      return route.failWithHeaders(error.status, 'Geocoding service unavailable', headers, detail)
    }
    if (error instanceof Error && error.message.startsWith('Invalid ')) {
      return route.fail(400, error.message)
    }
    if (error instanceof SyntaxError) return route.fail(400, 'Invalid JSON body', 'Reverse geocoding request body is not valid JSON')
    throw error
  }
}