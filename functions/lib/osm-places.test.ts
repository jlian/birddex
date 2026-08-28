import { describe, expect, it } from 'vitest'
import { PbfWriter, PbfReader } from 'pbf'
import { VectorTile } from '@mapbox/vector-tile'
import { PMTiles, type Source, type RangeResponse } from 'pmtiles'
import { lookupPlace, lookupPlaces, lookupPlacesWithRegion, lookupRegionCodes } from './osm-places'
import { MAX_TILE_FRACTION, NEAR_BAND_M, OVERSIZED_SCORE, REAL_PLACE_FLOOR, SPAN_CORNER_MIN_FRACTION, capOversized, kindOf, nearScoreOf, rankCandidates, scoreOf, spansTile } from './place-rank'

/**
 * Tests for the oversized-polygon cap.
 *
 * Nothing covered `osm-places.ts` before this file. The regression it guards
 * against is real and was found by measurement, not by review: raising
 * `place=island` to tier 21 made five iNat coordinates return "Sri Lanka",
 * "Madagascar" and "Taiwan" in place of the hotel that used to win, because the
 * tag is the same on Borneo and on a 3-hectare islet.
 *
 * The tile is synthesised rather than read from a fixture archive, so the test
 * states the geometry it depends on instead of hiding it in a binary.
 */

const EXTENT = 4096
// Must track ZOOM in osm-places.ts. The fixture builds a tile at a specific
// z/x/y and `coordAt` derives a coordinate inside it, so a mismatch means the
// lookup asks for a tile address the fixture never wrote, and every case
// degrades to "no tile" rather than failing loudly.
const ZOOM = 12

type Ring = [number, number][]
interface Feat {
  props: Record<string, string>
  type?: 1 | 3
  points?: Ring
  // A simple single-ring polygon, or `rings` for an outer ring plus holes. MVT
  // winds a hole opposite to its outer ring, which the fixtures below do by
  // hand.
  ring?: Ring
  rings?: Ring[]
}

const zigzag = (v: number) => (v << 1) ^ (v >> 31)

/** MVT geometry commands for one or more rings sharing one cursor. */
function ringsGeometry(rings: Ring[]): number[] {
  const g: number[] = []
  let cx = 0
  let cy = 0
  for (const pts of rings) {
    g.push(1 | (1 << 3)) // MoveTo, 1 point
    g.push(zigzag(pts[0][0] - cx), zigzag(pts[0][1] - cy))
    cx = pts[0][0]
    cy = pts[0][1]
    g.push(2 | ((pts.length - 1) << 3)) // LineTo, n-1 points
    for (let i = 1; i < pts.length; i++) {
      g.push(zigzag(pts[i][0] - cx), zigzag(pts[i][1] - cy))
      cx = pts[i][0]
      cy = pts[i][1]
    }
    g.push(7 | (1 << 3)) // ClosePath
  }
  return g
}

/** MVT geometry commands for one point or multipoint feature. */
function pointsGeometry(points: Ring): number[] {
  const g = [1 | (points.length << 3)] // MoveTo, n points
  let cx = 0
  let cy = 0
  for (const [x, y] of points) {
    g.push(zigzag(x - cx), zigzag(y - cy))
    cx = x
    cy = y
  }
  return g
}

/** A single-layer vector tile named `parks`, which is the layer the code reads. */
function buildTile(features: Feat[], layerName = 'parks'): Uint8Array {
  const keys: string[] = []
  const keyIndex = new Map<string, number>()
  const values: string[] = []
  const valueIndex = new Map<string, number>()

  const encoded = features.map(f => {
    const tags: number[] = []
    for (const [k, v] of Object.entries(f.props)) {
      if (!keyIndex.has(k)) {
        keyIndex.set(k, keys.length)
        keys.push(k)
      }
      if (!valueIndex.has(v)) {
        valueIndex.set(v, values.length)
        values.push(v)
      }
      tags.push(keyIndex.get(k)!, valueIndex.get(v)!)
    }
    const type = f.type ?? 3
    const geometry = type === 1
      ? pointsGeometry(f.points!)
      : ringsGeometry(f.rings ?? [f.ring!])
    return { tags, geometry, type }
  })

  const w = new PbfWriter()
  w.writeMessage(
    3,
    (_unused, layer) => {
      layer.writeVarintField(15, 2) // version
      layer.writeStringField(1, layerName)
      layer.writeVarintField(5, EXTENT)
      for (const f of encoded) {
        layer.writeMessage(
          2,
          (_u, feat) => {
            feat.writePackedVarint(2, f.tags)
            feat.writeVarintField(3, f.type)
            feat.writePackedVarint(4, f.geometry)
          },
          null,
        )
      }
      for (const k of keys) layer.writeStringField(3, k)
      for (const v of values) {
        layer.writeMessage(4, (_u, val) => val.writeStringField(1, v), null)
      }
    },
    null,
  )
  return w.finish()
}

/** Serve one fixed tile for every request, so no archive file is needed. */
function pmtilesOf(tile: Uint8Array): PMTiles {
  const source: Source = {
    getKey: () => 'test',
    getBytes: async (): Promise<RangeResponse> => {
      throw new Error('unused')
    },
  }
  const pm = new PMTiles(source)
  pm.getZxy = async () => ({
    data: tile.buffer.slice(tile.byteOffset, tile.byteOffset + tile.byteLength) as ArrayBuffer,
  })
  return pm
}

