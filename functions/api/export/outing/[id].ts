import { exportOutingToEBirdCSV } from '../../../lib/ebird'
import { getOutingColumnNames, hasObservationColumn } from '../../../lib/schema'
import { createRouteResponder } from '../../../lib/log'

export const onRequestGet: PagesFunction<Env> = async context => {
  const userId = (context.data as { user?: { id?: string } }).user?.id
  const outingId = context.params.id as string | undefined
  const route = createRouteResponder(
    (context.data as RequestData).log,
    'export/outingCsv/export', 'Application'
  )
  if (!userId) {
    return route.fail(401, 'Unauthorized', 'Authentication is required to generate an outing CSV')
  }

  if (!outingId) {
    return route.fail(400, 'Missing outing id', 'URL path must include an outing ID segment')
  }

  let stage = 'outing schema inspection'
  try {
    const columnNames = await getOutingColumnNames(context.env.DB)
    const outingQuery = `SELECT
      id,
      startTime,
      endTime,
      locationName,
      lat,
      lon,
      ${columnNames.has('stateProvince') ? 'stateProvince' : 'NULL as stateProvince'},
      ${columnNames.has('countryCode') ? 'countryCode' : 'NULL as countryCode'},
      ${columnNames.has('protocol') ? 'protocol' : 'NULL as protocol'},
      ${columnNames.has('numberObservers') ? 'numberObservers' : 'NULL as numberObservers'},
      ${columnNames.has('allObsReported') ? 'allObsReported' : 'NULL as allObsReported'},
      ${columnNames.has('effortDistanceMiles') ? 'effortDistanceMiles' : 'NULL as effortDistanceMiles'},
      ${columnNames.has('effortAreaAcres') ? 'effortAreaAcres' : 'NULL as effortAreaAcres'},
      notes
    FROM outing WHERE id = ? AND userId = ? LIMIT 1`

    stage = 'outing database query'
    const outingResult = await context.env.DB
      .prepare(outingQuery)
      .bind(outingId, userId)
      .all<{
      id: string
      startTime: string
      endTime: string
      locationName: string
      lat?: number | null
      lon?: number | null
      stateProvince?: string | null
      countryCode?: string | null
      protocol?: string | null
      numberObservers?: number | null
      allObsReported?: number | null
      effortDistanceMiles?: number | null
      effortAreaAcres?: number | null
      notes?: string | null
      }>()

    const outing = outingResult.results[0]
    if (!outing) {
      return route.fail(404, 'Not found', 'Outing was not found for the authenticated account')
    }

    stage = 'observation schema inspection'
    const supportsSpeciesCommentsColumn = await hasObservationColumn(context.env.DB, 'speciesComments')
    const supportsSubmissionId = await hasObservationColumn(context.env.DB, 'submissionId')
    const observationNotesSelect = supportsSpeciesCommentsColumn
      ? 'COALESCE(speciesComments, notes) as notes'
      : 'notes'

    stage = 'outing observation database query'
    const observationsResult = await context.env.DB
      .prepare(
        `SELECT speciesName, count, certainty,
          ${supportsSubmissionId ? 'submissionId' : 'NULL'} as submissionId,
          ${observationNotesSelect}
       FROM observation
       WHERE outingId = ? AND userId = ?`
      )
      .bind(outingId, userId)
      .all<{
        speciesName: string
        count: number
        certainty: 'confirmed' | 'possible' | 'pending' | 'rejected'
        notes?: string | null
        submissionId?: string | null
      }>()

    stage = 'outing CSV serialization'
    const csv = exportOutingToEBirdCSV(
      {
        ...outing,
        allObsReported: outing.allObsReported == null ? null : outing.allObsReported === 1,
      },
      observationsResult.results,
      true
    )
    const safeOutingId = outingId.replace(/[^a-zA-Z0-9._-]/g, '_')
    return route.complete(new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="wingdex-outing-${safeOutingId}.csv"`,
        'cache-control': 'no-store',
      },
    }), `Generated outing CSV with ${observationsResult.results.length} ${observationsResult.results.length === 1 ? 'observation' : 'observations'}`)
  } catch {
    return route.fail(500, 'Export failed', `Outing CSV generation failed during ${stage}`)
  }
}
