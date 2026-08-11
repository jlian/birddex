import { computeDex, enrichDexEntries } from '../../../lib/dex-query'
import { groupPreviewsIntoOutings, type ImportPreview, type OutingForImport } from '../../../lib/ebird'
import { getOutingColumnNames, hasObservationColumn } from '../../../lib/schema'
import { createRouteResponder } from '../../../lib/log'

type ConfirmBody = { previewIds: string[] }

function isConfirmBody(value: unknown): value is ConfirmBody {
  if (!value || typeof value !== 'object') return false
  const data = value as Record<string, unknown>
  return Array.isArray(data.previewIds) && data.previewIds.every(id => typeof id === 'string')
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function decodePreviewId(previewId: string): ImportPreview | null {
  try {
    const binary = atob(previewId)
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    const json = new TextDecoder().decode(bytes)
    const parsed = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as ImportPreview
  } catch {
    return null
  }
}

export const onRequestPost: PagesFunction<Env> = async context => {
  const userId = (context.data as { user?: { id?: string } }).user?.id
  const route = createRouteResponder((context.data as RequestData).log, 'import/ebirdCsvConfirm/write', 'Application')
  if (!userId) {
    return route.fail(401, 'Unauthorized', 'Authentication is required to confirm an eBird import')
  }

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return route.fail(400, 'Invalid JSON body', 'Request body could not be parsed as JSON; check Content-Type is application/json and body is valid JSON')
  }

  if (!isConfirmBody(body)) {
    return route.fail(400, 'Invalid confirm payload', 'Expected { previewIds: string[] }')
  }

  const selectedPreviewCount = body.previewIds.length
  let validPreviewCount = 0
  let persistedOutingCount = 0
  let skippedOutingCount = 0
  let persistedObservationCount = 0
  let importBatchCommitted = false
  let stage = 'decode selected previews'

  try {
    const selectedPreviews = body.previewIds
    .map(previewId => decodePreviewId(previewId))
    .filter((preview): preview is ImportPreview => {
      if (!preview) {
        route.debug('A preview ID could not be decoded from base64; it will be skipped')
        return false
      }
      return true
    })
  validPreviewCount = selectedPreviews.length

  if (selectedPreviews.length === 0) {
    stage = 'recompute dex for an empty selection'
    const dexUpdates = await computeDex(context.env.DB, userId)
    return route.complete(Response.json({
      imported: { outings: 0, observations: 0, newSpecies: 0 },
      dexUpdates: enrichDexEntries(dexUpdates),
    }), `Confirmed eBird import with ${countLabel(selectedPreviewCount, 'selected preview')} and 0 valid previews; persisted no records and recomputed ${countLabel(dexUpdates.length, 'dex entry', 'dex entries')}`)
  }

  // Snapshot species already in the user's dex before inserting
  stage = 'read the pre-import dex snapshot'
  const priorDex = await computeDex(context.env.DB, userId)
  const priorSpecies = new Set(priorDex.map(row => row.speciesName))

  const { outings, observations } = groupPreviewsIntoOutings(selectedPreviews, userId)
  stage = 'inspect the import database schema'
  const columnNames = await getOutingColumnNames(context.env.DB)
  const supportsRegionColumns = columnNames.has('stateProvince') && columnNames.has('countryCode')
  const supportsChecklistColumns =
    columnNames.has('protocol') &&
    columnNames.has('numberObservers') &&
    columnNames.has('allObsReported') &&
    columnNames.has('effortDistanceMiles') &&
    columnNames.has('effortAreaAcres')
  const supportsSpeciesCommentsColumn = await hasObservationColumn(context.env.DB, 'speciesComments')
  // Older databases predate migration 0008, so the column is probed rather than
  // assumed, matching how the other optional eBird columns are handled here.
  const supportsSubmissionId = columnNames.has('submissionId')

  // Checklist-level idempotency. Re-importing an export that overlaps one
  // already imported would otherwise create a second copy of every outing:
  // the existing species-level conflict check answers a different question
  // (is this species already in the dex) and never suppresses a duplicate
  // outing. Skipping by submission id makes a repeat import a no-op for the
  // checklists already stored, while still importing genuinely new ones.
  //
  // Only applies to outings that HAVE a submission id. Rows without one fall
  // back to date+location grouping and cannot be identified reliably, so they
  // are always imported rather than guessed at.
  stage = 'skip checklists already imported'
  let skippedOutings: OutingForImport[] = []
  let importedOutings = outings
  if (supportsSubmissionId) {
    const candidateIds = outings
      .map(outing => outing.submissionId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)

    if (candidateIds.length > 0) {
      const existingIds = new Set<string>()
      // Chunked to stay well inside SQLite's bound-parameter limit on a large
      // export, which can carry hundreds of checklists.
      const CHUNK = 100
      for (let i = 0; i < candidateIds.length; i += CHUNK) {
        const chunk = candidateIds.slice(i, i + CHUNK)
        const placeholders = chunk.map(() => '?').join(', ')
        const found = await context.env.DB
          .prepare(`SELECT submissionId FROM outing WHERE userId = ? AND submissionId IN (${placeholders})`)
          .bind(userId, ...chunk)
          .all<{ submissionId: string }>()
        for (const row of found.results ?? []) {
          if (row.submissionId) existingIds.add(row.submissionId)
        }
      }

      if (existingIds.size > 0) {
        skippedOutings = outings.filter(o => o.submissionId && existingIds.has(o.submissionId))
        importedOutings = outings.filter(o => !o.submissionId || !existingIds.has(o.submissionId))
      }
    }
  }

  // Observations follow their outing, so dropping a skipped outing must drop
  // its observations too or they would reference a row that is never inserted.
  const keptOutingIds = new Set(importedOutings.map(outing => outing.id))
  const importedObservations = observations.filter(o => keptOutingIds.has(o.outingId))

  persistedOutingCount = importedOutings.length
  persistedObservationCount = importedObservations.length
  skippedOutingCount = skippedOutings.length

  const insertStatements: D1PreparedStatement[] = []

  for (const outing of importedOutings) {
    if (supportsRegionColumns && supportsChecklistColumns && supportsSubmissionId) {
      insertStatements.push(
        context.env.DB
          .prepare(
            `INSERT INTO outing (id, userId, startTime, endTime, locationName, defaultLocationName, lat, lon, stateProvince, countryCode, protocol, numberObservers, allObsReported, effortDistanceMiles, effortAreaAcres, notes, createdAt, submissionId)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`
          )
          .bind(
            outing.id,
            userId,
            outing.startTime,
            outing.endTime,
            outing.locationName,
            outing.defaultLocationName ?? null,
            outing.lat ?? null,
            outing.lon ?? null,
            outing.stateProvince ?? null,
            outing.countryCode ?? null,
            outing.protocol ?? null,
            outing.numberObservers ?? null,
            outing.allObsReported == null ? null : outing.allObsReported ? 1 : 0,
            outing.effortDistanceMiles ?? null,
            outing.effortAreaAcres ?? null,
            outing.notes,
            outing.createdAt,
            outing.submissionId ?? null
          )
      )
    } else if (supportsRegionColumns && supportsChecklistColumns) {
      insertStatements.push(
        context.env.DB
          .prepare(
            `INSERT INTO outing (id, userId, startTime, endTime, locationName, defaultLocationName, lat, lon, stateProvince, countryCode, protocol, numberObservers, allObsReported, effortDistanceMiles, effortAreaAcres, notes, createdAt)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`
          )
          .bind(
            outing.id,
            userId,
            outing.startTime,
            outing.endTime,
            outing.locationName,
            outing.defaultLocationName ?? null,
            outing.lat ?? null,
            outing.lon ?? null,
            outing.stateProvince ?? null,
            outing.countryCode ?? null,
            outing.protocol ?? null,
            outing.numberObservers ?? null,
            outing.allObsReported == null ? null : outing.allObsReported ? 1 : 0,
            outing.effortDistanceMiles ?? null,
            outing.effortAreaAcres ?? null,
            outing.notes,
            outing.createdAt
          )
      )
    } else if (supportsRegionColumns) {
      insertStatements.push(
        context.env.DB
          .prepare(
            `INSERT INTO outing (id, userId, startTime, endTime, locationName, defaultLocationName, lat, lon, stateProvince, countryCode, notes, createdAt)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
          )
          .bind(
            outing.id,
            userId,
            outing.startTime,
            outing.endTime,
            outing.locationName,
            outing.defaultLocationName ?? null,
            outing.lat ?? null,
            outing.lon ?? null,
            outing.stateProvince ?? null,
            outing.countryCode ?? null,
            outing.notes,
            outing.createdAt
          )
      )
    } else {
      insertStatements.push(
        context.env.DB
          .prepare(
            `INSERT INTO outing (id, userId, startTime, endTime, locationName, defaultLocationName, lat, lon, notes, createdAt)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
          )
          .bind(
            outing.id,
            userId,
            outing.startTime,
            outing.endTime,
            outing.locationName,
            outing.defaultLocationName ?? null,
            outing.lat ?? null,
            outing.lon ?? null,
            outing.notes,
            outing.createdAt
          )
      )
    }
  }

  for (const observation of importedObservations) {
    if (supportsSpeciesCommentsColumn) {
      insertStatements.push(
        context.env.DB
          .prepare(
            `INSERT INTO observation (id, outingId, userId, speciesName, count, certainty, speciesComments, notes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
          )
          .bind(
            observation.id,
            observation.outingId,
            userId,
            observation.speciesName,
            observation.count,
            observation.certainty,
            observation.notes || null,
            ''
          )
      )
    } else {
      insertStatements.push(
        context.env.DB
          .prepare(
            `INSERT INTO observation (id, outingId, userId, speciesName, count, certainty, notes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
          )
          .bind(
            observation.id,
            observation.outingId,
            userId,
            observation.speciesName,
            observation.count,
            observation.certainty,
            observation.notes
          )
      )
    }
  }

  if (insertStatements.length > 0) {
    stage = 'commit the eBird import batch'
    await context.env.DB.batch(insertStatements)
    importBatchCommitted = true
    route.succeeded(`Committed eBird import batch from ${countLabel(selectedPreviewCount, 'selected preview')} and ${countLabel(validPreviewCount, 'valid preview')}, persisting ${countLabel(persistedOutingCount, 'outing')} and ${countLabel(persistedObservationCount, 'observation')}`)
  }

  stage = 'recompute dex after the committed import batch'
  const dexUpdates = await computeDex(context.env.DB, userId)
  const newSpecies = dexUpdates.filter(row => !priorSpecies.has(row.speciesName)).length

  return route.complete(Response.json({
    imported: {
      outings: persistedOutingCount,
      observations: persistedObservationCount,
      newSpecies,
    },
    // Checklists already present for this user, skipped rather than duplicated.
    // Reported so the client can tell "nothing new to import" apart from a
    // failed import, which otherwise look identical from a zero count.
    skipped: { outings: skippedOutingCount },
    dexUpdates: enrichDexEntries(dexUpdates),
  }), `Confirmed eBird import from ${countLabel(selectedPreviewCount, 'selected preview')} and ${countLabel(validPreviewCount, 'valid preview')}, persisting ${countLabel(persistedOutingCount, 'outing')} and ${countLabel(persistedObservationCount, 'observation')} with ${newSpecies} new species, skipping ${countLabel(skippedOutingCount, 'checklist')} already imported`)
  } catch {
    if (importBatchCommitted) {
      return route.fail(500, 'Internal server error', `Committed eBird import batch with ${countLabel(persistedOutingCount, 'outing')} and ${countLabel(persistedObservationCount, 'observation')}; post-commit dex recomputation failed`)
    }
    return route.fail(500, 'Internal server error', `eBird import confirmation failed during stage: ${stage}; no import batch was committed`)
  }
 }
