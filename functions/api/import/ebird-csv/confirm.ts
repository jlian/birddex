import { computeDex, enrichDexEntries } from '../../../lib/dex-query'
import { groupPreviewsIntoOutings, type ImportPreview } from '../../../lib/ebird'
import { getOutingColumnNames, hasObservationColumn } from '../../../lib/schema'
import { createRouteResponder } from '../../../lib/log'

type ConfirmBody = { previewIds: string[] }

function isConfirmBody(value: unknown): value is ConfirmBody {
  if (!value || typeof value !== 'object') return false
  const data = value as Record<string, unknown>
  return Array.isArray(data.previewIds) && data.previewIds.every(id => typeof id === 'string')
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
    return new Response('Unauthorized', { status: 401 })
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

  if (selectedPreviews.length === 0) {
    const dexUpdates = await computeDex(context.env.DB, userId)
    return route.complete(Response.json({
      imported: { outings: 0, observations: 0, newSpecies: 0 },
      dexUpdates: enrichDexEntries(dexUpdates),
    }), `Confirmed import with 0 selected previews; recomputed ${dexUpdates.length} dex entries`)
  }

  // Snapshot species already in the user's dex before inserting
  const priorDex = await computeDex(context.env.DB, userId)
  const priorSpecies = new Set(priorDex.map(row => row.speciesName))

  const { outings, observations } = groupPreviewsIntoOutings(selectedPreviews, userId)
  const columnNames = await getOutingColumnNames(context.env.DB)
  const supportsRegionColumns = columnNames.has('stateProvince') && columnNames.has('countryCode')
  const supportsChecklistColumns =
    columnNames.has('protocol') &&
    columnNames.has('numberObservers') &&
    columnNames.has('allObsReported') &&
    columnNames.has('effortDistanceMiles') &&
    columnNames.has('effortAreaAcres')
  const supportsSpeciesCommentsColumn = await hasObservationColumn(context.env.DB, 'speciesComments')

  const insertStatements: D1PreparedStatement[] = []

  for (const outing of outings) {
    if (supportsRegionColumns && supportsChecklistColumns) {
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

  for (const observation of observations) {
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
    await context.env.DB.batch(insertStatements)
  }

  const dexUpdates = await computeDex(context.env.DB, userId)
  const newSpecies = dexUpdates.filter(row => !priorSpecies.has(row.speciesName)).length

  return route.complete(Response.json({
    imported: {
      outings: outings.length,
      observations: observations.length,
      newSpecies,
    },
    dexUpdates: enrichDexEntries(dexUpdates),
  }), `Imported ${outings.length} outings and ${observations.length} observations with ${newSpecies} new species`)
  } catch {
    return route.fail(500, 'Internal server error', 'eBird import confirmation failed; inspect the trace and database batch', { previewCount: body.previewIds.length })
  }
 }
