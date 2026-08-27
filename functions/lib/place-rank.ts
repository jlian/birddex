/**
 * Ranked, sub-category-aware scorer + top-N results.
 *
 * Two ideas, from two sources:
 *
 * 1. SFO Museum's reverse geocoder returns EVERY place containing the point and
 *    lets the caller choose (millsfield.sfomuseum.org/blog/2022/12/19/pmtiles-pip/).
 *    Their example gives one photo two answers: taken "from" the Super Bay
 *    Hangar, "depicts" Runway 01R/19L. At Lake Como our tile holds the lake at
 *    19 m, Lungolago at 6 m and a hotel at 37 m; all three are true, so
 *    collapsing to one answer is guaranteed to be wrong sometimes.
 *
 * 2. Nominatim ranks by class. We keep that, but with SUB-CATEGORIES, because
 *    a flat `tourism` tier spends most of its influence on hotels. Measured over
 *    20k iNat coordinates, tourism=hotel won 797 times (5.4% of all named
 *    results) while tourism=zoo won 87. Lodging is ~9% of every named answer.
 *
 * The weights are a judgement call and that is deliberate: this is a geocoder
 * for BIRD PHOTOS, so a lake, bay or marsh is a better answer than the hotel
 * across the road. A general-purpose geocoder would rank these differently.
 */

/** Lodging. Real places, but never why a birder was standing there. */
const LODGING = new Set([
  'hotel',
  'motel',
  'hostel',
  'guest_house',
  'apartment',
  'chalet',
  'alpine_hut',
  'wilderness_hut',
  'camp_site',
  'caravan_site',
  'camp_pitch',
])

/** Destination attractions: a specific, named reason to be somewhere. */
/**
 * A destination someone travels TO and stands INSIDE.
 *
 * `museum` and `gallery` are deliberately NOT here, despite Nominatim ranking
 * them alongside a zoo. The difference is birding-specific: a zoo or an
 * aquarium is somewhere a bird photo is genuinely taken, but nobody
 * photographs a wild bird inside a museum. The bird is in the plaza, the water
 * or the park nearby, and the museum is merely the most specific POI that
 * happens to sit close. Measured on the sample photos, `tourism=museum` at
 * rank 26 took three Union Bay Natural Area photos to the Henry Art Gallery
 * 1.25 km away. They are demoted to `NEARBY_LANDMARK` instead of dropped,
 * because "near the Burke Museum" still beats a null when nothing else is
 * around.
 */
/**
 * A destination that is itself an ENCLOSURE someone stands inside, and where a
 * bird photo genuinely happens.
 *
 * Kept at the Nominatim rank so a CONTAINED zoo wins: "Taipei Zoo" is where
 * the photo was taken, not a landmark near it. Containment sorts before class,
 * so this rank only ever decides contests the zoo actually encloses.
 *
 * Deliberately NOT promoted in the near tier. Measured: Seattle Aquarium at
 * 168 m beat Waterfront Park at 97 m for gulls photographed on the waterfront.
 * From OUTSIDE the fence a zoo is just a building you are near, so
 * `nearScoreOf` demotes it and only containment restores it.
 */
const ATTRACTION = new Set(['zoo', 'aquarium', 'theme_park'])

/**
 * Points of interest that MARK a spot rather than being the habitat.
 *
 * A lighthouse, lookout, viewpoint or picnic table sits inside a park or beside
 * water, and Nominatim ranks `tourism=attraction` at 26, above park 25 and
 * water 24, because for a tourist the viewpoint IS the destination. For a
 * birder that is the wrong answer: the bird is in the habitat, and the marker
 * is merely the most specific POI nearby.
 *
 * Measured over 5,489 near-tier contests, moving these from 26 to 24:
 *   outdoor winners   82.3% -> 88.1%
 *   attraction wins   468   -> 150
 *   a farther attraction beating a NEARER outdoor feature: 247 -> 4
 * Cases that motivated it: Cape Leeuwin Lighthouse at 355 m beating the
 * national park it stands in at 16 m, and Palace of Fine Arts at 444 m beating
 * a park at 117 m.
 *
 * 24 rather than 19: these are still real, named, outdoor places, so they must
 * beat vague ground cover and lodging. They just must not outrank the habitat.
 */
