import { GeocodingConfigurationError, GeocodingUpstreamError, rateLimitKey, searchPlaces } from '../../lib/geocoding-gateway'
import { createRouteResponder } from '../../lib/log'
import { SearchUnavailableError, searchPlacesLocal } from '../../lib/place-search'

export const onRequestPost: PagesFunction<Env> = async context => {
  const route = createRouteResponder((context.data as RequestData).log, 'geocoding/search/read', 'Application')
  const user = (context.data as RequestData).user

  const { success } = await context.env.GEOCODING_LIMITER.limit({
    key: rateLimitKey(user, context.request),
  })
  if (!success) {
    return route.failWithHeaders(429, 'Too many requests', { 'Retry-After': '60' }, 'Geocoding search exceeded the rate limit for this account; retry after the window closes')
  }

  try {
    const body = await context.request.json() as { query?: unknown } | null
    const query = typeof body?.query === 'string' ? body.query : ''
    // Prefer the self-hosted OSM index; fall back to Geoapify while it is
    // absent.
    //
    // This is a MIGRATION STEP, not the destination. Issue #343 removes
    // Geoapify entirely, and the binding is added with the published index in
    // the D1 upload phase. Until then the binding does not exist, so switching
    // unconditionally would turn every forward search into a 503 for a feature
    // that currently works.
    //
    // The fallback is deliberately keyed on the BINDING being absent, never on
    // a search failing. A bound-but-broken index must surface as an error
    // rather than silently reverting to the provider this PR exists to remove.
    const results = context.env.PLACES_SEARCH
      ? await searchPlacesLocal(context.env.PLACES_SEARCH, query)
      : await searchPlaces(context.env.GEOAPIFY_KEY, query, fetch)
    return route.complete(
      Response.json({ results }, { headers: { 'Cache-Control': 'private, no-store' } }),
      `Completed geocoding search with ${results.length} results`,
    )
  } catch (error) {
    if (error instanceof GeocodingConfigurationError) {
      return route.fail(503, 'Geocoding service unavailable', 'Geocoding search could not start because the provider is not configured')
    }
    // The query text is deliberately absent from every detail string below: it
    // is user input and must not reach a log line.
    if (error instanceof SearchUnavailableError) {
      const detail = error.failure === 'timeout'
        ? 'Geocoding search timed out after 5 seconds; retry the search'
        : 'Geocoding search could not read the place index; retry the search'
      return route.fail(503, 'Geocoding service unavailable', detail)
    }
    if (error instanceof GeocodingUpstreamError) {
      const headers: Record<string, string> = error.retryAfter ? { 'Retry-After': error.retryAfter } : {}
      const detail = error.failure === 'timeout'
        ? 'Geocoding search timed out after 5 seconds; retry the search'
        : error.failure === 'network'
          ? 'Geocoding search network request failed; retry the search'
          : error.failure === 'unusable payload'
            ? 'Geocoding search returned an unusable provider payload; retry the search'
            : `Geocoding search provider returned HTTP ${error.providerStatus}; retry the search`
      return route.failWithHeaders(error.status, 'Geocoding service unavailable', headers, detail)
    }
    if (error instanceof Error && error.message === 'Invalid search query') {
      return route.fail(400, error.message)
    }
    if (error instanceof SyntaxError) return route.fail(400, 'Invalid JSON body', 'Geocoding search request body is not valid JSON')
    throw error
  }
}