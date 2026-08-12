import { computeDex, enrichDexEntries } from '../../lib/dex-query'
import { groupPreviewsIntoOutings, parseEBirdCSV } from '../../lib/ebird'
import { getOutingColumnNames, hasObservationColumn } from '../../lib/schema'
import { createRouteResponder } from '../../lib/log'
import { rateLimitKey } from '../../lib/rate-limit'

const MAX_CSV_SIZE_BYTES = 10 * 1024 * 1024

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

async function importContentKey(fileBytes: Uint8Array, profileTimezone: string | undefined): Promise<string> {
  const prefix = new TextEncoder().encode(`${profileTimezone ?? 'observation-local'}\0`)
  const bytes = new Uint8Array(prefix.length + fileBytes.length)
  bytes.set(prefix)
  bytes.set(fileBytes, prefix.length)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

async function existingImportKeys(
  db: D1Database,
  userId: string,
  source: string,
  candidateKeys: string[],
): Promise<Set<string>> {
  const existing = new Set<string>()
  const chunkSize = 98 // userId and source consume two of D1's 100 parameters.
  for (let index = 0; index < candidateKeys.length; index += chunkSize) {
    const chunk = candidateKeys.slice(index, index + chunkSize)
    const placeholders = chunk.map(() => '?').join(', ')
    const found = await db
      .prepare(`SELECT sourceKey FROM importIdentity WHERE userId = ? AND source = ? AND sourceKey IN (${placeholders})`)
      .bind(userId, source, ...chunk)
      .all<{ sourceKey: string }>()
    for (const row of found.results ?? []) existing.add(row.sourceKey)
  }
  return existing
}

/**
 * Import an eBird CSV export in one request.
 *
 * This used to be two phases: the server parsed the CSV into "previews" and
 * handed them back, and the client posted back the ones it wanted written.
 * Nothing ever rendered them, so the round trip only echoed the server's own
 * parse back to it. Worse, a preview id was the base64 of a whole row rather
 * than a handle to server state, so confirm wrote whatever it was handed, and
 * which rows the client returned changed how the rest grouped.
 */
export const onRequestPost: PagesFunction<Env> = async context => {
  const userId = (context.data as { user?: { id?: string } }).user?.id
  const route = createRouteResponder((context.data as RequestData).log, 'import/ebirdCsv/import', 'Application')
  if (!userId) {
    return route.fail(401, 'Unauthorized', 'Authentication is required to import an eBird CSV')
  }

  const { success } = await context.env.IMPORT_LIMITER.limit({
    key: rateLimitKey((context.data as RequestData).user, context.request),
  })
  if (!success) {
    return route.failWithHeaders(429, 'Too many requests', { 'Retry-After': '60' }, 'eBird import exceeded the rate limit for this account; retry after the window closes')
  }

  let formData: FormData
  try {
    formData = await context.request.formData()
  } catch {
    return route.fail(400, 'Invalid form payload', 'Could not parse request body as multipart/form-data; ensure the request uses multipart encoding with a file field')
  }

  const file = formData.get('file')
  if (!(file instanceof File)) {
    return route.fail(400, 'Missing CSV file', 'No CSV file found in the file form field; include a file field with the eBird CSV export')
  }

  if (file.size > MAX_CSV_SIZE_BYTES) {
    return route.fail(413, 'CSV file too large (max 10MB)', `CSV file is ${file.size} bytes, exceeding the ${MAX_CSV_SIZE_BYTES}-byte limit; try exporting a smaller date range from eBird`, { fileSize: file.size, limit: MAX_CSV_SIZE_BYTES })
  }

  const profileTimezone = formData.get('profileTimezone')
  let parsedRowCount = 0
  let persistedOutingCount = 0
  let persistedObservationCount = 0
  let skippedRowCount = 0
  let importBatchCommitted = false
  let fileIdentityKey: string | undefined
  let stage = 'read the uploaded CSV file'

  try {
    const fileBytes = new Uint8Array(await file.arrayBuffer())
    const csvContent = new TextDecoder().decode(fileBytes)

    stage = 'parse the uploaded eBird CSV'
    const normalizedProfileTimezone = typeof profileTimezone === 'string' ? profileTimezone : undefined
    const parsedRows = parseEBirdCSV(csvContent, normalizedProfileTimezone)
    parsedRowCount = parsedRows.length
    fileIdentityKey = await importContentKey(fileBytes, normalizedProfileTimezone)

    stage = 'read the pre-import dex snapshot'
    const priorDex = await computeDex(context.env.DB, userId)
    const priorSpecies = new Set(priorDex.map(row => row.speciesName))

    stage = 'check exact import receipt'
    const existingFileIdentity = await existingImportKeys(
      context.env.DB,
      userId,
      'file',
      [fileIdentityKey],
    )
    if (existingFileIdentity.has(fileIdentityKey)) {
      return route.complete(Response.json({
        imported: { outings: 0, observations: 0, newSpecies: 0 },
        skipped: { rows: parsedRowCount },
        dexUpdates: enrichDexEntries(priorDex),
      }), `Skipped exact eBird CSV retry with ${countLabel(parsedRowCount, 'row')}`)
    }

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
    const supportsSubmissionId = await hasObservationColumn(context.env.DB, 'submissionId')

    // Checklist-level idempotency, applied to the rows BEFORE they are grouped.
    // An outing can merge several checklists, so it cannot identify them; an
    // observation is exactly one (checklist, species) row and can.
    //
    // Rows with no submission id fall back to date+location grouping and cannot
    // be identified reliably, so they are always imported rather than guessed at.
    stage = 'skip checklists already imported'
    let importableRows = parsedRows
    if (supportsSubmissionId) {
      const candidateIds = [...new Set(
        parsedRows
          .map(row => row.submissionId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      )]

      if (candidateIds.length > 0) {
        const existingIds = await existingImportKeys(context.env.DB, userId, 'submission', candidateIds)

        const wingDexOutingIds = candidateIds
          .filter(id => id.startsWith('WINGDEX-OUTING-'))
          .map(id => id.slice('WINGDEX-OUTING-'.length))
          .filter(Boolean)
        const existingWingDexOutings = new Set<string>()
        const outingChunkSize = 99
        for (let index = 0; index < wingDexOutingIds.length; index += outingChunkSize) {
          const chunk = wingDexOutingIds.slice(index, index + outingChunkSize)
          const placeholders = chunk.map(() => '?').join(', ')
          const found = await context.env.DB
            .prepare(`SELECT id FROM outing WHERE userId = ? AND id IN (${placeholders})`)
            .bind(userId, ...chunk)
            .all<{ id: string }>()
          for (const row of found.results ?? []) {
            existingWingDexOutings.add(`WINGDEX-OUTING-${row.id}`)
          }
        }
        for (const id of existingWingDexOutings) existingIds.add(id)

        if (existingIds.size > 0) {
          importableRows = parsedRows.filter(row => !row.submissionId || !existingIds.has(row.submissionId))
          skippedRowCount = parsedRows.length - importableRows.length
        }
      }
    }

    const commitRows = async (rows: typeof parsedRows) => {
      stage = 'group the importable rows into outings'
      const { outings, observations } = groupPreviewsIntoOutings(rows, userId)
      const insertStatements: D1PreparedStatement[] = [
        context.env.DB
          .prepare('INSERT INTO importIdentity (userId, source, sourceKey, rowCount) VALUES (?, ?, ?, ?)')
          .bind(userId, 'file', fileIdentityKey, parsedRowCount),
      ]

      const submissionIds = [...new Set(
        rows
          .map(row => row.submissionId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      )]
      for (const submissionId of submissionIds) {
        insertStatements.push(
          context.env.DB
            .prepare('INSERT INTO importIdentity (userId, source, sourceKey, rowCount) VALUES (?, ?, ?, ?)')
            .bind(userId, 'submission', submissionId, rows.filter(row => row.submissionId === submissionId).length)
        )
      }

      for (const outing of outings) {
        const columns = ['id', 'userId', 'startTime', 'endTime', 'locationName', 'defaultLocationName', 'lat', 'lon', 'notes', 'createdAt']
        const values: (string | number | null)[] = [
          outing.id, userId, outing.startTime, outing.endTime, outing.locationName,
          outing.defaultLocationName ?? null, outing.lat ?? null, outing.lon ?? null,
          outing.notes, outing.createdAt,
        ]
        if (supportsRegionColumns) {
          columns.push('stateProvince', 'countryCode')
          values.push(outing.stateProvince ?? null, outing.countryCode ?? null)
        }
        if (supportsChecklistColumns) {
          columns.push('protocol', 'numberObservers', 'allObsReported', 'effortDistanceMiles', 'effortAreaAcres')
          values.push(
            outing.protocol ?? null,
            outing.numberObservers ?? null,
            outing.allObsReported == null ? null : outing.allObsReported ? 1 : 0,
            outing.effortDistanceMiles ?? null,
            outing.effortAreaAcres ?? null,
          )
        }
        const placeholders = values.map((_, index) => `?${index + 1}`).join(', ')
        insertStatements.push(context.env.DB.prepare(`INSERT INTO outing (${columns.join(', ')}) VALUES (${placeholders})`).bind(...values))
      }

      for (const observation of observations) {
        const columns = ['id', 'outingId', 'userId', 'speciesName', 'count', 'certainty', 'notes']
        const values: (string | number | null)[] = [
          observation.id, observation.outingId, userId, observation.speciesName,
          observation.count, observation.certainty, observation.notes,
        ]
        if (supportsSpeciesCommentsColumn) {
          columns.push('speciesComments')
          values.push(observation.notes || null)
          values[columns.indexOf('notes')] = ''
        }
        if (supportsSubmissionId) {
          columns.push('submissionId')
          values.push(observation.submissionId ?? null)
        }
        const placeholders = values.map((_, index) => `?${index + 1}`).join(', ')
        insertStatements.push(context.env.DB.prepare(`INSERT INTO observation (${columns.join(', ')}) VALUES (${placeholders})`).bind(...values))
      }

      stage = 'commit the eBird import batch'
      await context.env.DB.batch(insertStatements)
      return { outings: outings.length, observations: observations.length }
    }

    let rowsToCommit = importableRows
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const committed = await commitRows(rowsToCommit)
        persistedOutingCount = committed.outings
        persistedObservationCount = committed.observations
        importBatchCommitted = true
        break
      } catch {
        const exactReceipt = await existingImportKeys(context.env.DB, userId, 'file', [fileIdentityKey])
        if (exactReceipt.has(fileIdentityKey)) {
          skippedRowCount = parsedRowCount
          rowsToCommit = []
          break
        }
        const candidateIds = [...new Set(rowsToCommit.flatMap(row => row.submissionId ? [row.submissionId] : []))]
        const newlyClaimed = candidateIds.length > 0
          ? await existingImportKeys(context.env.DB, userId, 'submission', candidateIds)
          : new Set<string>()
        const remaining = rowsToCommit.filter(row => !row.submissionId || !newlyClaimed.has(row.submissionId))
        if (remaining.length === rowsToCommit.length) throw new Error('Import batch failed without a competing identity claim')
        skippedRowCount += rowsToCommit.length - remaining.length
        rowsToCommit = remaining
      }
    }
    if (!importBatchCommitted && rowsToCommit.length > 0) {
      throw new Error('Import identity retry limit exceeded')
    }
    if (importBatchCommitted) {
      route.succeeded(`Committed eBird import batch from ${countLabel(parsedRowCount, 'parsed row')}, persisting ${countLabel(persistedOutingCount, 'outing')} and ${countLabel(persistedObservationCount, 'observation')}`)
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
      // Rows belonging to checklists already stored, skipped rather than
      // duplicated. Reported so the client can tell "nothing new to import"
      // apart from a failed import, which look identical from a zero count.
      skipped: { rows: skippedRowCount },
      dexUpdates: enrichDexEntries(dexUpdates),
    }), `Imported eBird CSV from ${countLabel(parsedRowCount, 'parsed row')}, persisting ${countLabel(persistedOutingCount, 'outing')} and ${countLabel(persistedObservationCount, 'observation')} with ${newSpecies} new species, skipping ${countLabel(skippedRowCount, 'row')} already imported`)
  } catch {
    if (!importBatchCommitted && fileIdentityKey) {
      let wonByConcurrentImport = new Set<string>()
      try {
        wonByConcurrentImport = await existingImportKeys(
          context.env.DB,
          userId,
          'file',
          [fileIdentityKey],
        )
      } catch {
        route.log?.info('import/ebirdCsv/import', {
          category: 'Application',
          resultDescription: 'Could not verify whether a concurrent import committed after the batch failed',
        })
      }
      if (wonByConcurrentImport.has(fileIdentityKey)) {
        const dexUpdates = await computeDex(context.env.DB, userId)
        return route.complete(Response.json({
          imported: { outings: 0, observations: 0, newSpecies: 0 },
          skipped: { rows: parsedRowCount },
          dexUpdates: enrichDexEntries(dexUpdates),
        }), `Skipped concurrent eBird CSV retry with ${countLabel(parsedRowCount, 'row')}`)
      }
    }
    if (importBatchCommitted) {
      return route.fail(500, 'Internal server error', `Committed eBird import batch with ${countLabel(persistedOutingCount, 'outing')} and ${countLabel(persistedObservationCount, 'observation')}; post-commit dex recomputation failed`)
    }
    return route.fail(500, 'Internal server error', `eBird import failed during stage: ${stage}; no import batch was committed`)
  }
}
