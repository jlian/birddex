/**
 * Point-in-polygon reverse geocoding from a PMTiles archive in R2.
 *
 * Follows the SFO Museum pattern (millsfield.sfomuseum.org/blog/2022/12/19/pmtiles-pip/,
 * whosonfirst/go-whosonfirst-spatial-pmtiles): turn the coordinate into a tile
 * address, range-request that tile, decode it, and test containment in memory.
 *
 * The reason this beats a centroid-and-radius heuristic is that containment stops
 * being a guess. Discovery Park is a polygon; either you are inside it or you are
 * not.
 */
import { PMTiles, ResolvedValueCache, type Source, type RangeResponse } from 'pmtiles'
import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'
import { scoreOf, kindOf, capOversized, nearScoreOf, spansTile, rankCandidates, type Ranked } from './place-rank'

const ZOOM = 12

/**
 * Scoring and ordering live in `place-rank.ts`, not here.
 *
 * This file used to carry its own copy, a flat read of Nominatim's
 * `rank_search` table. It was replaced because the flat tiers spent their
 * influence in the wrong place: `if (props.tourism) return 26` scored a hotel
 * exactly like a zoo, and over 20k iNat coordinates `tourism=hotel` won 797
 * times (5.4% of all named results) against 87 for `tourism=zoo`. A hotel is
 * never why a birder was standing somewhere. `place-rank.ts` splits the same
 * table by sub-category and demotes lodging to 19.
 *
 * Two properties of the old scorer are deliberate and survive the swap:
 *
 * - No `waterway` tier. A creek polygon beats the park containing it far too
 *   often: it is what made Union Bay Natural Area resolve to Ravenna Creek.
 *   `waterway` is also 0% polygons across 47k named features, so a
 *   point-in-polygon test could never return one anyway.
 * - Containment is ordered before proximity, which is `rankCandidates`'s job.
 */

/**
 * Prefer the English name.
 *
 * OSM `name` is the local-language name, so a Taipei park comes back in Chinese
 * and a Tomsk park in Cyrillic. Production's Nominatim config passed
 * `accept-language: en` for exactly this reason; `name:en` is the equivalent.
 */
function nameOf(props: Record<string, unknown>): string | undefined {
  return (props['name:en'] || props.name) as string | undefined
}

/**
 * R2 as a PMTiles byte-range source. This is the only Cloudflare-specific part.
 *
 * Reading a tile costs several sequential range requests: the header, then the
 * root directory, then a leaf directory, then the tile itself. The tile differs
 * per coordinate but the header and directories are the same bytes for every
 * request, so they are cached in the Worker's global scope. That turns a cold
 * lookup of 3-4 round trips into a warm lookup of 1.
 */
const DIRECTORY_CACHE = new Map<string, ArrayBuffer>()

// PMTiles reads the fixed-size header first, then directories near the start of
// the archive. Caching reads below this offset covers both without holding tile
// data, which would be unbounded.
const CACHEABLE_PREFIX_BYTES = 8 * 1024 * 1024

export type ReadonlyR2Bucket = Pick<R2Bucket, 'get'>

export class R2Source implements Source {
  constructor(
    private bucket: ReadonlyR2Bucket,
    private key: string,
  ) {}

  getKey(): string {
    return this.key
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const cacheable = offset + length <= CACHEABLE_PREFIX_BYTES
    const cacheKey = `${this.key}:${offset}:${length}`
    if (cacheable) {
      const hit = DIRECTORY_CACHE.get(cacheKey)
      if (hit) return { data: hit }
    }

    const obj = await this.bucket.get(this.key, { range: { offset, length } })
    if (!obj) throw new Error(`PMTiles archive not found: ${this.key}`)
    const data = await obj.arrayBuffer()

    // Bound the cache so a long-lived isolate cannot grow without limit.
    if (cacheable && DIRECTORY_CACHE.size < 64) {
      DIRECTORY_CACHE.set(cacheKey, data)
    }
    return { data }
  }
}

function pointInRing(px: number, py: number, ring: { x: number; y: number }[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x
    const yi = ring[i].y
    const xj = ring[j].x
    const yj = ring[j].y
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi || 1e-12) + xi) {
      inside = !inside
    }
  }
  return inside
}

function signedRingArea(ring: { x: number; y: number }[]): number {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y)
  }
  return a / 2
}

