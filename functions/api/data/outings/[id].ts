import { computeDex, enrichDexEntries } from '../../../lib/dex-query'
import { getOutingColumnNames } from '../../../lib/schema'
import { createRouteResponder } from '../../../lib/log'

type UpdateOutingBody = {
  startTime?: string
  endTime?: string
  locationName?: string
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
  notes?: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

export const onRequestPatch: PagesFunction<Env> = async context => {
  const userId = (context.data as { user?: { id?: string } }).user?.id
  const outingId = context.params.id as string | undefined
  const route = createRouteResponder(
    (context.data as RequestData).log,
    'data/outings/write', 'Application'
  )
  if (!userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  if (!outingId) {
    return route.fail(400, 'Missing outing id', 'URL path must include an outing ID segment')
  }

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return route.fail(400, 'Invalid JSON body', 'Request body could not be parsed as JSON; check Content-Type is application/json and body is valid JSON')
  }

  if (!isObject(body)) {
    return route.fail(400, 'Invalid outing patch payload', 'Outing patch payload is not a valid object')
  }

  try {

  const updates = body as UpdateOutingBody
  const updateFields: string[] = []
  const bindings: Array<string | number | null> = []
  const columnNames = await getOutingColumnNames(context.env.DB)

  if (typeof updates.startTime === 'string') {
    updateFields.push('startTime = ?')
    bindings.push(updates.startTime)
  }
  if (typeof updates.endTime === 'string') {
    updateFields.push('endTime = ?')
    bindings.push(updates.endTime)
  }
  if (typeof updates.locationName === 'string') {
    updateFields.push('locationName = ?')
    bindings.push(updates.locationName)
  }
  if ('defaultLocationName' in updates) {
    updateFields.push('defaultLocationName = ?')
    bindings.push(updates.defaultLocationName ?? null)
  }
  if ('lat' in updates) {
    updateFields.push('lat = ?')
    bindings.push(updates.lat ?? null)
  }
  if ('lon' in updates) {
    updateFields.push('lon = ?')
    bindings.push(updates.lon ?? null)
  }
  if ('stateProvince' in updates && columnNames.has('stateProvince')) {
    updateFields.push('stateProvince = ?')
    bindings.push(updates.stateProvince ?? null)
  }
  if ('countryCode' in updates && columnNames.has('countryCode')) {
    updateFields.push('countryCode = ?')
    bindings.push(updates.countryCode ? updates.countryCode.trim().toUpperCase() : null)
  }
  if ('protocol' in updates && columnNames.has('protocol')) {
    updateFields.push('protocol = ?')
    bindings.push(updates.protocol?.trim() || null)
  }
  if ('numberObservers' in updates && columnNames.has('numberObservers')) {
    updateFields.push('numberObservers = ?')
    bindings.push(
      typeof updates.numberObservers === 'number' && Number.isFinite(updates.numberObservers)
        ? Math.max(0, Math.trunc(updates.numberObservers))
        : null
    )
  }
  if ('allObsReported' in updates && columnNames.has('allObsReported')) {
    updateFields.push('allObsReported = ?')
    bindings.push(typeof updates.allObsReported === 'boolean' ? (updates.allObsReported ? 1 : 0) : null)
  }
  if ('effortDistanceMiles' in updates && columnNames.has('effortDistanceMiles')) {
    updateFields.push('effortDistanceMiles = ?')
    bindings.push(
      typeof updates.effortDistanceMiles === 'number' && Number.isFinite(updates.effortDistanceMiles)
        ? updates.effortDistanceMiles
        : null
    )
  }
  if ('effortAreaAcres' in updates && columnNames.has('effortAreaAcres')) {
    updateFields.push('effortAreaAcres = ?')
    bindings.push(
      typeof updates.effortAreaAcres === 'number' && Number.isFinite(updates.effortAreaAcres)
        ? updates.effortAreaAcres
        : null
    )
  }
  if (typeof updates.notes === 'string') {
    updateFields.push('notes = ?')
    bindings.push(updates.notes)
  }

  if (updateFields.length === 0) {
    return route.fail(400, 'No valid fields to update', `No valid fields to update for outing ${outingId}`, { outingId })
  }

  const updateStatement = `UPDATE outing SET ${updateFields.join(', ')} WHERE id = ? AND userId = ?`
  const updateResult = await context.env.DB.prepare(updateStatement)
    .bind(...bindings, outingId, userId)
    .run()

  if (updateResult.meta.changes === 0) {
    return route.fail(404, 'Not found', `Outing ${outingId} not found or not owned by user`, { outingId })
  }

  const outingResult = await context.env.DB.prepare(
    'SELECT * FROM outing WHERE id = ? AND userId = ? LIMIT 1'
  )
    .bind(outingId, userId)
    .all<{
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
    }>()

  const outing = outingResult.results[0]
  if (!outing) {
    return route.fail(404, 'Not found', `Outing ${outingId} not found after successful update`, { outingId })
  }

  return route.complete(Response.json({
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
  }), `Updated outing ${outingId} with ${updateFields.length} fields`)
  } catch {
    return route.fail(500, 'Internal server error', 'Outing patch failed; inspect the trace and database operation', { outingId })
  }
}

export const onRequestDelete: PagesFunction<Env> = async context => {
  const userId = (context.data as { user?: { id?: string } }).user?.id
  const outingId = context.params.id as string | undefined
  const route = createRouteResponder(
    (context.data as RequestData).log,
    'data/outings/delete', 'Application'
  )
  if (!userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  if (!outingId) {
    return route.fail(400, 'Missing outing id', 'URL path must include an outing ID segment')
  }

  try {
    const deleteResult = await context.env.DB.prepare('DELETE FROM outing WHERE id = ? AND userId = ?')
      .bind(outingId, userId)
      .run()

    if (deleteResult.meta.changes === 0) {
      return route.fail(404, 'Not found', `Outing ${outingId} not found or not owned by user; it may have been deleted by another client`, { outingId })
    }

    const dexUpdates = await computeDex(context.env.DB, userId)
    return route.complete(Response.json({ dexUpdates: enrichDexEntries(dexUpdates) }), `Deleted outing ${outingId} and recomputed ${dexUpdates.length} dex entries`)
  } catch {
    return route.fail(500, 'Internal server error', 'Outing deletion failed; inspect the trace and database operation', { outingId })
  }
}