/** Tile-local pixel -> a lat/lon that lands on it, so the real code path runs. */
function coordAt(px: number, py: number): [number, number] {
  const n = 2 ** ZOOM
  // Tile 0/0 is near the north pole, where cos(lat) is tiny and the
  // metre-per-unit conversion degenerates. Use a mid-latitude tile instead.
  // These are the z12 parents of the z13 tile this fixture used before, so it
  // still lands over Seattle.
  const tileX = 655
  const tileY = 1430
  const worldX = tileX + px / EXTENT
  const worldY = tileY + py / EXTENT
  const lon = (worldX / n) * 360 - 180
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * worldY) / n))) * 180) / Math.PI
  return [lat, lon]
}

const square = (x0: number, y0: number, size: number): Ring => [
  [x0, y0],
  [x0 + size, y0],
  [x0 + size, y0 + size],
  [x0, y0 + size],
]

describe('capOversized', () => {
  const island = { place: 'island', name: 'X' }
  const tileArea = EXTENT * EXTENT

  it('leaves a small island at its tag tier', () => {
    const small = 0.01 * tileArea
    expect(capOversized(island, scoreOf(island), small, EXTENT)).toBe(21)
  })

  it('demotes an island that covers more than the threshold', () => {
    const huge = 0.9 * tileArea
    expect(capOversized(island, scoreOf(island), huge, EXTENT)).toBe(OVERSIZED_SCORE)
  })

  it('demotes rather than drops, so an oversized island is still an answer', () => {
    expect(OVERSIZED_SCORE).toBeGreaterThan(0)
  })

  it('is applied strictly above the threshold, not at it', () => {
    const exact = MAX_TILE_FRACTION * tileArea
    expect(capOversized(island, scoreOf(island), exact, EXTENT)).toBe(21)
    expect(capOversized(island, scoreOf(island), exact + 1, EXTENT)).toBe(OVERSIZED_SCORE)
  })

  it('does not touch water, which the 20k-coordinate run showed does not need it', () => {
    const lake = { natural: 'water', name: 'Lake Superior' }
    const huge = 0.99 * tileArea
    expect(capOversized(lake, scoreOf(lake), huge, EXTENT)).toBe(scoreOf(lake))
  })

  it('does not touch parks or protected areas', () => {
    const huge = 0.99 * tileArea
    for (const props of [
      { leisure: 'park', name: 'P' },
      { boundary: 'protected_area', name: 'R' },
    ]) {
      expect(capOversized(props, scoreOf(props), huge, EXTENT)).toBe(scoreOf(props))
    }
  })
})

describe('lookupPlace with an oversized island', () => {
  it('does not let a tile-filling island outrank a park containing the point', async () => {
    // A guard, not the teeth: `park` is tier 25 and `island` tier 21, so this
    // passes with the cap removed too. The case that actually needs the cap is
    // the hotel one below, where the island tier outranks lodging.
    const pm = pmtilesOf(
      buildTile([
        { props: { name: 'Borneo', place: 'island' }, ring: square(0, 0, EXTENT) },
        { props: { name: 'Bako National Park', leisure: 'park' }, ring: square(1800, 1800, 400) },
      ]),
    )
    const [lat, lon] = coordAt(2000, 2000)
    const hit = await lookupPlace(pm, lat, lon)
    expect(hit?.name).toBe('Bako National Park')
  })

  it('lets a small island outrank a hotel, which is the behaviour the tier is for', async () => {
    const pm = pmtilesOf(
      buildTile([
        { props: { name: 'Tern Island', place: 'island' }, ring: square(1900, 1900, 200) },
        { props: { name: 'Seaside Inn', tourism: 'hotel' }, ring: square(1980, 1980, 40) },
      ]),
    )
    const [lat, lon] = coordAt(2000, 2000)
    const hit = await lookupPlace(pm, lat, lon)
    expect(hit?.name).toBe('Tern Island')
  })

  it('lets a hotel win back when the only island is a whole country', async () => {
    // This is the measured regression: five iNat coordinates returned
    // "Sri Lanka" / "Madagascar" / "Taiwan" instead of the lodge on them.
    const pm = pmtilesOf(
      buildTile([
        { props: { name: 'Sri Lanka', place: 'island' }, ring: square(0, 0, EXTENT) },
        {
          props: { name: 'Borderlands Eco Lodge', tourism: 'hotel' },
          ring: square(1980, 1980, 40),
        },
      ]),
    )
    const [lat, lon] = coordAt(2000, 2000)
    const hit = await lookupPlace(pm, lat, lon)
    expect(hit?.name).toBe('Borderlands Eco Lodge')
  })

  it('still returns the oversized island when nothing else contains the point', async () => {
    // Demote, do not drop: "Vancouver Island" beats null for an auto-detect UX.
    const pm = pmtilesOf(
      buildTile([{ props: { name: 'Madagascar', place: 'island' }, ring: square(0, 0, EXTENT) }]),
    )
    const [lat, lon] = coordAt(2000, 2000)
    const hit = await lookupPlace(pm, lat, lon)
    expect(hit?.name).toBe('Madagascar')
    expect(hit?.score).toBe(OVERSIZED_SCORE)
  })

  it('ranks the oversized island last rather than removing it from the results', async () => {
    const pm = pmtilesOf(
      buildTile([
        { props: { name: 'Taiwan', place: 'island' }, ring: square(0, 0, EXTENT) },
        { props: { name: 'Guandu Nature Park', leisure: 'park' }, ring: square(1800, 1800, 400) },
      ]),
    )
    const [lat, lon] = coordAt(2000, 2000)
    const hits = await lookupPlaces(pm, lat, lon, 5)
    expect(hits.map(h => h.name)).toEqual(['Guandu Nature Park', 'Taiwan'])
  })
})