/**
 * Group a polygon feature's rings into outer rings each with their holes.
 *
 * MVT stores an exterior ring immediately followed by its interior rings
 * (holes), and the two wind in opposite directions, so their signed areas have
 * opposite sign. Rather than depend on which sign the spec assigns to which,
 * the first ring is taken as an exterior and every later ring that shares its
 * winding starts a new group; a ring of the opposite winding is a hole of the
 * group before it. This is the standard MVT ring-classification step.
 *
 * Without it every ring was tested independently, so a point sitting inside a
 * hole matched the enclosing outer ring first and was wrongly reported as
 * contained.
 */
type RingGroup = { outer: { x: number; y: number }[]; holes: { x: number; y: number }[][]; area: number }

function groupRings(rings: { x: number; y: number }[][]): RingGroup[] {
  const groups: RingGroup[] = []
  let outerSign = 0
  for (const ring of rings) {
    if (ring.length < 4) continue
    const signed = signedRingArea(ring)
    if (signed === 0) continue
    const sign = signed < 0 ? -1 : 1
    if (outerSign === 0) outerSign = sign
    if (sign === outerSign) {
      groups.push({ outer: ring, holes: [], area: Math.abs(signed) })
    } else if (groups.length > 0) {
      groups[groups.length - 1].holes.push(ring)
    }
  }
  return groups
}

/**
 * Distance from a point to the nearest segment of a ring or line, in tile units.
 *
 * `closed` controls whether the last vertex joins back to the first. A polygon
 * ring is closed; a linestring is not, and treating one as closed invents a
 * segment that does not exist, which can report a river as much nearer than it
 * really is when its two endpoints sit either side of the point.
 */
function distanceToRing(
  px: number,
  py: number,
  ring: { x: number; y: number }[],
  closed = true,
): number {
  let best = Infinity
  const start = closed ? 0 : 1
  for (let i = start, j = closed ? ring.length - 1 : 0; i < ring.length; j = i++) {
    const ax = ring[j].x - px
    const ay = ring[j].y - py
    const bx = ring[i].x - px
    const by = ring[i].y - py
    const dx = bx - ax
    const dy = by - ay
    const seg = dx * dx + dy * dy
    let d: number
    if (seg <= 0) {
      d = Math.hypot(ax, ay)
    } else {
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / seg))
      d = Math.hypot(ax + t * dx, ay + t * dy)
    }
    if (d < best) best = d
  }
  return best
}

/**
 * How far outside a polygon still counts as "at" that place, in metres.
 *
 * Strict containment is too strict against real photo coordinates: measured
 * against the sample photos, one sits 99 m outside Waterfront Park and another
 * 30 m outside Magnolia Park. Both are plainly the right answer. OSM boundaries
 * also do not always follow where a person can stand, and GPS carries its own
 * error. Production hides this by asking Geoapify for a 1 km radius rather than
 * containment; this is the same idea.
 *
 * Why 2000 and not the earlier 120. Measured over 20,000 iNat coordinates, the
 * buffer is the single largest lever on coverage: 120 m names 57.8%, 1000 m
 * names 75.8%, 2000 m names 81.5%. For an auto-detect UX a named place slightly
 * too far away beats a null, so the wider buffer is the better product.
 *
 * The buffer is bounded by the TILE, not by this constant: only the tile
 * containing the point is read, so a candidate past its edge is invisible no
 * matter how large the buffer is. That is why this moved in lockstep with the
 * drop to z12. At z13 a tile is 3.3 km wide in Seattle and the half-tile is
 * 1649 m, so a 2000 m buffer reached past the edge and behaved inconsistently
 * with where in the tile the point happened to land. At z12 the tile is 6.6 km
 * and the half-tile 3299 m.
 *
 * That does NOT mean every point sees a full 2 km in all directions: a point
 * near an edge sees less on that side, so a seam miss is possible in
 * principle. Two things keep it small in practice. Tippecanoe CLIPS each
 * polygon to the tiles it covers, so a large feature spanning a boundary is
 * present in BOTH tiles and containment still resolves. Only a feature lying
 * wholly beyond the edge can be missed.
 *
 * Measured over 400 real coordinates, comparing the own-tile answer against
 * the best answer from the full 3x3 neighbourhood: a neighbour held a nearer
 * named feature 4.8% of the time, but in most of those it was the SAME place
 * reached from its other side. A genuinely DIFFERENT name won 1.3% of the
 * time, and those are near-ties between two plausible answers, e.g. Church
 * Street Park at 1855 m against Ponds at Apple Park at 1828 m.
 *
 * Reading the 3x3 neighbourhood would fix that 1.3% at 9 times the R2 reads on
 * every request. For a name the user can edit in one tap, that is the wrong
 * trade. Revisit if the picker list ever becomes the primary path.
 */
