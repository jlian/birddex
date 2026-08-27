import { reverseGeocodeLocal } from '../../lib/geocoding-gateway'
import { PLACES_ATTRIBUTION } from '../../lib/osm-places'
import { parseCoordinate } from '../../lib/geocoding'
import { createRouteResponder } from '../../lib/log'

/**
 * Reverse geocode a coordinate from the local OSM archive.
 *
 * There is deliberately NO external provider here. The archive covers 93.2% of
 * coordinates (measured over 20,000 iNaturalist points) and the remaining gap
 * returns null, which the app already handles: OutingReview renders "No named
 * place found nearby. Tap above to name this outing." and leaves the field
 * editable.
 *
 * Returning null beats calling a paid provider for the last few percent. It
 * removes an API key, a rate limit, a 5 second network deadline and a
 * third-party dependency from the path, and a wrong-but-confident address is
 * worse for naming a birding outing than an honest blank.
 *
 * No rate limit either: the only cost is an R2 range read, so there is no
 * budget to protect.
 */
export const onRequestPost: PagesFunction<Env> = async context => {
  const route = createRouteResponder((context.data as RequestData).log, 'geocoding/reverse/read', 'Application')

  // Validate the REQUEST before the deployment. A malformed body is the
  // caller's fault and must return 400 whether or not the archive is bound,
  // otherwise a misconfigured deployment masks a client bug as a 503.
  let latitude: number
  let longitude: number
  try {
    const body = await context.request.json() as { lat?: unknown; lon?: unknown } | null
    latitude = parseCoordinate(body?.lat === undefined ? null : String(body.lat), 'latitude')
    longitude = parseCoordinate(body?.lon === undefined ? null : String(body.lon), 'longitude')
  } catch (error) {
    if (error instanceof SyntaxError) {
      return route.fail(400, 'Invalid JSON body', 'Reverse geocoding request body is not valid JSON')
    }
    if (error instanceof Error && error.message.startsWith('Invalid ')) {
      return route.fail(400, error.message)
    }
    throw error
  }

  if (!context.env.PLACES) {
    return route.fail(
      503,
      'Geocoding service unavailable',
      'Reverse geocoding is unavailable because the place archive is not bound',
    )
  }

  try {
    const local = await reverseGeocodeLocal(context.env.PLACES, latitude, longitude)
    // A null result is a SUCCESSFUL lookup that found nothing, not a failure.
    // The app distinguishes the two: 'empty' offers no retry because the answer
    // would be identical, while an error does. Region codes are carried
    // separately because a coordinate can have a jurisdiction (ISO codes) with
    // no named place, e.g. offshore or in unmapped land; the eBird export still
    // wants those even when `result` is null and the UI shows its "no named
    // place" state.
    const payload = local ?? { result: null, nearby: [], regionCodes: {} }
    const namedCount = payload.result ? payload.nearby.length : 0
    return route.complete(
      Response.json(
        // ODbL 1.4.1 asks for the notice to travel with the produced work, so
        // the response carries it rather than relying on the client to hold a
        // hard-coded string that can drift from the archive it describes.
        { ...payload, attribution: PLACES_ATTRIBUTION },
        { headers: { 'Cache-Control': 'private, no-store' } },
      ),
      payload.result
        ? `Completed reverse geocoding from the local archive (${namedCount} candidates)`
        : 'Completed reverse geocoding from the local archive with no named place near the coordinate',
    )
  } catch (error) {
    // A missing or corrupt archive is a real fault. With no provider behind it
    // there is nothing to fall back to, so it surfaces as a 503 rather than
    // being disguised as "no place found".
    //
    // Do NOT interpolate the raw exception into the description: middleware
    // strips this header from the client response but forwards it to the
    // production log, so a raw archive error would leak internal detail into
    // logs. Log the coordinate-free class of failure instead.
    void error
    return route.fail(
      503,
      'Geocoding service unavailable',
      'Local place lookup failed while reading the archive',
    )
  }
}