const POI_MARKER = new Set(['attraction', 'viewpoint', 'picnic_site'])

/**
 * Indoor institutions: a real landmark, but never where a wild bird is.
 * Ranked below parks and water so they win only when nothing outdoors is near.
 */
const NEARBY_LANDMARK = new Set(['museum', 'gallery'])

/** Water and wetland: where the birds are. Promoted above the Nominatim base. */
/**
 * Water a bird is actually on or beside.
 *
 * `strait` is deliberately NOT here. A strait is water, but it is water the size
 * of a region: measured on the sample photos, "Strait of Juan de Fuca" contained
 * both the Smith Island puffin and the Skagit Bay cormorants and beat the San
 * Juan Islands National Wildlife Refuge 441 m away. It is handled as a
 * REGIONAL_NATURAL below so it can still answer when nothing else is near.
 */
const BIRD_WATER = new Set(['water', 'bay', 'beach', 'wetland', 'spring'])

/**
 * Named natural features the size of a region, not a place a photo happens at.
 *
 * Taking `natural=*` wholesale brought these in. A mountain range or a strait
 * is a legitimate named feature that legitimately contains the point, which is
 * exactly the problem: it is true and useless. Measured on the sample photos,
 * "Tambo-Gruppe" (natural=mountain_range) and "Alps" both contained the Lake
 * Como cormorant and beat the lake 20 m away, and "Strait of Juan de Fuca"
 * (natural=strait) took two more photos.
 *
 * Scored below REAL_PLACE_FLOOR so they can never outrank a real nearby place,
 * while still beating a null when nothing else is in range. Same
 * demote-not-drop treatment an oversized island gets.
 */
const REGIONAL_NATURAL = new Set([
  'mountain_range',
  'strait',
  'sound',
  'channel',
  'archipelago',
  'plateau',
  'valley',
  'divide',
  'ridge',
  'desert',
])

/** Vegetation with a real edge. */
const BIRD_LAND = new Set(['wood', 'scrub', 'heath', 'sand', 'cliff', 'coastline'])

/** Vague ground cover: better than nothing, worse than anything named. */
const VAGUE_NATURAL = new Set(['grassland', 'grass', 'bare_rock', 'shingle', 'tree_row'])

/**
 * Administrative `place` values, from the last-resort fallback in the build.
 *
 * These exist so a rural coordinate gets "Dehua" rather than a raw latitude and
 * longitude: 18.5% of 20,000 iNaturalist coordinates have no named OSM feature
 * within 2 km. They are the answer of last resort and must never beat a park, a
 * lake or a reserve, so they sit below REAL_PLACE_FLOOR with the other demoted
 * classes.
 *
 * Split by how precisely each locates a photo. A hamlet is a useful answer; a
 * state is barely better than nothing.
 */
const ADMIN_PLACE_SPECIFIC = new Set(['hamlet', 'isolated_dwelling', 'farm'])
const ADMIN_PLACE_LOCAL = new Set(['village', 'town', 'borough'])
const ADMIN_PLACE_BROAD = new Set([
  'city',
  'municipality',
  'district',
  'county',
  'province',
  'state',
  'region',
  'country',
])

export interface Ranked {
  name: string
  score: number
  area: number
  distanceM: number
  contained: boolean
  kind: string
  /**
   * Wikipedia-derived importance, 0..1, joined from the feature's Wikidata QID.
   *
   * This is Nominatim's own published measure: how many articles link to a
   * place, across languages and including redirects. It is a TIE-BREAKER only,
   * matching how Nominatim uses it, because only about 16% of named features
   * carry a QID at all. Sorting on it any earlier would let Wikipedia coverage
   * decide geography.
   */
  importance?: number
}