const NEAR_MISS_M = 2000

/**
 * A single candidate place.
 *
 * This is `Ranked` from `place-rank.ts`, re-exported rather than a second type.
 * The older local `PlaceHit` carried `mode: 'inside' | 'near'` where `Ranked`
 * carries `contained: boolean`; both hold the same fact, and the old
 * `rankCandidates` had to convert the string back into a boolean before it
 * could sort. `Ranked` also carries `kind`, the coarse label that makes a
 * ranking change auditable. Callers that want the old wording can read
 * `contained ? 'inside' : 'near'`.
 */
export type { Ranked }

/**
 * Every candidate for a coordinate, best first.
 *
 * SFO Museum's global point-in-polygon service returns all places containing a
 * point and lets the caller choose: their example gives one photo two answers,
 * taken "from" the Super Bay Hangar and "depicts" Runway 01R/19L
 * (millsfield.sfomuseum.org/blog/2022/12/19/pmtiles-pip/). The same holds here.
 * At Lake Como the tile holds the lake 19 m away, Lungolago at 6 m and a hotel
 * at 37 m, and all three are true answers to "where is this?". Collapsing to
 * one is guaranteed to be wrong sometimes, so callers that can show
 * alternatives should use this; `lookupPlace` stays the single-answer path.
 */
export async function lookupPlaces(
  pmtiles: PMTiles,
  lat: number,
  lon: number,
  limit = 25,
): Promise<Ranked[]> {
  return rankCandidates(await collectCandidates(pmtiles, lat, lon)).slice(0, limit)
}

export async function lookupPlace(
  pmtiles: PMTiles,
  lat: number,
  lon: number,
): Promise<Ranked | null> {
  const ranked = rankCandidates(await collectCandidates(pmtiles, lat, lon))
  return ranked.length > 0 ? ranked[0] : null
}

/**
 * Read a feature's Wikipedia-derived importance, baked in at build time.
 *
 * Nominatim's own measure: how many articles link to a place, across languages
 * and including redirects. Their published table is 19M rows and reduces to
 * 3.58M distinct Wikidata QIDs, which is far too much to ship inside a Worker
 * or to query per request.
 *
 * So the join happens in `scripts/osm-places/join-importance.py`, between
 * osmium and tippecanoe, and the archive carries the RESULT rather than the
 * join key. That is why this reads a plain tag and needs no lookup table, no
 * extra R2 object, and no D1 round trip: the value arrives with the feature
 * that was already decoded.
 *
 * Stored quantised to 0..255 and returned as 0..1. A byte is plenty for what
 * is only ever the third tie-breaker, after containment and category.
 *
 * About a quarter of named features have one (measured on the shipped archive:
 * 12,474 of 48,143 named features carry a QID, and 32% of those QIDs have a
 * Wikipedia article). That is exactly why it is a tie-breaker and never a sort
 * key: ranking on it earlier would let Wikipedia's coverage decide geography,
 * and the large majority without an article would always lose.
 */
function importanceOf(props: Record<string, unknown>): number | undefined {
  const raw = props.importance
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
  // Guard the range rather than trusting the archive: a malformed value must
  // not push a candidate above a legitimately more important one.
  if (raw < 0 || raw > 255) return undefined
  return raw / 255
}

/** A coordinate resolved to a tile address plus its position inside it. */
interface TileAddress {
  tileX: number
  tileY: number
  worldX: number
  worldY: number
  latRad: number
  tileSpanM: number
}

/**
 * Resolve a coordinate to a tile address plus its position inside that tile.
 *
 * Shared by the place lookup and the ISO-code lookup so the two cannot drift.
 * The bounds handling in here is load-bearing and was a real bug: see the
 * comments below.
 */
/**
 * Resolve a coordinate to a tile address, or null when the archive cannot
 * represent it.
 *
 * Shared by the place lookup and the ISO-code lookup so the two cannot drift.
 * The bounds handling in here is load-bearing and was a real bug: see the
 * comments below.
 */
