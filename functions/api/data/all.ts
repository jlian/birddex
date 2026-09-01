import { computeDex, enrichDexEntries } from '../../lib/dex-query'
import { hasObservationColumn } from '../../lib/schema'
import { createRouteResponder } from '../../lib/log'

type OutingRow = {
  id: string
  userId: string
  startTime: string
  endTime: string
  locationName: string
  defaultLocationName?: string | null
  lat?: number | null
  lon?: number | null
  stateProvince?: string | null
  countryCode?: string | null
  protocol?: string | null
  numberObservers?: number | null
  allObsReported?: number | null
  effortDistanceMiles?: number | null
  effortAreaAcres?: number | null
  notes: string
  createdAt: string
}

type PhotoRow = {
  id: string
  outingId: string
  exifTime?: string | null
  gpsLat?: number | null
  gpsLon?: number | null
  fileHash: string
  fileName: string
}

type ObservationRow = {
  id: string
  outingId: string
  speciesName: string
  speciesCode?: string | null
  taxonCode?: string | null
  count: number
  certainty: 'confirmed' | 'possible' | 'pending' | 'rejected'
  representativePhotoId?: string | null
  aiConfidence?: number | null
  speciesComments?: string | null
  notes: string
  submissionId?: string | null
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

export const onRequestGet: PagesFunction<Env> = async context => {
  const userId = (context.data as { user?: { id?: string } }).user?.id
  const route = createRouteResponder((context.data as RequestData).log, 'data/all/read', 'Application')
  if (!userId) {
    return route.fail(401, 'Unauthorized', 'Authentication is required to read account data')
  }

  let stage = 'observation schema inspection'
  try {
    const db = context.env.DB
    const supportsSpeciesComments = await hasObservationColumn(db, 'speciesComments')
    const observationSpeciesCommentsSelect = supportsSpeciesComments
      ? 'speciesComments'
      : 'NULL as speciesComments'
    const supportsSpeciesCode = await hasObservationColumn(db, 'speciesCode')
    // Without this the client never sees the grouping key, so its own
    // code-based grouping silently degrades to the name fallback on every
    // reload and alternate spellings reappear as separate species locally.
    const observationSpeciesCodeSelect = supportsSpeciesCode
      ? 'speciesCode'
      : 'NULL as speciesCode'
    const supportsTaxonCode = await hasObservationColumn(db, 'taxonCode')
    const observationTaxonCodeSelect = supportsTaxonCode
      ? 'taxonCode'
      : 'NULL as taxonCode'
    const supportsSubmissionId = await hasObservationColumn(db, 'submissionId')
    const observationSubmissionIdSelect = supportsSubmissionId
      ? 'submissionId'
      : 'NULL as submissionId'

    stage = 'concurrent outing, photo, observation, and dex reads'
    const [outingsResult, photosResult, observationsResult, dex] = await Promise.all([
      db.prepare('SELECT * FROM outing WHERE userId = ? ORDER BY startTime DESC').bind(userId).all<OutingRow>(),
      db.prepare('SELECT id, outingId, exifTime, gpsLat, gpsLon, fileHash, fileName FROM photo WHERE userId = ?')
        .bind(userId)
        .all<PhotoRow>(),
      db.prepare(`SELECT id, outingId, speciesName, ${observationSpeciesCodeSelect}, ${observationTaxonCodeSelect}, count, certainty, representativePhotoId, aiConfidence, ${observationSpeciesCommentsSelect}, ${observationSubmissionIdSelect}, notes FROM observation WHERE userId = ?`)
        .bind(userId)
        .all<ObservationRow>(),
      computeDex(db, userId),
    ])

    stage = 'account data response assembly'
    const outings = outingsResult.results.map(outing => ({
      ...outing,
      defaultLocationName: outing.defaultLocationName || undefined,
      lat: outing.lat ?? undefined,
      lon: outing.lon ?? undefined,
      stateProvince: outing.stateProvince ?? undefined,
      countryCode: outing.countryCode ?? undefined,
      protocol: outing.protocol ?? undefined,
      numberObservers: outing.numberObservers ?? undefined,
      allObsReported: outing.allObsReported == null ? undefined : outing.allObsReported === 1,
      effortDistanceMiles: outing.effortDistanceMiles ?? undefined,
      effortAreaAcres: outing.effortAreaAcres ?? undefined,
    }))

    const photos = photosResult.results.map(photo => ({
      id: photo.id,
      outingId: photo.outingId,
      dataUrl: '',
      thumbnail: '',
      exifTime: photo.exifTime || undefined,
      gps: photo.gpsLat != null && photo.gpsLon != null ? { lat: photo.gpsLat, lon: photo.gpsLon } : undefined,
      fileHash: photo.fileHash,
      fileName: photo.fileName,
    }))

    const observations = observationsResult.results.map(observation => ({
      ...observation,
      speciesCode: observation.speciesCode || undefined,
      taxonCode: observation.taxonCode || undefined,
      representativePhotoId: observation.representativePhotoId || undefined,
      aiConfidence: observation.aiConfidence ?? undefined,
      speciesComments: observation.speciesComments || undefined,
      submissionId: observation.submissionId || undefined,
    }))

    return route.complete(Response.json({
      outings,
      photos,
      observations,
      dex: enrichDexEntries(dex),
    }), `Loaded account data with ${countLabel(outings.length, 'outing')}, ${countLabel(photos.length, 'photo')}, ${countLabel(observations.length, 'observation')}, and ${countLabel(dex.length, 'dex entry', 'dex entries')}`)
  } catch {
    return route.fail(500, 'Internal server error', `Account data read failed during ${stage}`)
  }
}