/**
 * Tier for a polygon that is too big to name a photo. Below every real tier,
 * above 0, so an oversized island is still RETURNED when nothing else contains
 * the point. "Vancouver Island" beats null for an auto-detect UX.
 */
export const OVERSIZED_SCORE = 12

/**
 * Share of one tile a polygon may cover before it stops being a specific
 * answer.
 *
 * Why a FRACTION and not km2. The scorer sees the ring as stored in the vector
 * tile, and MVT clips every geometry to its own tile. A z13 tile is 23.9 km2 at
 * the equator but 12.0 km2 at 45N, so the same absolute cap would be twice as
 * strict in the tropics as in Canada. Measured over 2500 random z13 tiles of
 * the planet archive, the clipped area of a `place=island` ring reads 0.67 km2
 * for Greenland and 16.0 km2 for Honshu: km2 ranks by LATITUDE, not by size.
 * Ring area over tile area removes that, and it is exactly the question worth
 * asking, which is how much of the neighbourhood this polygon swallows.
 *
 * Why 0.5. Over the 2794 island/islet rings that appear at the 20k iNat
 * coordinates, the distribution is close to uniform below 1.0 and then spikes:
 * 1466 of them (52%) are clipped to the full tile. There is no gap to cut at,
 * so the number comes from what sits on each side. Below 0.5 the names are
 * Isla Cozumel, Ulva Island, Rottnest Island, Lord Howe Island: places a birder
 * would name. Above 0.5 they are Taiwan, Borneo, Honshu, Sri Lanka, Madagascar,
 * Great Britain. Half a tile is also the point where an island stops being
 * something you can stand outside of at z13.
 *
 * The threshold is not delicate. Sweeping 0.15 to 1.0 moves the number of
 * changed answers from 80 to 57 out of 11917 named, and the five hotel cases
 * are fixed at every value in that range. 0.5 sits in the middle of the flat
 * part rather than on either edge.
 *
 * KNOWN LIMIT, measured. Clipping makes the test per-TILE, not per-island, so a
 * big island reads small on a tile it barely enters. 98 of the 441 distinct
 * island names in the run appear on both sides of 0.5 for that reason: Great
 * Britain measures 0.010 on one tile and 1.080 on another. The residual is 153
 * of 11917 named answers (1.28%) where a known-huge island still wins at tier
 * 21 because its corner of that tile is small. Those are edge tiles, where the
 * point IS near the coast and the island is a less unreasonable answer, so the
 * leak is accepted. Removing it needs a per-feature area attribute written at
 * tile-build time, which is a build change and not a scorer change.
 */
export const MAX_TILE_FRACTION = 0.5

/**
 * Demote a polygon that is too large to be a useful answer.
 *
 * This cannot live in `scoreOf`, which only sees TAGS. `place=island` is the
 * same tag on Cozumel and on a 3-hectare islet, so the tier alone cannot tell
 * them apart. Area is the signal that can, and it is known only once the ring
 * is decoded, so the caller applies it there.
 *
 * The rule is the same one the original category audit used to reject
 * `place=city` (13.810 km2 median) and `boundary=administrative` (4.090 median,
 * p90 135): a polygon that big does not describe where a photo was taken.
 *
 * Applied ONLY to `place=island`/`islet`. Measured on the same 20k coordinates,
 * capping `natural=*` water as well changed 29 more answers and every one of
 * them was a REGRESSION: Lake Kariba became "Kavango Zambezi Transfrontier
 * Conservation Area", Taui Bay became "остров Талан", Gulf of Saint-Malo became
 * "Baie du Mont Saint Michel". A large lake or bay is still the place the bird
 * was, so `natural=water` does not have the island problem and is left alone.
 *
 * @param props     feature tags, for the category test
 * @param score     tier from `scoreOf`
 * @param area      ring area in tile units
 * @param extent    tile extent, so `area / extent^2` is the share of one tile
 * @param fraction  threshold override, so a benchmark can sweep it without
 *                  copying this function. Copies drift: the 2026-08-13 harness
 *                  carried its own scorer, lacked near-miss logic, and could
 *                  not reproduce production at all.
 */