function tileAddressFor(lat: number, lon: number): TileAddress | null {
  const n = 2 ** ZOOM
  // parseCoordinate accepts the full lon/lat domain, but the tile maths does
  // not wrap or clamp on its own.
  //
  // Longitude is continuous across the antimeridian, so WRAP it modulo the
  // world width: at lon=180 the raw column is n, which IS column 0. That is a
  // faithful transformation, not an approximation.
  //
  // Latitude beyond the Web Mercator limit is different: the projection does
  // not define it at all. This used to CLAMP, which silently answered about a
  // different place: a request for the North Pole was looked up at 85.051
  // degrees, roughly 550 km away, and could return a park or a jurisdiction
  // that has nothing to do with the coordinate asked about. A confident wrong
  // answer is worse than none, so a polar coordinate now returns null and the
  // caller reports "no named place", which is true: the archive has no tiles
  // there.
  const MERC_MAX_LAT = 85.0511287798066
  if (!(Math.abs(lat) <= MERC_MAX_LAT)) return null
  const latRad = (lat * Math.PI) / 180
  const rawX = ((lon + 180) / 360) * n
  const worldX = ((rawX % n) + n) % n
  const worldY = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  const tileX = Math.floor(worldX)
  // Exactly at the limit, floating-point rounding can land worldY a hair
  // outside [0, n); pin the row into range.
  const tileY = Math.min(n - 1, Math.max(0, Math.floor(worldY)))
  // Metres per tile unit at this latitude, so a buffer can be expressed in
  // metres rather than in tile-local integers.
  const tileSpanM = (40075016.686 * Math.cos(latRad)) / 2 ** ZOOM
  return { tileX, tileY, worldX, worldY, latRad, tileSpanM }
}

async function collectCandidates(
  pmtiles: PMTiles,
  lat: number,
  lon: number,
): Promise<Ranked[]> {
  const address = tileAddressFor(lat, lon)
  if (!address) return []
  const resp = await pmtiles.getZxy(ZOOM, address.tileX, address.tileY)
  if (!resp) return []
  return candidatesFromTile(new VectorTile(new PbfReader(new Uint8Array(resp.data))), address)
}

