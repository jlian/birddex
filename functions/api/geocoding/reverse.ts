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
      () => route.info('Places lookup returned no usable named outdoor place; starting reverse geocoding fallback'),
    )
    return route.complete(
      Response.json({ result }, { headers: { 'Cache-Control': 'private, no-store' } }),
      `Completed reverse geocoding (${result ? 'result found' : 'no result'})`,
    )
  } catch (error) {
    if (error instanceof GeocodingConfigurationError) {
      return route.fail(503, 'Geocoding service unavailable', 'Reverse geocoding could not start because the provider is not configured')
    }
    if (error instanceof GeocodingUpstreamError) {
      const headers: Record<string, string> = error.retryAfter ? { 'Retry-After': error.retryAfter } : {}
      const stage = error.stage === 'places lookup' ? 'Places lookup' : 'Reverse geocoding fallback'
      const detail = error.failure === 'timeout'
        ? `${stage} timed out after 5 seconds; retry reverse geocoding`
        : error.failure === 'network'
          ? `${stage} network request failed; retry reverse geocoding`
          : error.failure === 'unusable payload'
            ? `${stage} returned an unusable provider payload; retry reverse geocoding`
            : `${stage} provider returned HTTP ${error.providerStatus}; retry reverse geocoding`
      return route.failWithHeaders(error.status, 'Geocoding service unavailable', headers, detail)
    }
    if (error instanceof Error && error.message.startsWith('Invalid ')) {
      return route.fail(400, error.message)
    }
    if (error instanceof SyntaxError) return route.fail(400, 'Invalid JSON body', 'Reverse geocoding request body is not valid JSON')
    throw error
  }
}