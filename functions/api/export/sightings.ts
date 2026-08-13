import { exportOutingToEBirdCSV } from '../../lib/ebird'
import { getOutingColumnNames, hasObservationColumn } from '../../lib/schema'
import { createRouteResponder } from '../../lib/log'

type ExportRow = {
  outingId: string
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
  outingNotes?: string | null
  speciesName: string
  count: number
  certainty: 'confirmed' | 'possible' | 'pending' | 'rejected'
  observationNotes?: string | null
  submissionId?: string | null
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

export const onRequestGet: PagesFunction<Env> = async context => {
  const userId = (context.data as { user?: { id?: string } }).user?.id
  const route = createRouteResponder((context.data as RequestData).log, 'export/sightings/export', 'Application')
  if (!userId) {
    return route.fail(401, 'Unauthorized', 'Authentication is required to generate a sightings CSV')
  }

  let stage = 'outing schema inspection'
  try {
    const columnNames = await getOutingColumnNames(context.env.DB)
    stage = 'observation schema inspection'
    const supportsSpeciesCommentsColumn = await hasObservationColumn(context.env.DB, 'speciesComments')
    const supportsSubmissionId = await hasObservationColumn(context.env.DB, 'submissionId')
    const observationNotesSelect = supportsSpeciesCommentsColumn
    ? 'COALESCE(ob.speciesComments, ob.notes)'
    : 'ob.notes'
    const rowsQuery = `SELECT
         o.id as outingId,
         o.startTime,
         o.endTime,
         o.locationName,
         o.lat,
         o.lon,
         ${columnNames.has('stateProvince') ? 'o.stateProvince' : 'NULL'} as stateProvince,
         ${columnNames.has('countryCode') ? 'o.countryCode' : 'NULL'} as countryCode,
         ${columnNames.has('protocol') ? 'o.protocol' : 'NULL'} as protocol,
         ${columnNames.has('numberObservers') ? 'o.numberObservers' : 'NULL'} as numberObservers,
         ${columnNames.has('allObsReported') ? 'o.allObsReported' : 'NULL'} as allObsReported,
         ${columnNames.has('effortDistanceMiles') ? 'o.effortDistanceMiles' : 'NULL'} as effortDistanceMiles,
         ${columnNames.has('effortAreaAcres') ? 'o.effortAreaAcres' : 'NULL'} as effortAreaAcres,
         o.notes as outingNotes,
         ob.speciesName,
         ob.count,
         ob.certainty,
         ${supportsSubmissionId ? 'ob.submissionId' : 'NULL'} as submissionId,
         ${observationNotesSelect} as observationNotes
       FROM observation ob
       INNER JOIN outing o ON o.id = ob.outingId
       WHERE ob.userId = ?
       ORDER BY o.startTime ASC, o.id ASC, ob.id ASC`

    stage = 'sightings database query'
    const rowsResult = await context.env.DB
      .prepare(rowsQuery)
      .bind(userId)
      .all<ExportRow>()

    const rows = rowsResult.results
    stage = 'sightings CSV serialization'
    if (rows.length === 0) {
    const emptyCsv = exportOutingToEBirdCSV(
      {
        id: 'empty',
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        locationName: '',
      },
      [],
      true
    )

    return route.complete(new Response(emptyCsv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="wingdex-sightings.csv"',
        'cache-control': 'no-store',
      },
    }), 'Generated empty sightings CSV because no observations were found')
    }

    const byOuting = new Map<string, ExportRow[]>()
    for (const row of rows) {
    const existing = byOuting.get(row.outingId)
    if (existing) existing.push(row)
    else byOuting.set(row.outingId, [row])
    }

    const csvChunks: string[] = []
    let includeHeader = true

    for (const outingRows of byOuting.values()) {
    const first = outingRows[0]
    const csv = exportOutingToEBirdCSV(
      {
        id: first.outingId,
        startTime: first.startTime,
        endTime: first.endTime,
        locationName: first.locationName,
        lat: first.lat,
        lon: first.lon,
        stateProvince: first.stateProvince,
        countryCode: first.countryCode,
        protocol: first.protocol,
        numberObservers: first.numberObservers,
        allObsReported: first.allObsReported == null ? null : first.allObsReported === 1,
        effortDistanceMiles: first.effortDistanceMiles,
        effortAreaAcres: first.effortAreaAcres,
        notes: first.outingNotes,
      },
      outingRows.map(row => ({
        speciesName: row.speciesName,
        count: row.count,
        certainty: row.certainty,
        notes: row.observationNotes,
        submissionId: row.submissionId,
      })),
      includeHeader
    )

    includeHeader = false
    if (csv.trim()) {
      csvChunks.push(csv)
    }
    }

    const csv = csvChunks.join('\n')

    return route.complete(new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="wingdex-sightings-${new Date().toISOString().split('T')[0]}.csv"`,
      'cache-control': 'no-store',
    },
    }), `Generated sightings CSV with ${countLabel(rows.length, 'sighting')} across ${countLabel(byOuting.size, 'outing')}`)
  } catch {
    return route.fail(500, 'Export failed', `Sightings CSV generation failed during ${stage}`)
  }
}