describe('museums and galleries are landmarks, not birding places', () => {
  it('ranks a museum below water, even when the water is further away', () => {
    // The measured failure: three Union Bay Natural Area photos resolved to the
    // Henry Art Gallery 1.25 km off, because `tourism=museum` shared tier 26
    // with a zoo. Nobody photographs a wild bird inside a museum.
    const museum = { name: 'Henry Art Gallery', tourism: 'museum' }
    const water = { name: 'Union Bay', natural: 'water' }
    expect(scoreOf(museum)).toBeLessThan(scoreOf(water))
  })

  it('keeps a zoo at the top, because a zoo IS where the photo was taken', () => {
    const zoo = { name: 'Taipei Zoo', tourism: 'zoo' }
    const park = { name: 'A Park', leisure: 'park' }
    expect(scoreOf(zoo)).toBeGreaterThan(scoreOf(park))
  })

  it('demotes rather than drops, so a museum still beats a null answer', () => {
    expect(scoreOf({ name: 'M', tourism: 'museum' })).toBeGreaterThan(0)
  })
})

describe('near-tier distance band', () => {
  const near = (name: string, score: number, distanceM: number) => ({
    name,
    score,
    area: 1,
    contained: false,
    distanceM,
    kind: 'k',
  })

  it('prefers a much closer candidate over a better class far away', () => {
    // Lake Como: the lake sat 20 m from the point and lost to a cathedral
    // 269 m inland, because class was the first sort key.
    const ranked = rankCandidates([near('Cathedral', 26, 900), near('Lake', 24, 20)])
    expect(ranked[0].name).toBe('Lake')
  })

  it('lets class decide inside one band, so GPS noise does not pick the answer', () => {
    const ranked = rankCandidates([near('Creek', 24, 10), near('Nature Reserve', 25, 60)])
    expect(ranked[0].name).toBe('Nature Reserve')
  })

  it('never lets a near candidate outrank a contained one', () => {
    const contained = {
      name: 'Inside',
      score: 19,
      area: 1,
      contained: true,
      distanceM: 0,
      kind: 'k',
    }
    const ranked = rankCandidates([near('Close', 26, 1), contained])
    expect(ranked[0].name).toBe('Inside')
  })

  it('is configurable, which is how the 600 m value was swept', () => {
    const cands = [near('Far Better', 26, 500), near('Near Worse', 24, 10)]
    expect(rankCandidates(cands, 1000)[0].name).toBe('Far Better')
    expect(rankCandidates(cands, 100)[0].name).toBe('Near Worse')
    expect(NEAR_BAND_M).toBe(100)
  })
})

describe('tile fixture', () => {
  it('round-trips through the same decoder the geocoder uses', () => {
    const tile = buildTile([{ props: { name: 'A', place: 'island' }, ring: square(0, 0, 100) }])
    const layer = new VectorTile(new PbfReader(tile)).layers.parks
    expect(layer.extent).toBe(EXTENT)
    expect(layer.length).toBe(1)
    expect(layer.feature(0).properties).toEqual({ name: 'A', place: 'island' })
  })
})

describe('point candidates', () => {
  it('returns a nearby point-mapped hamlet as a proximity fallback', async () => {
    const pm = pmtilesOf(buildTile([{
      props: { name: 'Birders Hamlet', place: 'hamlet' },
      type: 1,
      points: [[2200, 2000]],
    }]))
    const [lat, lon] = coordAt(2000, 2000)

    const hit = await lookupPlace(pm, lat, lon)

    expect(hit?.name).toBe('Birders Hamlet')
    expect(hit?.contained).toBe(false)
    expect(hit?.distanceM).toBeGreaterThan(0)
    expect(hit?.distanceM).toBeLessThan(NEAR_BAND_M * 10)
  })

  it('ignores a point outside the near-miss radius', async () => {
    const pm = pmtilesOf(buildTile([{
      props: { name: 'Distant Farm', place: 'farm' },
      type: 1,
      points: [[0, 0]],
    }]))
    const [lat, lon] = coordAt(4095, 4095)

    await expect(lookupPlace(pm, lat, lon)).resolves.toBeNull()
  })

  it('uses the nearest vertex of a multipoint feature once', async () => {
    const pm = pmtilesOf(buildTile([{
      props: { name: 'Scattered Settlement', place: 'hamlet' },
      type: 1,
      points: [[0, 0], [2050, 2000], [4095, 4095]],
    }]))
    const [lat, lon] = coordAt(2000, 2000)

    const hits = await lookupPlaces(pm, lat, lon)

    expect(hits).toHaveLength(1)
    expect(hits[0].name).toBe('Scattered Settlement')
    expect(hits[0].distanceM).toBeGreaterThan(0)
    expect(hits[0].distanceM).toBeLessThan(NEAR_BAND_M)
  })
})

describe('enclosures only count when they contain the point', () => {
  it('keeps a contained zoo at the top', () => {
    // Taipei Zoo is where the photo was taken, so containment must still win.
    expect(scoreOf({ name: 'Taipei Zoo', tourism: 'zoo' })).toBeGreaterThan(
      scoreOf({ name: 'A Park', leisure: 'park' }),
    )
  })

  it('demotes a zoo that is merely nearby', () => {
    // Measured: Seattle Aquarium at 168 m beat Waterfront Park at 97 m for
    // gulls on the waterfront. From outside the fence it is just a building.
    const props = { name: 'Seattle Aquarium', tourism: 'aquarium' }
    const full = scoreOf(props)
    expect(nearScoreOf(props, full)).toBeLessThan(full)
    expect(nearScoreOf(props, full)).toBeLessThan(scoreOf({ name: 'P', leisure: 'park' }))
  })

  it('leaves non-enclosure classes untouched', () => {
    const park = { name: 'P', leisure: 'park' }
    expect(nearScoreOf(park, scoreOf(park))).toBe(scoreOf(park))
  })
})

