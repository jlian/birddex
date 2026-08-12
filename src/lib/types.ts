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
  speciesName: string
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
}

