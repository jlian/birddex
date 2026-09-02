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

export const onRequestPatch: ApiHandler<'id'> = async context => {
  const userId = (context.data as { user?: { id?: string } }).user?.id
  const outingId = context.params.id as string | undefined
  const route = createRouteResponder(
    (context.data as RequestData).log,
    'data/outings/write', 'Application'
  )
  if (!userId) {
    return route.fail(401, 'Unauthorized', 'Authentication is required to patch an outing')
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

  let stage = 'outing schema inspection'
  let outingUpdated = false
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
    return route.fail(400, 'No valid fields to update', 'Outing patch contains no recognized fields')
  }

  const updateStatement = `UPDATE outing SET ${updateFields.join(', ')} WHERE id = ? AND userId = ?`
  stage = 'outing database update'
  const updateResult = await context.env.DB.prepare(updateStatement)
    .bind(...bindings, outingId, userId)
    .run()

  if (updateResult.meta.changes === 0) {
    return route.fail(404, 'Not found', 'Outing was not found for the authenticated account')
  }

  outingUpdated = true
  stage = 'updated outing readback'
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
    return route.fail(404, 'Not found', 'Outing could not be read after its database update committed')
  }

  stage = 'updated outing response assembly'
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
  }), `Updated 1 outing with ${updateFields.length} ${updateFields.length === 1 ? 'field' : 'fields'}`)
  } catch {
    const detail = outingUpdated
      ? `Outing patch committed, but failed during ${stage}`
      : `Outing patch failed during ${stage} before the database update was known to commit`
    return route.fail(500, 'Internal server error', detail)
  }
}

export const onRequestDelete: ApiHandler<'id'> = async context => {
  const userId = (context.data as { user?: { id?: string } }).user?.id
  const outingId = context.params.id as string | undefined
  const route = createRouteResponder(
    (context.data as RequestData).log,
    'data/outings/delete', 'Application'
  )
  if (!userId) {
    return route.fail(401, 'Unauthorized', 'Authentication is required to delete an outing')
  }

  if (!outingId) {
    return route.fail(400, 'Missing outing id', 'URL path must include an outing ID segment')
  }

  let outingDeleted = false
  try {
    const deleteResult = await context.env.DB.prepare('DELETE FROM outing WHERE id = ? AND userId = ?')
      .bind(outingId, userId)
      .run()

    if (deleteResult.meta.changes === 0) {
      return route.fail(404, 'Not found', 'Outing was not found for the authenticated account; it may have been deleted by another client')
    }

    outingDeleted = true
    route.succeeded('Deleted 1 outing with cascaded observations and photos; starting post-delete dex recomputation')
    const dexUpdates = await computeDex(context.env.DB, userId)
    return route.complete(Response.json({ dexUpdates: enrichDexEntries(dexUpdates) }), `Deleted 1 outing with cascaded observations and photos, then recomputed ${dexUpdates.length} ${dexUpdates.length === 1 ? 'dex entry' : 'dex entries'}`)
  } catch {
    const detail = outingDeleted
      ? 'Outing, observations, and photos were deleted; post-delete dex recomputation failed'
      : 'Outing deletion failed before the database delete committed'
    return route.fail(500, 'Internal server error', detail)
  }
}