/**
 * Does this polygon reach the tile edge on enough sides to be a landmass?
 *
 * Tile geometry is CLIPPED to the tile, so area cannot tell a country from a
 * park. Measured on the contested cases: Puerto Rico reads as 0.128 of a tile,
 * Barbados 0.424 and South Island 0.340, all below the 0.5 cap, so
 * `capOversized` never fired and each one won on containment.
 *
 * A feature genuinely larger than the tile must cross the boundary. A park
 * wholly inside the tile touches no edge. Two edges is the threshold: one edge
 * alone is common and harmless, since a bay or a beach often runs off the side
 * of a tile while still being a specific place.
 *
 * Opposite edges (left+right or top+bottom) are strong evidence on their own: a
 * slice clean through the tile can only come from something wider than the tile.
 *
 * ADJACENT edges are a corner clip, which is weaker. A genuine landmass such as
 * Barbados (clipped at x=4176 right and y=-80 top) catches a tile corner, but so
 * does a tiny island that happens to sit in a corner: measured, "Fox Island"
 * touches two adjacent edges while covering 0.32% of the tile, and "Pulau Ubin"
 * 1.77%. A corner clip therefore counts only when the clipped ring also covers a
 * meaningful share of the tile. That share demotes Taiwan (2.43% of that tile,
 * corner clip) and Barbados while leaving Fox Island and Pulau Ubin as the
 * specific islands they are.
 */

/**
 * Minimum share of a tile a corner-clipped ring must cover to read as a
 * landmass. Sits above the misfires (Pulau Ubin 0.0177, Fox Island 0.0032) and
 * below the real landmasses seen at a corner (Taiwan 0.0243, Kerguelen 0.0270).
 */
export const SPAN_CORNER_MIN_FRACTION = 0.02

export function spansTile(ring: Array<{ x: number; y: number }>, extent: number): boolean {
  // Small tolerance: clipped coordinates can land a pixel outside the range.
  const lo = extent * 0.02
  const hi = extent - lo
  let left = false
  let right = false
  let top = false
  let bottom = false
  for (const p of ring) {
    if (p.x <= lo) left = true
    if (p.x >= hi) right = true
    if (p.y <= lo) top = true
    if (p.y >= hi) bottom = true
  }
  const edges = [left, right, top, bottom].filter(Boolean).length
  if (edges < 2) return false
  // Opposite edges alone are sufficient: nothing smaller than the tile can span
  // it corner to corner across a full axis.
  if ((left && right) || (top && bottom)) return true
  // Only adjacent edges were touched, i.e. a corner clip. That is weak on its
  // own, so require the clipped ring to cover a meaningful share of the tile.
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y)
  }
  const fraction = Math.abs(a / 2) / (extent * extent)
  return fraction >= SPAN_CORNER_MIN_FRACTION
}

export function capOversized(
  props: Record<string, unknown>,
  score: number,
  area: number,
  extent: number,
  fraction: number = MAX_TILE_FRACTION,
  spans = false,
): number {
  if (score <= OVERSIZED_SCORE) return score
  const place = props.place as string | undefined
  if (place !== 'island' && place !== 'islet') return score
  // Either test is sufficient: `spans` catches a landmass clipped to a small
  // share of one tile, the area test catches a big island wholly inside it.
  return spans || area > fraction * extent * extent ? OVERSIZED_SCORE : score
}

/**
 * Nominatim's address-levels table, adjusted for birding and split by
 * sub-category. Higher is more specific and wins.
 */