describe('POI markers do not outrank habitat', () => {
  it('ranks a lookout below a park', () => {
    // Cape Leeuwin Lighthouse at 355 m beat the national park it stands in at
    // 16 m, because Nominatim ranks tourism=attraction above leisure=park.
    expect(scoreOf({ name: 'Lookout', tourism: 'viewpoint' })).toBeLessThan(
      scoreOf({ name: 'Park', leisure: 'park' }),
    )
  })

  it('still ranks a marker above lodging, since it is a real outdoor place', () => {
    expect(scoreOf({ name: 'V', tourism: 'attraction' })).toBeGreaterThan(
      scoreOf({ name: 'H', tourism: 'hotel' }),
    )
  })
})

describe('landmass detection uses tile edges, not area', () => {
  const ring = (pts: Array<[number, number]>) => pts.map(([x, y]) => ({ x, y }))

  it('flags a polygon clipped on two edges', () => {
    // Barbados: clipped at x=4176 (right) and y=-80 (top), because the tile
    // catches a corner. Area read as 0.424 of a tile, under the 0.5 cap, so
    // area alone never caught it.
    expect(spansTile(ring([[1805, -80], [4176, -80], [4176, 3894], [1805, 3894]]), 4096)).toBe(true)
  })

  it('leaves a park wholly inside the tile alone', () => {
    expect(spansTile(ring([[1000, 1000], [2000, 1000], [2000, 2000], [1000, 2000]]), 4096)).toBe(false)
  })

  it('tolerates a feature touching a single edge', () => {
    // A bay or beach commonly runs off one side and is still a specific place.
    expect(spansTile(ring([[0, 1000], [2000, 1000], [2000, 2000], [0, 2000]]), 4096)).toBe(false)
  })

  it('caps an island that spans the tile even when its clipped area is small', () => {
    const props = { name: 'Puerto Rico', place: 'island' }
    const full = scoreOf(props)
    // Area is only 12.8% of the tile, so the fraction test passes it.
    expect(capOversized(props, full, 0.128 * 4096 * 4096, 4096)).toBe(full)
    // The span test catches it.
    expect(capOversized(props, full, 0.128 * 4096 * 4096, 4096, undefined, true)).toBe(OVERSIZED_SCORE)
  })
})

describe('an oversized polygon does not win on containment', () => {
  it('lets a nearby park beat the island containing it', () => {
    // Puerto Rico contained the point and beat a park 11m away, because a
    // capped score still sorted inside the contained tier.
    const island = { name: 'Puerto Rico', score: OVERSIZED_SCORE, area: 9e9, contained: true, distanceM: 0, kind: 'place' }
    const park = { name: 'Merendero de Guajataca', score: 25, area: 100, contained: false, distanceM: 11, kind: 'park' }
    expect(rankCandidates([island, park])[0].name).toBe('Merendero de Guajataca')
  })

  it('still returns the island when nothing else is near', () => {
    const island = { name: 'South Island', score: OVERSIZED_SCORE, area: 9e9, contained: true, distanceM: 0, kind: 'place' }
    expect(rankCandidates([island])[0].name).toBe('South Island')
  })
})

describe('duplicate entries are collapsed', () => {
  // `osmium export` emits a closed way as both a LineString and a Polygon, so
  // nearly every feature appears twice in the tile. Measured on the live route
  // over the 25 sample photos: 228 duplicate entries.

  const at = (name: string, kind: string, contained: boolean, distanceM: number) =>
    ({ name, score: 24, area: 100, contained, distanceM, kind })

  it('returns one entry per place', () => {
    const ranked = rankCandidates([at('Carp Inlet', 'water', false, 5), at('Carp Inlet', 'water', false, 5)])
    expect(ranked.map(c => c.name)).toEqual(['Carp Inlet'])
  })

  it('keeps the polygon twin that contains the point, not the line twin near it', () => {
    // This is why dedupe runs AFTER the sort. The line twin only measures
    // distance to an edge, so keeping it would silently downgrade a
    // containment fact to a proximity guess.
    const ranked = rankCandidates([
      at('Union Bay Natural Area', 'park', false, 12),
      at('Union Bay Natural Area', 'park', true, 0),
    ])
    expect(ranked).toHaveLength(1)
    expect(ranked[0].contained).toBe(true)
  })

  it('keeps the nearer twin when neither contains the point', () => {
    const ranked = rankCandidates([at('Ravenna Creek', 'water', false, 900), at('Ravenna Creek', 'water', false, 142)])
    expect(ranked).toHaveLength(1)
    expect(ranked[0].distanceM).toBe(142)
  })

  it('keeps two different places that share a name', () => {
    // "Central Park" the park and "Central Park" the neighbourhood are
    // genuinely different answers, so the key includes kind.
    const ranked = rankCandidates([at('Central Park', 'park', true, 0), at('Central Park', 'place', true, 0)])
    expect(ranked).toHaveLength(2)
  })

  it('does not disturb the order of distinct places', () => {
    const ranked = rankCandidates([at('Far', 'water', false, 900), at('Near', 'water', false, 10)])
    expect(ranked.map(c => c.name)).toEqual(['Near', 'Far'])
  })
})

