export interface Photo {
  id: string
  outingId: string
  dataUrl: string
  thumbnail: string
  exifTime?: string
  gps?: { lat: number; lon: number }
  fileHash: string
  fileName: string
}

export interface Outing {
  id: string
  userId: string
  startTime: string
  endTime: string
  locationName: string
  defaultLocationName?: string
  lat?: number
  lon?: number
  stateProvince?: string
  countryCode?: string
  protocol?: string
  numberObservers?: number
  allObsReported?: boolean
  effortDistanceMiles?: number
  effortAreaAcres?: number
  notes: string
  createdAt: string
}

export type ObservationStatus = 'confirmed' | 'possible' | 'pending' | 'rejected'

export interface Observation {
  id: string
  outingId: string
  speciesName: string
  /**
   * eBird REPORT_AS code used for dex grouping, absent when unresolved.
   */
  speciesCode?: string
  /** Exact eBird taxon code, including ISSF and other below-species taxa. */
  taxonCode?: string
  count: number
  certainty: ObservationStatus
  representativePhotoId?: string
  aiConfidence?: number
  speciesComments?: string
  notes: string
  /** eBird checklist id when imported, absent for records created in-app. */
  submissionId?: string
}

export interface DexEntry {
  /**
   * The grouping key: `code:<ebirdCode>` when the species resolved, `name:<speciesName>`
   * otherwise. Stable across a rename, and unique where `speciesName` is NOT:
   * a coded and an uncoded group can share one `MIN(speciesName)` mid-rollout.
   * Use this for React keys, navigation and cache keys; use `speciesName` for display.
   */
  id: string
  speciesName: string
  /** eBird species code for this dex entry, absent for unresolvable taxa. */
  speciesCode?: string
  /** Exact eBird taxon code represented by speciesName. */
  taxonCode?: string
  /** Canonical taxonomy names, resolved by taxonCode rather than parsed. */
  commonName?: string
  scientificName?: string
  firstSeenDate: string
  lastSeenDate: string
  /** When this species was first added to WingDex (wall-clock time) */
  addedDate?: string
  totalOutings: number
  totalCount: number
  bestPhotoId?: string
  notes: string
  wikiTitle?: string
  thumbnailUrl?: string
  borrowedFrom?: string
  compound?: {
    kind: 'hybrid' | 'slash'
    parents: Array<{
      commonName: string
      scientificName: string
      speciesCode?: string
      wikiTitle?: string
      thumbnailUrl?: string
      birdlifeId?: string
    }>
  }
}