export function scoreOf(props: Record<string, unknown>): number {
  const tourism = props.tourism as string | undefined
  const leisure = props.leisure as string | undefined
  const natural = props.natural as string | undefined
  const boundary = props.boundary as string | undefined
  const landuse = props.landuse as string | undefined
  const place = props.place as string | undefined

  // 26: a named destination. Someone at the zoo says "the zoo", not the park
  // it sits inside. Measured median area is under a hectare, so these are
  // specific enough to outrank the thing containing them.
  if (tourism && ATTRACTION.has(tourism)) return 26

  // 25: cultivated and park land. A garden really is more specific than the
  // park around it.
  if (leisure === 'garden') return 25
  if (leisure === 'park' || leisure === 'nature_reserve') return 25

  // 24: water and protected land, equal. This is the birding judgement call:
  // Nominatim puts natural=* at 22, below park. For a bird photo, "Skagit Bay"
  // and "Union Bay" are the answer, not the strip of park by the shore.
  if (natural && BIRD_WATER.has(natural)) return 24
  if (boundary === 'protected_area' || boundary === 'national_park') return 24
  if (tourism && POI_MARKER.has(tourism)) return 24

  // 22: broad land cover with a real boundary.
  if (landuse === 'forest' || landuse === 'recreation_ground') return 22
  if (natural && BIRD_LAND.has(natural)) return 22

  // 21: islands sit below parks, so a park on an island still wins, but above
  // vague cover because an island is a real named landform. This tier is right
  // only for a SMALL island: `place=island` is also the tag on Borneo, and the
  // size test that separates the two is `capOversized`, because this function
  // can see only tags.
  if (place === 'island' || place === 'islet') return 21

  // 19: present but demoted. Returned only when nothing better is nearby,
  // which beats a null result for an auto-detect UX.
  if (tourism && LODGING.has(tourism)) return 19
  if (tourism && NEARBY_LANDMARK.has(tourism)) return 19
  if (natural && VAGUE_NATURAL.has(natural)) return 19

  // 18: any remaining tourism value, and neighbourhoods as a last resort.
  if (tourism) return 18
  if (place === 'neighbourhood' || place === 'suburb' || place === 'quarter') return 18

  // 16-14: the administrative fallback, ordered by how precisely it locates a
  // photo. Only reached when nothing real is in range, which is 18.5% of
  // coordinates. "Dehua" beats a raw latitude and longitude; a country name
  // barely does, so it sits lowest.
  if (place && ADMIN_PLACE_SPECIFIC.has(place)) return 16
  if (place && ADMIN_PLACE_LOCAL.has(place)) return 15
  if (place && ADMIN_PLACE_BROAD.has(place)) return 14

  // 13: a named region-sized landform. Below every admin place because "Dehua"
  // locates a photo and "the Alps" does not.
  if (natural && REGIONAL_NATURAL.has(natural)) return 13

  if (natural) return 19
  return 0
}

/** Coarse label for reporting, so a variant that wins on junk is visible. */
/**
 * Score a candidate that merely sits NEAR the point.
 *
 * An enclosure is only the answer when the point is INSIDE it. Standing on the
 * pavement outside the aquarium does not put the bird in the aquarium, so the
 * enclosure classes drop to the marker rank when they are not containing.
 */
export function nearScoreOf(props: Record<string, unknown>, score: number): number {
  const tourism = props.tourism as string | undefined
  if (tourism && ATTRACTION.has(tourism)) return Math.min(score, 24)
  return score
}

export function kindOf(props: Record<string, unknown>): string {
  const tourism = props.tourism as string | undefined
  const natural = props.natural as string | undefined
  if (tourism && LODGING.has(tourism)) return 'lodging'
  if (tourism && NEARBY_LANDMARK.has(tourism)) return 'landmark'
  if (tourism && ATTRACTION.has(tourism)) return 'attraction'
  if (tourism && POI_MARKER.has(tourism)) return 'poi'
  if (tourism) return 'tourism-other'
  if (props.leisure === 'garden') return 'garden'
  if (props.leisure === 'park' || props.leisure === 'nature_reserve') return 'park'
  if (natural && BIRD_WATER.has(natural)) return 'water'
  if (props.boundary === 'protected_area' || props.boundary === 'national_park') {
    return 'protected'
  }
  if (props.landuse) return 'landuse'
  if (natural && REGIONAL_NATURAL.has(natural)) return 'region'
  if (natural) return 'natural-other'
  const place = props.place as string | undefined
  if (
    place &&
    (ADMIN_PLACE_SPECIFIC.has(place) || ADMIN_PLACE_LOCAL.has(place) || ADMIN_PLACE_BROAD.has(place))
  ) {
    return 'admin'
  }
  if (place) return 'place'
  return 'other'
}