function candidatesFromTile(
  tile: VectorTile,
  address: TileAddress,
): Ranked[] {
  const { tileX, tileY, worldX, worldY, tileSpanM } = address
  const layer = tile.layers.parks
  if (!layer) return []

  // MVT quantizes geometry to `extent` integer units across the tile. At z12 one
  // unit is about 2.4 m, well below what matters for naming a birding location:
  // measured over 20k coordinates, z12 named MORE than z13 at every buffer
  // (75.8% vs 75.2% at 1000 m, 81.5% vs 80.3% at 2000 m), so the coarser
  // quantization costs nothing here.
  const px = (worldX - tileX) * layer.extent
  const py = (worldY - tileY) * layer.extent

  const nearMissUnits = (NEAR_MISS_M / tileSpanM) * layer.extent

  const inside: Ranked[] = []
  const near: Ranked[] = []
  for (let i = 0; i < layer.length; i++) {
    const feat = layer.feature(i)
    const props = feat.properties as Record<string, unknown>
    const name = nameOf(props)
    if (!name) continue
    const tagScore = scoreOf(props)
    if (tagScore === 0) continue

    // MVT geometry type: 1 point, 2 linestring, 3 polygon. Points and lines can
    // never contain the coordinate, but they can be NEAR it. This matters most
    // for point-heavy fallbacks such as hamlets, farms and isolated dwellings:
    // without an explicit point path, `groupRings` discards their one-vertex
    // geometry and those archived names are permanently unreachable.
    const isPoint = feat.type === 1
    const isLine = feat.type === 2

    if (isPoint) {
      let nearestDistance = Infinity
      for (const points of feat.loadGeometry()) {
        for (const point of points) {
          nearestDistance = Math.min(nearestDistance, Math.hypot(point.x - px, point.y - py))
        }
      }
      if (nearestDistance <= nearMissUnits) {
        near.push({
          name,
          score: nearScoreOf(props, tagScore),
          area: 0,
          contained: false,
          distanceM: Math.round((nearestDistance / layer.extent) * tileSpanM),
          kind: kindOf(props),
          importance: importanceOf(props),
        })
      }
      continue
    }

    if (isLine) {
      let nearestDistance = Infinity
      for (const ring of feat.loadGeometry()) {
        // A line needs 2 vertices to exist.
        if (ring.length < 2) continue
        nearestDistance = Math.min(nearestDistance, distanceToRing(px, py, ring, false))
      }
      if (nearestDistance <= nearMissUnits) {
        near.push({
          name,
          score: nearScoreOf(props, tagScore),
          area: 0,
          contained: false,
          distanceM: Math.round((nearestDistance / layer.extent) * tileSpanM),
          kind: kindOf(props),
          importance: importanceOf(props),
        })
      }
      continue
    }

    // Group the feature's rings into outer rings each carrying their holes, so
    // a point inside a hole is NOT counted as inside the polygon. MVT stores an
    // outer ring followed by its holes with opposite winding; testing each ring
    // independently, as this used to, matched the outer ring first for a point
    // in a hole and reported false containment (e.g. the water inside "Golfe du
    // Morbihan").
    const groups = groupRings(feat.loadGeometry())

    // Resolve containment for the whole feature before considering proximity.
    // A multipolygon can have a nearby outer ring before the outer ring that
    // actually contains the point.
    const containingGroup = groups.find(({ outer, holes }) => {
      const inOuter = pointInRing(px, py, outer)
      return inOuter && !holes.some((h) => pointInRing(px, py, h))
    })
    if (containingGroup) {
      const { outer, area } = containingGroup
      // `scoreOf` sees tags only, so it cannot tell Cozumel from a 3-hectare
      // islet. Area is known here, so the size cap is applied here.
      const score = capOversized(
        props,
        tagScore,
        area,
        layer.extent,
        undefined,
        spansTile(outer, layer.extent),
      )
      inside.push({
        name,
        score,
        area,
        contained: true,
        distanceM: 0,
        kind: kindOf(props),
        importance: importanceOf(props),
      })
      continue
    }

    // Near tier: choose the nearest edge across every outer ring and hole in
    // the feature. A hole rim is a real edge you can stand beside, so a point
    // just inside a hole still measures its distance to that rim.
    let nearestGroup: RingGroup | undefined
    let nearestDistance = Infinity
    for (const group of groups) {
      let d = distanceToRing(px, py, group.outer, true)
      for (const h of group.holes) {
        const dh = distanceToRing(px, py, h, true)
        if (dh < d) d = dh
      }
      if (d < nearestDistance) {
        nearestDistance = d
        nearestGroup = group
      }
    }
    if (nearestGroup && nearestDistance <= nearMissUnits) {
      const { outer, area } = nearestGroup
      const score = capOversized(
        props,
        tagScore,
        area,
        layer.extent,
        undefined,
        spansTile(outer, layer.extent),
      )
      near.push({
        name,
        // An enclosure only counts when the point is INSIDE it, so the near
        // tier gets the demoted score. See `nearScoreOf`.
        score: nearScoreOf(props, score),
        area,
        contained: false,
        distanceM: Math.round((nearestDistance / layer.extent) * tileSpanM),
        kind: kindOf(props),
        importance: importanceOf(props),
      })
    }
  }

  // Ordering is `rankCandidates`'s job, so both tiers come back unsorted.
  return [...inside, ...near]
}

/**
 * Default archive key.
 *
 * The key is VERSIONED per build, and that is load-bearing, not cosmetic. Two
 * warm caches in this module are keyed only by the archive key: DIRECTORY_CACHE
 * holds the header and directory bytes, and INSTANCES holds a PMTiles instance
 * with its own decoded-directory cache. Replacing the R2 object IN PLACE under a
 * stable key leaves a long-lived isolate serving the old header and directories
 * against new tile bytes, which reads as stale or corrupt results until the
 * isolate recycles. So every build must upload under a NEW key and bump this
 * constant in lockstep; the changed value evicts both caches for free.
 *
 * The bucket holds exactly ONE archive: the key below. Earlier spike archives
 * (a 15 MB Washington extract, a 6.0 GB park-only planet build, and an
 * undated place-all) were deleted once this one was verified, because a stale
 * archive is not a useful rollback: the layers and tag set differ between
 * builds, so an older object would answer with a schema this code no longer
 * expects.
 *
 * Rolling back therefore means rebuilding and uploading under a new dated key,
 * not repointing at an old object. `scripts/osm-places/build-global.sh` is
 * deterministic given a Geofabrik snapshot, and the build takes about 96
 * minutes.
 *
 * History of what the current archive replaced, kept because the numbers
 * explain the tag choices:
 *
 * - Park-like tags only left 18.5% of coordinates with no named feature
 *   within 2 km.
 * - Adding every `natural=*` and `place=*` took coverage 81.5% -> 93.2% while
 *   making the archive SMALLER, 6.0 GB -> 1.6 GB, because the park build
 *   carried every tag osmium exports by default and this one keeps only the
 *   nine the ranker reads. Lookups also got faster, 1.30 -> 0.98 ms.
 * - The current build adds the `admin` layer carrying ISO 3166 codes.
 * - The 20260828 archive is the 20260827 one with corrected metadata, written
 *   in place by `pmtiles edit` in under two seconds rather than rebuilt. It
 *   now carries the ODbL attribution and license URI that ODbL 4.2(b) asks to
 *   travel with a derivative database, and drops the tippecanoe
 *   `generator_options` blob, which held build scratch paths and nothing a
 *   consumer needs. Tile bytes are untouched: the same 11 worldwide lookups
 *   return identical answers.
 */