describe('region-sized natural features do not win on containment', () => {
  // These came from wiring in the `place-all` archive, which widened the build
  // to every `natural=*` and `place=*`. Three of the 25 sample photos broke,
  // and in each the winner was a feature that genuinely contained the point and
  // was still useless as an answer.

  it('ranks a mountain range below a real place', () => {
    // "Tambo-Gruppe" (natural=mountain_range) contained the Lake Como
    // cormorant and beat the lake 20 m away.
    expect(scoreOf({ name: 'Tambo-Gruppe', natural: 'mountain_range' })).toBeLessThan(REAL_PLACE_FLOOR)
  })

  it('ranks a strait below a real place', () => {
    // "Strait of Juan de Fuca" (natural=strait) beat a wildlife refuge 441 m
    // away on two photos. Straits are water, but region-sized water.
    expect(scoreOf({ name: 'Strait of Juan de Fuca', natural: 'strait' })).toBeLessThan(REAL_PLACE_FLOOR)
  })

  it('keeps ordinary water above the floor', () => {
    // The demotion must be specific to region-sized landforms. A bay or a
    // wetland is exactly where the birds are.
    expect(scoreOf({ name: 'Skagit Bay', natural: 'bay' })).toBeGreaterThan(REAL_PLACE_FLOOR)
    expect(scoreOf({ name: 'A Marsh', natural: 'wetland' })).toBeGreaterThan(REAL_PLACE_FLOOR)
  })

  it('lets a nearby lake beat the mountain range containing it', () => {
    const range = { name: 'Tambo-Gruppe', score: scoreOf({ name: 'T', natural: 'mountain_range' }), area: 9e9, contained: true, distanceM: 0, kind: 'region' }
    const lake = { name: 'Lake Como', score: scoreOf({ name: 'L', natural: 'water' }), area: 100, contained: false, distanceM: 20, kind: 'water' }
    expect(rankCandidates([range, lake])[0].name).toBe('Lake Como')
  })

  it('still returns the range when nothing else is in range', () => {
    // Demote, do not drop. A region-sized answer beats a null.
    const range = { name: 'Alps', score: scoreOf({ name: 'A', natural: 'mountain_range' }), area: 9e9, contained: true, distanceM: 0, kind: 'region' }
    expect(rankCandidates([range])[0].name).toBe('Alps')
  })
})

describe('the administrative fallback is a last resort', () => {
  // 18.5% of 20,000 iNaturalist coordinates have no named OSM feature within
  // 2 km. `place=*` exists so those return "Dehua" rather than a raw latitude
  // and longitude, and must never beat a park, a lake or a reserve.

  it('ranks every admin place below a real place', () => {
    for (const place of ['hamlet', 'village', 'town', 'city', 'county', 'state', 'country']) {
      expect(scoreOf({ name: 'X', place })).toBeLessThan(REAL_PLACE_FLOOR)
    }
  })

  it('orders admin places by how precisely they locate a photo', () => {
    // A hamlet names a place you can stand in. A country does not.
    expect(scoreOf({ name: 'H', place: 'hamlet' })).toBeGreaterThan(scoreOf({ name: 'V', place: 'village' }))
    expect(scoreOf({ name: 'V', place: 'village' })).toBeGreaterThan(scoreOf({ name: 'C', place: 'city' }))
  })

  it('ranks a region-sized landform below every admin place', () => {
    // "Dehua" locates a photo; "the Alps" does not.
    expect(scoreOf({ name: 'A', natural: 'mountain_range' })).toBeLessThan(scoreOf({ name: 'C', place: 'country' }))
  })

  it('lets a park beat the city containing it', () => {
    // This is the bug the floor test was widened for. Keying the demotion on
    // OVERSIZED_SCORE scored 16 of 25 photos because "Seattle" and "China" are
    // contained and sorted above every near candidate; keying it on
    // REAL_PLACE_FLOOR scored 24 of 25.
    const city = { name: 'Seattle', score: scoreOf({ name: 'S', place: 'city' }), area: 9e9, contained: true, distanceM: 0, kind: 'admin' }
    const park = { name: 'Discovery Park', score: scoreOf({ name: 'D', leisure: 'park' }), area: 100, contained: false, distanceM: 181, kind: 'park' }
    expect(rankCandidates([city, park])[0].name).toBe('Discovery Park')
  })

  it('still returns the admin place when nothing else is near', () => {
    // The rural case the fallback was built for: one candidate in the tile.
    const town = { name: 'Dehua', score: scoreOf({ name: 'D', place: 'town' }), area: 9e9, contained: true, distanceM: 0, kind: 'admin' }
    expect(rankCandidates([town])[0].name).toBe('Dehua')
  })

  it('labels admin places with their own kind', () => {
    // `kind` is what makes a scoring change auditable from outside the code.
    expect(kindOf({ name: 'Seattle', place: 'city' })).toBe('admin')
    expect(kindOf({ name: 'Alps', natural: 'mountain_range' })).toBe('region')
    expect(kindOf({ name: 'A Suburb', place: 'suburb' })).toBe('place')
  })
})