/**
 * Distance band for ordering candidates that merely sit NEAR the point, in
 * metres.
 *
 * Why a band and not raw distance or raw class. Class-first was correct while
 * the near-miss buffer was 120 m, because everything in that tier was within a
 * block and class was the only real signal. At a 2000 m buffer it is actively
 * wrong: measured on the sample photos, a rank-26 attraction beat a rank-24
 * lake from 249 m further away, so Lake Como resolved to the Cathedral of Como
 * 269 m inland while the water the cormorant sat on was 20 m away. Union Bay
 * Natural Area lost the same way to the Henry Art Gallery 1.25 km off. Raw
 * distance alone overcorrects, letting a 40 m hotel beat a 60 m park.
 *
 * The band keeps both signals with the right precedence: candidates in the
 * same band count as equally close and class decides, while a nearer band wins
 * outright. It also absorbs GPS error, which is the reason two candidates a few
 * tens of metres apart should not be ordered confidently at all.
 *
 * Why 100. The value was chosen twice before under conditions that no longer
 * hold, so it was swept again from scratch. The first sweep ran while the
 * `REAL_PLACE_FLOOR` bug let a nearer hotel win outright, and the second ran
 * before Wikipedia importance was available as a tie-breaker. Both of those
 * were doing work a wide band was compensating for.
 *
 * With the floor and importance both active, measured over the 25 sample
 * photos: band 100 scores 24/25, band 600 scores 22/25. It is the first
 * configuration that gets Lake Como AND all three Union Bay photos right at
 * once. The 20,000 iNat coordinates show 86.0% to 86.7% outdoor winners across
 * every band value, so they cannot discriminate here, and the 49 hand-graded
 * cases vary by only three cases, which is noise at that sample size.
 *
 * A narrow band is now safe because two other mechanisms carry the load that
 * a wide band used to: the score floor keeps hotels and museums out of the top
 * slot no matter how close they are, and importance breaks ties between
 * equally-valid neighbours.
 */
export const NEAR_BAND_M = 100

/**
 * Scores below this never win on proximity alone.
 *
 * The sub-category ranker already scores lodging at 19 and a park at 25, but
 * the distance band is consulted BEFORE the score, so a hotel in a nearer band
 * won before the two scores were ever compared. That silently bypassed the
 * whole sub-category system. Measured over 5,489 near-tier contests: lodging
 * won 377, and in 201 of those a real outdoor place existed and lost, e.g.
 * "Hotel Melia Tortuga Beach" at 75 m beating "Pachamama Eco Park" at 1316 m.
 *
 * The floor restores the intended precedence: a demoted class sorts after
 * every real one no matter how close it is, and distance still decides among
 * equals. Measured effect of a floor at 20: lodging wins 377 -> 191, outdoor
 * winners 82.3% -> 86.0%.
 *
 * 20 rather than 24: it must sit above the demoted tier (19) and below every
 * real class (24+), so it separates exactly the classes meant to be a last
 * resort.
 */
export const REAL_PLACE_FLOOR = 20

/**
 * A contained candidate scoring below this is demoted to the near tier.
 *
 * Distinct from `REAL_PLACE_FLOOR`, which orders the NEAR tier. This one
 * decides which classes are so unhelpful that even a containment FACT should
 * not put them first, and it must cover exactly the last-resort classes:
 * oversized landmasses (12), region-sized landforms (13) and the
 * administrative fallback (14-16).
 *
 * 17 rather than 20: the floor value would also demote a contained hotel,
 * museum or suburb (18-19), and being inside one of those is a real, useful
 * fact about where a photo was taken. Those classes are held back by the near
 * tier's floor instead, which is where they were causing trouble.
 */
export const CONTAINMENT_FLOOR = 17