export const PLACES_KEY = 'places-20260828.pmtiles'

export function createPMTiles(bucket: ReadonlyR2Bucket, key = PLACES_KEY): PMTiles {
  // `ResolvedValueCache`, not the `SharedPromiseCache` default. Cloudflare
  // Workers cannot share a promise across requests, and this instance is held
  // in a module-level map, so a later request that awaited a header or
  // directory promise created under an earlier request context fails with a
  // cross-request I/O error. `ResolvedValueCache` stores resolved values, which
  // are safe to reuse, and gives the same re-parse savings.
  return new PMTiles(new R2Source(bucket, key), new ResolvedValueCache())
}

/**
 * PMTiles instances hold their own decoded-directory cache, so reusing one
 * across requests in the same isolate avoids re-parsing on every lookup.
 */
const INSTANCES = new Map<string, PMTiles>()

export function getPMTiles(bucket: ReadonlyR2Bucket, key = PLACES_KEY): PMTiles {
  let pm = INSTANCES.get(key)
  if (!pm) {
    pm = createPMTiles(bucket, key)
    INSTANCES.set(key, pm)
  }
  return pm
}

/**
 * ODbL attribution for the archive.
 *
 * The archive is a Produced Work under ODbL 1.4.1, which requires the notice to
 * accompany it. Defined here, next to the data it describes, so the route and
 * any future consumer share one string rather than each hard-coding a copy that
 * can drift.
 */
export const PLACES_ATTRIBUTION = '(c) OpenStreetMap contributors, ODbL 1.0'

/** ISO 3166 codes for the administrative area containing a coordinate. */
export interface RegionCodes {
  /** ISO 3166-2 subdivision code, e.g. "CU-03" or "US-WA". */
  stateProvince?: string
  /** ISO 3166-1 alpha-2 country code, e.g. "CU". */
  countryCode?: string
}

/**
 * A subdivision code implies its country: ISO 3166-2 is defined as the alpha-2
 * country code, a hyphen, then up to three more characters. Deriving the
 * country this way rather than requiring a separate admin_level=2 polygon in
 * the same tile matters, because a tile well inside a country often contains
 * the state boundary but not the national one.
 */
const ISO_3166_2 = /^([A-Z]{2})-([A-Z0-9]{1,3})$/

/**
 * Find the ISO 3166 codes for the administrative area containing a coordinate.
 *
 * A SECOND containment pass, against the `admin` layer rather than `parks`.
 * The two answer different questions and must not be conflated: `parks` says
 * what a place is called ("Union Bay Natural Area"), `admin` says which
 * jurisdiction it sits in ("US-WA"). The eBird export needs the second.
 *
 * Smallest match wins. A coordinate is inside its country AND its state, and
 * the state is the more precise answer, so candidates are ordered by polygon
 * area. Sorting rather than trusting feature order matters because MVT gives no
 * ordering guarantee.
 *
 * Returns an empty object rather than null when nothing matches, so a caller
 * can spread it unconditionally. Missing codes are NORMAL: measured on
 * central-america, 335 of 2,237 admin polygons at levels 2-4 carry one, and a
 * coordinate in a country that has not mapped its subdivisions gets no state.
 */
export async function lookupRegionCodes(
  pmtiles: PMTiles,
  lat: number,
  lon: number,
): Promise<RegionCodes> {
  const address = tileAddressFor(lat, lon)
  if (!address) return {}
  const resp = await pmtiles.getZxy(ZOOM, address.tileX, address.tileY)
  if (!resp) return {}
  return regionCodesFromTile(new VectorTile(new PbfReader(new Uint8Array(resp.data))), address)
}