describe('multipolygon candidates use the best outer ring', () => {
  it('reports containment when a later group contains the point', async () => {
    const pm = pmtilesOf(
      buildTile([{
        props: { name: 'Split Park', leisure: 'park' },
        rings: [square(1300, 1900, 200), square(1900, 1900, 200)],
      }]),
    )
    const [lat, lon] = coordAt(2000, 2000)
    const hits = await lookupPlaces(pm, lat, lon, 5)
    const park = hits.filter(h => h.name === 'Split Park')
    expect(park).toHaveLength(1)
    expect(park[0].contained).toBe(true)
    expect(park[0].distanceM).toBe(0)
  })

  it('uses the nearest distance when a later group is closer', async () => {
    const pm = pmtilesOf(
      buildTile([{
        props: { name: 'Split Reserve', boundary: 'protected_area' },
        rings: [square(1000, 1900, 200), square(1700, 1900, 200)],
      }]),
    )
    const [lat, lon] = coordAt(2000, 2000)
    const hits = await lookupPlaces(pm, lat, lon, 5)
    const reserve = hits.filter(h => h.name === 'Split Reserve')
    expect(reserve).toHaveLength(1)
    expect(reserve[0].contained).toBe(false)
    expect(reserve[0].distanceM).toBeGreaterThan(0)
    expect(reserve[0].distanceM).toBeLessThan(300)
  })
})

describe('polygon holes are not containing areas', () => {
  // A ring with the opposite winding to its outer ring is a hole. MVT stores
  // the outer ring first, so a point in the hole matched the outer ring first
  // and was wrongly reported inside. "Golfe du Morbihan" is the real case: the
  // gulf is a hole cut from the surrounding land polygon.
  const outer: Ring = square(1000, 1000, 2000)
  // Same rectangle wound the other way is a hole in the middle of the outer.
  const hole: Ring = [
    [1500, 1500],
    [1500, 2500],
    [2500, 2500],
    [2500, 1500],
  ]

  it('does not report containment for a point inside a hole', async () => {
    const pm = pmtilesOf(
      buildTile([{ props: { name: 'Ringed Land', leisure: 'park' }, rings: [outer, hole] }]),
    )
    const [lat, lon] = coordAt(2000, 2000) // dead centre of the hole
    const hits = await lookupPlaces(pm, lat, lon, 5)
    const contained = hits.filter(h => h.contained && h.name === 'Ringed Land')
    expect(contained).toEqual([])
  })

  it('still reports containment for a point in the solid part outside the hole', async () => {
    const pm = pmtilesOf(
      buildTile([{ props: { name: 'Ringed Land', leisure: 'park' }, rings: [outer, hole] }]),
    )
    const [lat, lon] = coordAt(1200, 1200) // inside outer, outside hole
    const hit = await lookupPlace(pm, lat, lon)
    expect(hit?.name).toBe('Ringed Land')
    expect(hit?.contained).toBe(true)
  })

  it('lets a small park inside the hole win over the ring around it', async () => {
    // A point in the hole is only NEAR the ring's edge, so a place that truly
    // contains it must win.
    const pm = pmtilesOf(
      buildTile([
        { props: { name: 'Ringed Land', leisure: 'park' }, rings: [outer, hole] },
        { props: { name: 'Island Garden', leisure: 'garden' }, ring: square(1900, 1900, 200) },
      ]),
    )
    const [lat, lon] = coordAt(2000, 2000)
    const hit = await lookupPlace(pm, lat, lon)
    expect(hit?.name).toBe('Island Garden')
    expect(hit?.contained).toBe(true)
  })

  it('keeps the near tier working for a point just inside a hole', async () => {
    // The hole rim is a real edge, so the ring is still a NEAR candidate.
    const pm = pmtilesOf(
      buildTile([{ props: { name: 'Ringed Land', leisure: 'park' }, rings: [outer, hole] }]),
    )
    const [lat, lon] = coordAt(2000, 2000)
    const hits = await lookupPlaces(pm, lat, lon, 5)
    const ring = hits.find(h => h.name === 'Ringed Land')
    expect(ring).toBeDefined()
    expect(ring?.contained).toBe(false)
    expect(ring?.distanceM).toBeGreaterThan(0)
  })
})

describe('extreme coordinates project to a valid tile', () => {
  // parseCoordinate accepts the full lon/lat domain, but the tile maths used to
  // neither wrap longitude nor clamp latitude, so lon=180 built column n,
  // lat=90 a negative row and lat=-90 an Infinite row: a throw or an unrelated
  // tile. The lookup must return a value, not throw, for all of them.
  const cases: Array<[string, number, number]> = [
    ['antimeridian lon=180', 0, 180],
    ['north pole lat=90', 90, 0],
    ['south pole lat=-90', -90, 0],
    ['lon just under 180', 0, 179.999],
  ]
  for (const [label, lat, lon] of cases) {
    it(`does not throw at ${label}`, async () => {
      // An empty tile is served, so the interesting part is that getZxy is
      // called with an in-range address rather than throwing on projection.
      const asked: Array<[number, number, number]> = []
      const pm = pmtilesOf(buildTile([]))
      const inner = pm.getZxy.bind(pm)
      pm.getZxy = async (z: number, x: number, y: number) => {
        asked.push([z, x, y])
        return inner(z, x, y)
      }
      await expect(lookupPlaces(pm, lat, lon, 5)).resolves.toEqual([])
      const n = 2 ** ZOOM
      for (const [, x, y] of asked) {
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThan(n)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y).toBeLessThan(n)
      }
    })
  }
})