/**
 * Collapse entries that name the same real-world place.
 *
 * `osmium export` emits a closed way TWICE, once as a LineString and once as a
 * Polygon, so nearly every feature appears in the tile in both forms. Measured
 * on the live route over the 25 sample photos: 228 duplicate entries, 196 of
 * 248 named features in the Union Bay tile. Since the whole point of returning
 * a list is that a person picks from it, showing "Carp Inlet" twice is a
 * defect.
 *
 * Dedupe here rather than in the build. The archive is a 1.6 GB artifact that
 * takes hours to produce, and any future archive from any producer can carry
 * the same twins; a query-time rule holds for all of them and costs one pass.
 *
 * The BEST entry wins, not the first. The polygon twin can contain the point
 * while the line twin only measures distance to its edge, so keeping the wrong
 * one silently downgrades containment to proximity. Ranking first and keeping
 * the earliest survivor per key gets this for free.
 *
 * Keyed on name AND kind, so two genuinely different places that share a name
 * ("Central Park" the park and "Central Park" the neighbourhood) both survive.
 */
function dedupeByPlace(ranked: Ranked[]): Ranked[] {
  const seen = new Set<string>()
  const out: Ranked[] = []
  for (const c of ranked) {
    const key = `${c.name}\u0000${c.kind}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out
}

/**
 * Order candidates the way SFO Museum's hierarchy does, structurally first.
 *
 * Containment is a FACT and proximity is a guess, so everything contained
 * sorts above everything merely near. Within the contained tier class rank is
 * the tiebreak rather than the first sort key, which is what stopped a hotel
 * 37 m away from beating the lake the bird was sitting on.
 */
export function rankCandidates(cands: Ranked[], bandM: number = NEAR_BAND_M): Ranked[] {
  // A polygon too big to name a photo does not earn containment priority.
  //
  // Containment normally beats proximity because it is a fact rather than a
  // guess. That reasoning breaks for a landmass: standing anywhere in Puerto
  // Rico is "contained by Puerto Rico", which is true and useless. Measured on
  // the contested cases, "Puerto Rico" beat a park 11 m away, "Barbados" beat a
  // park at 615 m, and "South Island" beat Lake Ellesmere at 207 m. Capping the
  // SCORE was not enough, because a capped score still sorts inside the
  // contained tier, above every near candidate.
  //
  // The test is CONTAINMENT_FLOOR rather than OVERSIZED_SCORE, so it covers
  // every last-resort class and not just oversized islands. The administrative
  // fallback made that difference matter: "Seattle" and "China" are contained
  // and would otherwise beat the park the photo was taken in, which is exactly
  // the failure this demotion exists to prevent. Measured on the sample photos,
  // keying on OVERSIZED_SCORE alone scored 16 of 25; keying on the floor scores
  // 24 of 25.
  //
  // Demoting these to the near tier at distance 0 keeps them available when
  // nothing else is around, which is the whole point of demote-not-drop, while
  // letting any real nearby place win.
  const tiered = cands.map((c) =>
    c.contained && c.score < CONTAINMENT_FLOOR ? { ...c, contained: false, distanceM: 0 } : c,
  )
  return dedupeByPlace(tiered.sort((a, b) => {
    if (a.contained !== b.contained) return a.contained ? -1 : 1
    if (a.contained) {
      // Both contain the point: prefer the more specific class, then the
      // smaller polygon.
      return b.score - a.score || a.area - b.area
    }
    // A last-resort class never beats a real place on proximity alone.
    const aLast = a.score < REAL_PLACE_FLOOR ? 1 : 0
    const bLast = b.score < REAL_PLACE_FLOOR ? 1 : 0
    if (aLast !== bLast) return aLast - bLast
    // Neither contains it: nearer band wins outright, then class, then
    // importance, then the exact edge distance.
    const ba = Math.floor(a.distanceM / bandM)
    const bb = Math.floor(b.distanceM / bandM)
    return (
      ba - bb ||
      b.score - a.score ||
      (b.importance ?? 0) - (a.importance ?? 0) ||
      a.distanceM - b.distanceM
    )
  }))
}