function regionCodesFromTile(tile: VectorTile, address: TileAddress): RegionCodes {
  const { tileX, tileY, worldX, worldY } = address
  const layer = tile.layers.admin
  // An archive built before the admin layer existed simply has no codes. That
  // is a coverage answer, not an error, so it degrades to "unknown" rather
  // than throwing.
  if (!layer) return {}

  const px = (worldX - tileX) * layer.extent
  const py = (worldY - tileY) * layer.extent

  const matches: { area: number; state?: string; country?: string }[] = []
  for (let i = 0; i < layer.length; i++) {
    const feat = layer.feature(i)
    const props = feat.properties as Record<string, unknown>
    const state = typeof props['ISO3166-2'] === 'string' ? props['ISO3166-2'] : undefined
    const canonicalCountry = typeof props['ISO3166-1:alpha2'] === 'string'
      ? props['ISO3166-1:alpha2']
      : undefined
    const legacyCountry = typeof props['ISO3166-1'] === 'string' ? props['ISO3166-1'] : undefined
    const country = canonicalCountry ?? legacyCountry
    // A boundary with no ISO code cannot answer the question, so skip it before
    // doing any geometry work.
    if (!state && !country) continue

    // Same hole-aware containment the place lookup uses: a point in an enclave
    // is not inside the polygon that surrounds it.
    const groups = groupRings(feat.loadGeometry())
    let area = 0
    let hit = false
    for (const { outer, holes } of groups) {
      if (pointInRing(px, py, outer) && !holes.some((h) => pointInRing(px, py, h))) {
        hit = true
        area = Math.abs(signedRingArea(outer))
        break
      }
    }
    if (hit) matches.push({ area, state, country })
  }

  if (matches.length === 0) return {}
  matches.sort((a, b) => a.area - b.area)

  // The state code is the more precise answer, so it comes from the smallest
  // containing area.
  const state = matches.find((m) => m.state)?.state

  // Derive the country FROM the subdivision code, and prefer that over any
  // canonical or legacy ISO 3166-1 tag on the same polygon.
  //
  // This is not a micro-optimization, it is a correctness fix found against the
  // real archive. Puerto Rico's admin_level=4 boundary carries BOTH
  // `ISO3166-2=US-PR` and `ISO3166-1=PR`, because PR is separately listed in
  // ISO 3166-1 as a dependent territory. Trusting the tag yielded
  // `countryCode="PR"`, which eBird would reject: the checklist belongs to US.
  // The subdivision code is unambiguous about which country owns the
  // subdivision, so it wins whenever it parses.
  const impliedCountry = state ? ISO_3166_2.exec(state)?.[1] : undefined
  const taggedCountry = matches.find((m) => m.country)?.country

  return {
    stateProvince: state,
    countryCode: impliedCountry ?? taggedCountry,
  }
}

/**
 * Look up the named places AND the region codes for a coordinate in ONE tile
 * read.
 *
 * Both layers live in the SAME z/x/y tile, so calling `lookupPlaces` and
 * `lookupRegionCodes` separately fetches and decodes identical bytes twice.
 * Measured against the planet archive, the second call was a real extra R2
 * range GET of 10 to 18 KB on every reverse-geocode request: the tile body sits
 * far past CACHEABLE_PREFIX_BYTES in a 1.6 GB archive, so the directory cache
 * does not cover it.
 *
 * The single-layer functions are kept because they are the honest API when a
 * caller genuinely wants one answer, and the tests exercise them directly.
 */
export async function lookupPlacesWithRegion(
  pmtiles: PMTiles,
  lat: number,
  lon: number,
  limit = 25,
): Promise<{ places: Ranked[]; regionCodes: RegionCodes }> {
  const address = tileAddressFor(lat, lon)
  if (!address) return { places: [], regionCodes: {} }
  const resp = await pmtiles.getZxy(ZOOM, address.tileX, address.tileY)
  if (!resp) return { places: [], regionCodes: {} }

  const tile = new VectorTile(new PbfReader(new Uint8Array(resp.data)))
  return {
    places: rankCandidates(candidatesFromTile(tile, address)).slice(0, limit),
    regionCodes: regionCodesFromTile(tile, address),
  }
}