describe('spansTile requires area for a corner clip', () => {
  const ring = (pts: Array<[number, number]>) => pts.map(([x, y]) => ({ x, y }))
  const E = 4096

  // A ring clipped at two ADJACENT edges (a corner) whose area equals a given
  // fraction of the tile. Anchored at the top-right corner, so it touches the
  // right (x=E) and top (y=E) edges.
  const cornerRing = (fraction: number) => {
    const side = Math.sqrt(fraction) * E
    return ring([
      [E - side, E - side],
      [E, E - side],
      [E, E],
      [E - side, E],
    ])
  }

  it('still demotes Taiwan: a corner clip covering a real share of the tile', () => {
    // Taiwan read as 2.43% of that tile on a corner clip and MUST stay demoted.
    expect(spansTile(cornerRing(0.0243), E)).toBe(true)
  })

  it('still demotes Barbados: a large right+top corner clip', () => {
    expect(spansTile(ring([[1805, -80], [4176, -80], [4176, 3894], [1805, 3894]]), E)).toBe(true)
  })

  it('no longer misfires on Fox Island: a tiny corner-touching islet', () => {
    // Fox Island covered 0.32% of the tile at a corner, well under the floor.
    expect(spansTile(cornerRing(0.0032), E)).toBe(false)
  })

  it('no longer misfires on Pulau Ubin at 1.77% of the tile', () => {
    expect(spansTile(cornerRing(0.0177), E)).toBe(false)
  })

  it('keeps an opposite-edge clip sufficient on its own, regardless of area', () => {
    // A thin sliver crossing left to right is smaller than the corner floor but
    // can only come from something wider than the tile.
    expect(spansTile(ring([[-80, 2000], [4176, 2000], [4176, 2010], [-80, 2010]]), E)).toBe(true)
  })

  it('exposes the corner floor so the Taiwan/Fox Island split is auditable', () => {
    expect(SPAN_CORNER_MIN_FRACTION).toBeGreaterThan(0.0032)
    expect(SPAN_CORNER_MIN_FRACTION).toBeLessThanOrEqual(0.0243)
  })
})

describe('lookupRegionCodes', () => {
  // The eBird export needs a state/province and country code, which the `parks`
  // layer does not carry. These live on administrative boundaries in a separate
  // `admin` layer, so this is a SECOND containment pass answering a different
  // question: not "what is this place called" but "which jurisdiction is it in".

  const adminTile = (feats: Feat[]) => pmtilesOf(buildTile(feats, 'admin'))

  it('returns the code of the containing boundary', async () => {
    const pm = adminTile([
      { props: { name: 'La Habana', 'ISO3166-2': 'CU-03', admin_level: '4' }, ring: square(1000, 1000, 2000) },
    ])
    const [lat, lon] = coordAt(2000, 2000)
    await expect(lookupRegionCodes(pm, lat, lon)).resolves.toEqual({
      stateProvince: 'CU-03',
      countryCode: 'CU',
    })
  })

  it('derives the country from the subdivision code', async () => {
    // ISO 3166-2 is defined as the alpha-2 country code, a hyphen, then up to
    // three characters. A tile well inside a country often holds the state
    // boundary but not the national one, so the country has to come from here.
    const pm = adminTile([
      { props: { name: 'Washington', 'ISO3166-2': 'US-WA', admin_level: '4' }, ring: square(1000, 1000, 2000) },
    ])
    const [lat, lon] = coordAt(2000, 2000)
    const codes = await lookupRegionCodes(pm, lat, lon)
    expect(codes.countryCode).toBe('US')
  })

  it('prefers the country implied by the subdivision over an ISO3166-1 tag', async () => {
    // Found against the real archive. Puerto Rico's admin_level=4 boundary
    // carries BOTH `ISO3166-2=US-PR` and `ISO3166-1=PR`, because PR is listed
    // separately in ISO 3166-1 as a dependent territory. Trusting the tag gave
    // countryCode="PR", which eBird would reject: the checklist belongs to US.
    const pm = adminTile([
      {
        props: { name: 'Puerto Rico', 'ISO3166-2': 'US-PR', 'ISO3166-1': 'PR', admin_level: '4' },
        ring: square(1000, 1000, 2000),
      },
    ])
    const [lat, lon] = coordAt(2000, 2000)
    await expect(lookupRegionCodes(pm, lat, lon)).resolves.toEqual({
      stateProvince: 'US-PR',
      countryCode: 'US',
    })
  })

  it('prefers the SMALLEST containing boundary', async () => {
    // A coordinate is inside its country AND its state; the state is the more
    // precise answer. Feature order is not an ordering guarantee in MVT, so the
    // country is deliberately listed first here.
    const pm = adminTile([
      { props: { name: 'Cuba', 'ISO3166-1': 'CU', admin_level: '2' }, ring: square(0, 0, EXTENT) },
      { props: { name: 'La Habana', 'ISO3166-2': 'CU-03', admin_level: '4' }, ring: square(1500, 1500, 1000) },
    ])
    const [lat, lon] = coordAt(2000, 2000)
    const codes = await lookupRegionCodes(pm, lat, lon)
    expect(codes.stateProvince).toBe('CU-03')
  })

  it('falls back to the country when only a national boundary contains the point', async () => {
    const pm = adminTile([
      { props: { name: 'Cuba', 'ISO3166-1': 'CU', admin_level: '2' }, ring: square(0, 0, EXTENT) },
    ])
    const [lat, lon] = coordAt(2000, 2000)
    await expect(lookupRegionCodes(pm, lat, lon)).resolves.toEqual({
      stateProvince: undefined,
      countryCode: 'CU',
    })
  })

  it('reads the canonical ISO3166-1:alpha2 country tag', async () => {
    const pm = adminTile([
      { props: { name: 'Cuba', 'ISO3166-1:alpha2': 'CU', admin_level: '2' }, ring: square(0, 0, EXTENT) },
    ])
    const [lat, lon] = coordAt(2000, 2000)
    await expect(lookupRegionCodes(pm, lat, lon)).resolves.toEqual({
      stateProvince: undefined,
      countryCode: 'CU',
    })
  })

  it('prefers ISO3166-1:alpha2 over the legacy country tag', async () => {
    const pm = adminTile([
      {
        props: { name: 'Cuba', 'ISO3166-1:alpha2': 'CU', 'ISO3166-1': 'XX', admin_level: '2' },
        ring: square(0, 0, EXTENT),
      },
    ])
    const [lat, lon] = coordAt(2000, 2000)
    await expect(lookupRegionCodes(pm, lat, lon)).resolves.toEqual({
      stateProvince: undefined,
      countryCode: 'CU',
    })
  })

  it('ignores a boundary that does not contain the point', async () => {
    const pm = adminTile([
      { props: { name: 'Elsewhere', 'ISO3166-2': 'CU-03', admin_level: '4' }, ring: square(0, 0, 500) },
    ])
    const [lat, lon] = coordAt(2000, 2000)
    await expect(lookupRegionCodes(pm, lat, lon)).resolves.toEqual({})
  })

  it('does not count a point inside a hole as contained', async () => {
    // Same enclave problem the place lookup has: an admin area with a hole
    // punched in it does not contain a point sitting in that hole.
    const pm = adminTile([
      {
        props: { name: 'Ring State', 'ISO3166-2': 'CU-03', admin_level: '4' },
        rings: [square(0, 0, EXTENT), square(1500, 1500, 1000).slice().reverse()],
      },
    ])
    const [lat, lon] = coordAt(2000, 2000)
    await expect(lookupRegionCodes(pm, lat, lon)).resolves.toEqual({})
  })

  it('returns nothing when the archive has no admin layer', async () => {
    // An archive built before the admin layer existed is a COVERAGE answer,
    // not an error, so it degrades to "unknown" rather than throwing.
    const pm = pmtilesOf(buildTile([
      { props: { name: 'A Park', leisure: 'park' }, ring: square(0, 0, EXTENT) },
    ]))
    const [lat, lon] = coordAt(2000, 2000)
    await expect(lookupRegionCodes(pm, lat, lon)).resolves.toEqual({})
  })

  it('skips boundaries carrying no ISO code at all', async () => {
    const pm = adminTile([
      { props: { name: 'Some County', admin_level: '6' }, ring: square(0, 0, EXTENT) },
    ])
    const [lat, lon] = coordAt(2000, 2000)
    await expect(lookupRegionCodes(pm, lat, lon)).resolves.toEqual({})
  })
})

