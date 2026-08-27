/**
 * Wikidata place classes WingDex will name outings with, each with an extent in
 * metres.
 *
 * The extent idea is lifted from Nominatim, which assigns every place a search
 * rank carrying an assumed reach: a city mapped as a single point still "covers"
 * about 15 km, a neighbourhood about 1 km. That is what stops a point-mapped
 * national park losing to a footpath underfoot, and it is why a flat search
 * radius fails: Haleakala National Park stores a centroid 10.3 km from its own
 * summit, so any fixed 2-3 km radius misses it entirely while a pocket park
 * 10 km away should never match.
 *
 * This list is REVIEWED, not remembered. `list-subclasses.sh <QID>` ranks the
 * subclasses of a root class by how many instances actually carry coordinates,
 * and `verify-labels.sh <QID...>` prints the English label of each id so the
 * allowlist can be checked rather than trusted. Run both before editing this
 * file; a hand-written list is how the two errors below got in.
 *
 * What the generated ranking surfaced that memory did not:
 *
 *   subclasses of protected area   Natura 2000 site 21,573 is the LARGEST,
 *                                  ahead of nature reserve 17,294 and
 *                                  national park 2,672. SSSI 1,728 likewise.
 *   subclasses of park             urban park 6,352 and state park 391 were
 *                                  both missing; zoo 1,955 and business park
 *                                  465 are both things to keep OUT.
 *   subclasses of lake             tjern 2,654 (a Norwegian tarn) outranks
 *                                  salt lake and glacial lake.
 *
 * All of those arrive through P31/P279* traversal already, so the extract is
 * not missing them. The point of reviewing is the extent column: a Natura 2000
 * site should not inherit the 15 km reach of a national park.
 *
 * Every QID below was resolved against Wikidata and checked by label. Do not add
 * one from memory: Q46169 reads like "beach" and is actually "national park",
 * and Q9430000 reads like "wetland" and is actually a music album category.
 */
export interface PlaceClass {
  qid: string
  label: string
  /** Assumed reach in metres for a place stored as a single point. */
  extentM: number
}

export const PLACE_CLASSES: PlaceClass[] = [
  // Large protected land. These are the outings people actually name.
  { qid: 'Q46169', label: 'national park', extentM: 15000 },
  { qid: 'Q473972', label: 'protected area', extentM: 10000 },
  { qid: 'Q179049', label: 'nature reserve', extentM: 6000 },
  { qid: 'Q4421', label: 'forest', extentM: 8000 },

  // Water. Missing from a protected-area-only extract, and a great deal of
  // birding happens at water carrying no protection status at all.
  { qid: 'Q23397', label: 'lake', extentM: 4000 },
  { qid: 'Q170321', label: 'marsh', extentM: 3000 },
  { qid: 'Q39594', label: 'bay', extentM: 5000 },
  { qid: 'Q23442', label: 'island', extentM: 8000 },
  { qid: 'Q40080', label: 'beach', extentM: 2000 },
  { qid: 'Q185113', label: 'cape', extentM: 3000 },

  // Terrain. Haleakala is typed volcano, not park, and summit birding is real.
  { qid: 'Q8072', label: 'volcano', extentM: 8000 },
  { qid: 'Q8502', label: 'mountain', extentM: 6000 },

  // Urban green. Cemeteries and botanical gardens are classic migrant traps,
  // and without them city outings get no name at all.
  { qid: 'Q22698', label: 'park', extentM: 2000 },
  { qid: 'Q167346', label: 'botanical garden', extentM: 1500 },
  { qid: 'Q1107656', label: 'garden', extentM: 1000 },
]

/**
 * Deliberately excluded, recorded so nobody re-adds them:
 *
 * - river (Q4022) and stream (Q47521): a river centroid is meaningless for
 *   naming, and the subclass tree pulls in every ditch.
 * - mine (Q820477): 50k of them, and almost never where anyone birds.
 * - cemetery (Q39614): 295k, genuinely good birding, but the naming reads badly
 *   enough ("Outing at Greenwood Cemetery") to want a deliberate decision first.
 */
export const EXCLUDED_CLASSES = ['Q4022', 'Q47521', 'Q820477', 'Q39614'] as const
