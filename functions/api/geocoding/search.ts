import { GeocodingUpstreamError, searchPlaces } from '../../lib/geocoding-gateway'
import { createRouteResponder } from '../../lib/log'

export const onRequestGet: PagesFunction<Env> = async context => {
  const route = createRouteResponder((context.data as RequestData).log, 'geocoding/search/read', 'Application')
  const query = new URL(context.request.url).searchParams.get('q') || ''

  try {
    const results = await searchPlaces(context.env.DB, query, fetch, route.log)
    route.debug('Geocoding search completed', { resultCount: results.length })
    return Response.json({ results }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    if (error instanceof GeocodingUpstreamError) {
      const headers: Record<string, string> = error.retryAfter ? { 'Retry-After': error.retryAfter } : {}
      return route.failWithHeaders(error.status, 'Geocoding service unavailable', headers, `Provider returned HTTP ${error.status}`)
    }
    if (error instanceof Error && error.message === 'Invalid search query') {
      return route.fail(400, error.message)
    }
    throw error
  }
}