describe('lookupPlacesWithRegion', () => {
  // The combined lookup reads BOTH layers off one decoded tile, which halves
  // the R2 reads. The risk in that refactor is a behaviour difference from the
  // two functions it replaces, so these pin the cases where the two layers
  // disagree about whether they have anything to say.

  const adminFeat = {
    props: { name: 'La Habana', 'ISO3166-2': 'CU-03', admin_level: '4' },
    ring: square(0, 0, EXTENT),
  }
  const parkFeat = { props: { name: 'Parque Agua Dulce', leisure: 'park' }, ring: square(1000, 1000, 2000) }

  it('still returns places when the archive has NO admin layer', async () => {
    // A pre-admin archive is a real deployment case: the place lookup must keep
    // working and the codes simply come back empty.
    const pm = pmtilesOf(buildTile([parkFeat]))
    const [lat, lon] = coordAt(2000, 2000)
    const { places, regionCodes } = await lookupPlacesWithRegion(pm, lat, lon)
    expect(places.length).toBeGreaterThan(0)
    expect(regionCodes).toEqual({})
  })

  it('still returns codes when the tile has NO parks layer', async () => {
    // The mirror case: offshore and unmapped land have a jurisdiction but no
    // named place, which is the whole reason the codes are resolved separately.
    const pm = pmtilesOf(buildTile([adminFeat], 'admin'))
    const [lat, lon] = coordAt(2000, 2000)
    const { places, regionCodes } = await lookupPlacesWithRegion(pm, lat, lon)
    expect(places).toEqual([])
    expect(regionCodes).toEqual({ stateProvince: 'CU-03', countryCode: 'CU' })
  })

  it('matches lookupPlaces exactly, including ranking order', async () => {
    // The combined path must not silently re-order or drop candidates.
    const pm = pmtilesOf(buildTile([
      { props: { name: 'Big Park', leisure: 'park' }, ring: square(0, 0, EXTENT) },
      { props: { name: 'Small Reserve', leisure: 'nature_reserve' }, ring: square(1500, 1500, 1000) },
    ]))
    const [lat, lon] = coordAt(2000, 2000)
    const separate = await lookupPlaces(pm, lat, lon)
    const { places } = await lookupPlacesWithRegion(pm, lat, lon)
    expect(places.map(p => p.name)).toEqual(separate.map(p => p.name))
  })

  it('honours the limit the same way lookupPlaces does', async () => {
    const pm = pmtilesOf(buildTile([
      { props: { name: 'A', leisure: 'park' }, ring: square(0, 0, EXTENT) },
      { props: { name: 'B', leisure: 'nature_reserve' }, ring: square(1500, 1500, 1000) },
      { props: { name: 'C', leisure: 'garden' }, ring: square(1800, 1800, 400) },
    ]))
    const [lat, lon] = coordAt(2000, 2000)
    const { places } = await lookupPlacesWithRegion(pm, lat, lon, 2)
    expect(places).toHaveLength(2)
  })

  it('returns empty results rather than throwing when the tile is missing', async () => {
    const pm = pmtilesOf(buildTile([parkFeat]))
    pm.getZxy = async () => undefined as never
    const [lat, lon] = coordAt(2000, 2000)
    await expect(lookupPlacesWithRegion(pm, lat, lon)).resolves.toEqual({ places: [], regionCodes: {} })
  })
})
