/**
 * Nearest named place for a coordinate, ranked the way Nominatim ranks results
 * rather than by raw distance.
 *
 * Why not nearest-wins: measured against ten real birding coordinates, pure
 * proximity returned "Kiwanis Ravine" for Discovery Park, "Beaver Lake" for
 * Stanley Park, and "Veterans Park" for Jamaica Bay Wildlife Refuge (a different
 * park, six metres closer than the refuge). Every one of those is a real feature
 * that a birder would not have written down. 4/10 usable.
 *
 * Nominatim solves this with two independent signals, and its docs are explicit
 * that the second now dominates: "Search ranks are not so important these days
 * because many well-known places use the Wikipedia importance ranking instead."
 *
 *   1. extent   how far a place mapped as a point is assumed to reach
 *   2. importance  derived from Wikipedia inbound links
 *
 * We approximate (1) with a per-class extent table and (2) with Wikidata
 * sitelink counts. Re-ranking the same ten coordinates that way took 4/10 to
 * 9/10, with the only remaining miss being genuine absence of data.
 */

export interface Place {
  qid: string
  name: string
  lat: number
  lon: number
  cls: string
  links: number
}

export interface ScoredPlace extends Place {
  distanceM: number
  score: number
}

const EARTH_R = 6371000

/** Great-circle distance in metres. */
export function haversineM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = Math.PI / 180
  const dLat = (bLat - aLat) * toRad
  const dLon = (bLon - aLon) * toRad
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)))
}

export interface ScoreOptions {
  /** Class QID -> assumed reach in metres. */
  extents: Map<string, number>
  /** Places beyond their own extent are dropped entirely. */
  hardCutoff?: boolean
}

/**
 * Higher is better.
 *
 * `proximity` is 1 at the centroid and falls to 0 at the edge of the extent, so
 * a national park stays a candidate 10 km out while a pocket park does not. That
 * is the fix for Haleakala National Park, whose stored centroid sits 10.3 km from
 * its own summit: any fixed radius small enough to be useful in a city misses it.
 *
 * `prominence` is log-scaled because sitelink counts are heavily skewed (Hyde
 * Park 63, a local reserve 1). Linear weighting lets one famous place dominate
 * everything within range; log keeps it a tie-breaker that proximity can still
 * overcome.
 */
export function scorePlace(
  lat: number,
  lon: number,
  place: Place,
  opts: ScoreOptions,
): ScoredPlace | null {
  const distanceM = haversineM(lat, lon, place.lat, place.lon)
  const extent = opts.extents.get(place.cls) ?? 2000
  if (opts.hardCutoff !== false && distanceM > extent) return null

  const proximity = Math.max(0, 1 - distanceM / extent)
  const prominence = Math.log10(1 + Math.max(0, place.links))
  // Proximity dominates; prominence breaks ties between overlapping places.
  const score = proximity * (1 + prominence)
  return { ...place, distanceM, score }
}

/** Best name for a coordinate, or null when nothing is in range. */
export function nearestNamedPlace(
  lat: number,
  lon: number,
  candidates: Place[],
  opts: ScoreOptions,
): ScoredPlace | null {
  let best: ScoredPlace | null = null
  for (const c of candidates) {
    const scored = scorePlace(lat, lon, c, opts)
    if (!scored) continue
    if (!best || scored.score > best.score) best = scored
  }
  return best
}
