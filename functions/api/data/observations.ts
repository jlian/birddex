import { computeDex, enrichDexEntries } from '../../lib/dex-query'
import { hasObservationColumn } from '../../lib/schema'
import { createRouteResponder } from '../../lib/log'
import { queryInChunks } from '../../lib/d1-chunk'

type ObservationCertainty = 'confirmed' | 'possible' | 'pending' | 'rejected'

type CreateObservationInput = {
  id: string
  outingId: string
  speciesName: string
  count: number
  certainty: ObservationCertainty
  representativePhotoId?: string
  aiConfidence?: number
  speciesComments?: string
  notes?: string
}

type ObservationPatch = {
  outingId?: string
  speciesName?: string
  count?: number
  certainty?: ObservationCertainty
  representativePhotoId?: string | null
  aiConfidence?: number | null
  speciesComments?: string
  notes?: string
}

function isCertainty(value: unknown): value is ObservationCertainty {
  return value === 'confirmed' || value === 'possible' || value === 'pending' || value === 'rejected'
}

function isCreateObservationInput(value: unknown): value is CreateObservationInput {
  if (!value || typeof value !== 'object') return false
  const data = value as Record<string, unknown>

  return (
    typeof data.id === 'string' &&
    typeof data.outingId === 'string' &&
    typeof data.speciesName === 'string' &&
    typeof data.count === 'number' &&
    isCertainty(data.certainty)
  )
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function getPatchBindings(patch: ObservationPatch, supportsSpeciesCode: boolean): {
  updateFields: string[]
  bindings: Array<string | number | null>
} {
  const updateFields: string[] = []
  const bindings: Array<string | number | null> = []

  if (typeof patch.outingId === 'string') {
    updateFields.push('outingId = ?')
    bindings.push(patch.outingId)
  }
  if (typeof patch.speciesName === 'string') {
    updateFields.push('speciesName = ?')
    bindings.push(patch.speciesName)
    // Recompute the code from the NEW name. Leaving the old one would file the
    // observation under the species it used to be, which is a worse failure
    // than having no code at all: the row would silently join another bird's
    // dex entry. Resolving to nothing clears it back to the name fallback.
    if (supportsSpeciesCode) {
      updateFields.push('speciesCode = ?')
      bindings.push(resolveSpeciesCode(patch.speciesName) || null)
    }
  }
  if (typeof patch.count === 'number') {
    updateFields.push('count = ?')
    bindings.push(patch.count)
  }
  if (patch.certainty && isCertainty(patch.certainty)) {
    updateFields.push('certainty = ?')
    bindings.push(patch.certainty)
  }
  if ('representativePhotoId' in patch) {
    updateFields.push('representativePhotoId = ?')
    bindings.push(patch.representativePhotoId ?? null)
  }
  if ('aiConfidence' in patch) {
    updateFields.push('aiConfidence = ?')
    bindings.push(patch.aiConfidence ?? null)
  }
  if (typeof patch.speciesComments === 'string') {
    updateFields.push('speciesComments = ?')
    bindings.push(patch.speciesComments)
  }
  if (typeof patch.notes === 'string') {
    updateFields.push('notes = ?')
    bindings.push(patch.notes)
  }

  return { updateFields, bindings }
}

async function listObservationsByIds(db: D1Database, userId: string, ids: string[]) {
  if (ids.length === 0) return []

  const supportsSpeciesComments = await hasObservationColumn(db, 'speciesComments')
  const speciesCommentsSelect = supportsSpeciesComments ? 'speciesComments' : 'NULL as speciesComments'
  // Return the code the SERVER resolved, not whatever the client sent. Without
  // it a create or patch response carries no grouping key, so the client keeps
  // grouping by name until the next full reload.
  const supportsSpeciesCode = await hasObservationColumn(db, 'speciesCode')
  const speciesCodeSelect = supportsSpeciesCode ? 'speciesCode' : 'NULL as speciesCode'

  const rows = await queryInChunks(ids, (chunk, placeholders) =>
    db
      .prepare(
        `SELECT id, outingId, speciesName, ${speciesCodeSelect}, count, certainty, representativePhotoId, aiConfidence, ${speciesCommentsSelect}, notes
       FROM observation
       WHERE userId = ? AND id IN (${placeholders})`
      )
      .bind(userId, ...chunk)
      .all<{
        id: string
        outingId: string
        speciesName: string
        speciesCode?: string | null
        count: number
        certainty: ObservationCertainty
        representativePhotoId?: string | null
        aiConfidence?: number | null
        speciesComments?: string | null
        notes: string
      }>()
      .then(result => result.results)
  )

  return rows.map(observation => ({
    ...observation,
    speciesCode: observation.speciesCode || undefined,
    representativePhotoId: observation.representativePhotoId || undefined,
    aiConfidence: observation.aiConfidence ?? undefined,
    speciesComments: observation.speciesComments || undefined,
  }))
}

async function hasOwnedOutings(db: D1Database, userId: string, outingIds: string[]): Promise<boolean> {
  const uniqueOutingIds = Array.from(new Set(outingIds))
  if (uniqueOutingIds.length === 0) return true

  const rows = await queryInChunks(uniqueOutingIds, async (chunk, placeholders) => {
    const result = await db
      .prepare(`SELECT id FROM outing WHERE userId = ? AND id IN (${placeholders})`)
      .bind(userId, ...chunk)
      .all<{ id: string }>()
    return result.results
  })

  return rows.length === uniqueOutingIds.length
}

async function hasCompatibleObservationIds(
  db: D1Database,
  userId: string,
  observations: CreateObservationInput[],
  requireAll = false,
): Promise<boolean> {
  const ids = [...new Set(observations.map(observation => observation.id))]
  if (ids.length === 0) return true
  const expectedOutings = new Map(observations.map(observation => [observation.id, observation.outingId]))
  const existing = await queryInChunks(ids, async (chunk, placeholders) => {
    const result = await db
      .prepare(`SELECT id, userId, outingId FROM observation WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all<{ id: string; userId: string; outingId: string }>()
    return result.results
  })
  return (!requireAll || existing.length === ids.length) &&
    existing.every(observation => observation.userId === userId && observation.outingId === expectedOutings.get(observation.id))
}

async function hasOwnedPhotos(db: D1Database, userId: string, photoRefs: Array<{ photoId: string; outingId?: string }>): Promise<boolean> {
  if (photoRefs.length === 0) return true
  const ids = [...new Set(photoRefs.map(ref => ref.photoId))]
  const rows = await queryInChunks(ids, async (chunk, placeholders) => {
    const result = await db
      .prepare(`SELECT id, outingId FROM photo WHERE userId = ? AND id IN (${placeholders})`)
      .bind(userId, ...chunk)
      .all<{ id: string; outingId: string }>()
    return result.results
  })
  if (rows.length !== ids.length) return false
  const photosById = new Map(rows.map(photo => [photo.id, photo]))
  return photoRefs.every(ref => {
    const photo = photosById.get(ref.photoId)
    return !!photo && (!ref.outingId || photo.outingId === ref.outingId)
  })
}

function hasConflictingObservationIds(observations: CreateObservationInput[]): boolean {
  return new Set(observations.map(observation => observation.id)).size !== observations.length
}

function hasConflictingPhotoRefs(observations: CreateObservationInput[]): boolean {
  const outingsByPhoto = new Map<string, string>()
  for (const observation of observations) {
    if (!observation.representativePhotoId) continue
    const existing = outingsByPhoto.get(observation.representativePhotoId)
    if (existing && existing !== observation.outingId) return true
    outingsByPhoto.set(observation.representativePhotoId, observation.outingId)
  }
  return false
}

export const onRequestPost: PagesFunction<Env> = async context => {
  const userId = (context.data as { user?: { id?: string } }).user?.id
  const route = createRouteResponder((context.data as RequestData).log, 'data/observations/write', 'Application')
  if (!userId) {
    return route.fail(401, 'Unauthorized', 'Authentication is required to persist observations')
  }

  let body: unknown
  try {
    body = await context.request.json()
    } catch {
    return route.fail(400, 'Invalid JSON body', 'Request body could not be parsed as JSON; check Content-Type is application/json and body is valid JSON')
  }

  if (!Array.isArray(body) || !body.every(isCreateObservationInput)) {
    return route.fail(400, 'Invalid observations payload', 'Observations payload failed validation; expected array of {id, outingId, speciesName, count, certainty}', { count: Array.isArray(body) ? body.length : 0 })
  }

  if (body.length === 0) {
    const dexUpdates = await computeDex(context.env.DB, userId)
    return route.complete(
      Response.json({ observations: [], dexUpdates: enrichDexEntries(dexUpdates) }),
      `No observations submitted; recomputed ${countLabel(dexUpdates.length, 'dex entry', 'dex entries')}`,
    )
  }
  if (hasConflictingObservationIds(body)) {
    return route.fail(400, 'Duplicate observation IDs', 'Observation payload must contain unique IDs', { count: body.length })
  }
  if (hasConflictingPhotoRefs(body)) {
    return route.fail(400, 'Invalid photo references', 'A representative photo cannot reference multiple outings in one request')
  }

  let observationBatchCommitted = false
  let observationBatchVerified = false
  try {
    const outingIds = [...new Set(body.map(o => o.outingId))]
    const allOwned = await hasOwnedOutings(
      context.env.DB,
      userId,
      outingIds
    )
    if (!allOwned) {
      return route.fail(400, 'Invalid outing reference', `One or more outing IDs do not belong to the requesting user`, { outingIds })
    }
    if (!await hasCompatibleObservationIds(context.env.DB, userId, body)) {
      return route.fail(409, 'Observation ID conflict', 'One or more observation IDs already belong to another account or outing', { count: body.length })
    }
    const photoRefs = body
      .filter(observation => observation.representativePhotoId)
      .map(observation => ({ photoId: observation.representativePhotoId!, outingId: observation.outingId }))
    if (!await hasOwnedPhotos(context.env.DB, userId, photoRefs)) {
      return route.fail(400, 'Invalid photo reference', 'Representative photos must belong to the requesting account and outing', { count: photoRefs.length })
    }

    const supportsSpeciesComments = await hasObservationColumn(context.env.DB, 'speciesComments')
    // Resolve the code on this path too, not just in the CSV importer. These
    // are the photo, manual and iOS sync writes, so leaving them NULL would
    // mean the dex still splits renamed species for everything except imports.
    const supportsSpeciesCode = await hasObservationColumn(context.env.DB, 'speciesCode')

    const statements = body.map(observation => {
      const speciesCode = resolveSpeciesCode(observation.speciesName) || null

      if (supportsSpeciesComments && supportsSpeciesCode) {
        return context.env.DB.prepare(
          `INSERT INTO observation (id, outingId, userId, speciesName, speciesCode, count, certainty, representativePhotoId, aiConfidence, speciesComments, notes)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
           ON CONFLICT(id) DO UPDATE SET
             speciesName = excluded.speciesName,
             speciesCode = excluded.speciesCode,
             count = excluded.count,
             certainty = excluded.certainty,
             representativePhotoId = excluded.representativePhotoId,
             aiConfidence = excluded.aiConfidence,
             speciesComments = excluded.speciesComments,
             notes = excluded.notes
           WHERE observation.userId = excluded.userId AND observation.outingId = excluded.outingId`
        ).bind(
          observation.id,
          observation.outingId,
          userId,
          observation.speciesName,
          speciesCode,
          observation.count,
          observation.certainty,
          observation.representativePhotoId ?? null,
          observation.aiConfidence ?? null,
          observation.speciesComments ?? null,
          observation.notes ?? ''
        )
      }

      if (supportsSpeciesComments) {
        return context.env.DB.prepare(
          `INSERT INTO observation (id, outingId, userId, speciesName, count, certainty, representativePhotoId, aiConfidence, speciesComments, notes)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
           ON CONFLICT(id) DO UPDATE SET
             speciesName = excluded.speciesName,
             count = excluded.count,
             certainty = excluded.certainty,
             representativePhotoId = excluded.representativePhotoId,
             aiConfidence = excluded.aiConfidence,
             speciesComments = excluded.speciesComments,
             notes = excluded.notes
           WHERE observation.userId = excluded.userId AND observation.outingId = excluded.outingId`
        ).bind(
          observation.id,
          observation.outingId,
          userId,
          observation.speciesName,
          observation.count,
          observation.certainty,
          observation.representativePhotoId ?? null,
          observation.aiConfidence ?? null,
          observation.speciesComments ?? null,
          observation.notes ?? ''
        )
      }

      return context.env.DB.prepare(
        `INSERT INTO observation (id, outingId, userId, speciesName, count, certainty, representativePhotoId, aiConfidence, notes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
           speciesName = excluded.speciesName,
           count = excluded.count,
           certainty = excluded.certainty,
           representativePhotoId = excluded.representativePhotoId,
           aiConfidence = excluded.aiConfidence,
           notes = excluded.notes
         WHERE observation.userId = excluded.userId AND observation.outingId = excluded.outingId`
      ).bind(
        observation.id,
        observation.outingId,
        userId,
        observation.speciesName,
        observation.count,
        observation.certainty,
        observation.representativePhotoId ?? null,
        observation.aiConfidence ?? null,
        observation.notes ?? ''
      )
    })

    await context.env.DB.batch(statements)
    observationBatchCommitted = true
    if (!await hasCompatibleObservationIds(context.env.DB, userId, body, true)) {
      if (body.length > 1) {
        route.failed(`Committed ${body.length}-record observation batch, but post-commit ownership verification failed`)
      }
      return route.fail(409, 'Observation ID conflict', 'One or more observation IDs were concurrently claimed by another account or outing', { count: body.length })
    }
    observationBatchVerified = true
    if (body.length > 1) {
      route.succeeded(`Committed and verified ${body.length} observations across ${outingIds.length} ${outingIds.length === 1 ? 'outing' : 'outings'}; starting dex recomputation`)
    }

    const observations = body.map(observation => ({
      ...observation,
      representativePhotoId: observation.representativePhotoId || undefined,
      aiConfidence: observation.aiConfidence ?? undefined,
      speciesComments: supportsSpeciesComments ? (observation.speciesComments || undefined) : undefined,
      notes: observation.notes ?? '',
    }))

    const dexUpdates = await computeDex(context.env.DB, userId)
    return route.complete(
      Response.json({ observations, dexUpdates: enrichDexEntries(dexUpdates) }),
      `Persisted ${countLabel(body.length, 'observation')} across ${countLabel(outingIds.length, 'outing')} and recomputed ${countLabel(dexUpdates.length, 'dex entry', 'dex entries')}`,
    )
    } catch {
    const detail = observationBatchVerified
      ? `Committed and verified ${countLabel(body.length, 'observation')}; post-commit dex recomputation failed`
      : observationBatchCommitted
        ? `Committed ${body.length}-record observation batch; post-commit ownership verification failed`
        : `Observation persistence failed before the ${body.length}-record database batch committed`
    return route.fail(500, 'Internal server error', detail)
  }
}

export const onRequestPatch: PagesFunction<Env> = async context => {
  const userId = (context.data as { user?: { id?: string } }).user?.id
  const route = createRouteResponder((context.data as RequestData).log, 'data/observations/write', 'Application')
  if (!userId) {
    return route.fail(401, 'Unauthorized', 'Authentication is required to patch observations')
  }

  let body: unknown
  try {
    body = await context.request.json()
    } catch {
    return route.fail(400, 'Invalid JSON body', 'Request body could not be parsed as JSON; check Content-Type is application/json and body is valid JSON')
  }

  if (!isObject(body)) {
    return route.fail(400, 'Invalid patch payload', 'PATCH payload is not a valid object; expected {id, ...patch} or {ids, patch}')
  }

  let committedBulkPatch: { updatedCount: number; requestedCount: number } | null = null
  try {
    const db = context.env.DB
    const supportsSpeciesComments = await hasObservationColumn(db, 'speciesComments')
    const supportsSpeciesCode = await hasObservationColumn(db, 'speciesCode')

    if (typeof body.id === 'string') {
    const { id, ...rawPatch } = body
    const patch = rawPatch as ObservationPatch
    const { updateFields, bindings } = getPatchBindings(patch, supportsSpeciesCode)

    if (!supportsSpeciesComments) {
      const speciesIndex = updateFields.findIndex(field => field === 'speciesComments = ?')
      if (speciesIndex >= 0) {
        updateFields.splice(speciesIndex, 1)
        bindings.splice(speciesIndex, 1)
      }
    }

    if (updateFields.length === 0) {
      return route.fail(400, 'No valid fields to update', 'PATCH body contains no recognized fields; valid fields are outingId, speciesName, count, certainty, representativePhotoId, aiConfidence, speciesComments, notes')
    }

    if (typeof patch.outingId === 'string') {
      const hasOuting = await hasOwnedOutings(db, userId, [patch.outingId])
      if (!hasOuting) {
        return route.fail(400, 'Invalid outing reference', 'Target outing is not owned by the authenticated account or does not exist')
      }
    }
    if (typeof patch.outingId === 'string' || 'representativePhotoId' in patch) {
      const current = await listObservationsByIds(db, userId, [id])
      const currentObservation = current[0]
      if (!currentObservation) {
        return route.fail(404, 'Not found', 'Observation was not found for the authenticated account')
      }
      const photoId = 'representativePhotoId' in patch
        ? patch.representativePhotoId
        : currentObservation.representativePhotoId
      const outingId = patch.outingId ?? currentObservation.outingId
      if (typeof photoId === 'string' && !await hasOwnedPhotos(db, userId, [{ photoId, outingId }])) {
        return route.fail(400, 'Invalid photo reference', 'Representative photo must belong to the requesting account and outing', { observationId: id })
      }
    }

    const updateResult = await db
      .prepare(`UPDATE observation SET ${updateFields.join(', ')} WHERE id = ? AND userId = ?`)
      .bind(...bindings, id, userId)
      .run()

    if (updateResult.meta.changes === 0) {
      return route.fail(404, 'Not found', 'Observation was not found for the authenticated account')
    }

    const updated = await listObservationsByIds(db, userId, [id])
    const dexUpdates = await computeDex(db, userId)

    return route.complete(
      Response.json({ observation: updated[0], dexUpdates: enrichDexEntries(dexUpdates) }),
      `Patched 1 observation and recomputed ${countLabel(dexUpdates.length, 'dex entry', 'dex entries')}`,
    )
    }

    if (Array.isArray(body.ids) && body.ids.every(id => typeof id === 'string') && isObject(body.patch)) {
    const ids = body.ids as string[]
    const patch = body.patch as ObservationPatch
    const { updateFields, bindings } = getPatchBindings(patch, supportsSpeciesCode)

    if (!supportsSpeciesComments) {
      const speciesIndex = updateFields.findIndex(field => field === 'speciesComments = ?')
      if (speciesIndex >= 0) {
        updateFields.splice(speciesIndex, 1)
        bindings.splice(speciesIndex, 1)
      }
    }

    if (ids.length === 0) {
      return route.fail(400, 'No ids provided', 'Bulk PATCH requires at least one observation ID in the ids array', { count: 0 })
    }
    if (updateFields.length === 0) {
      return route.fail(400, 'No valid fields to update', 'Bulk PATCH body contains no recognized fields; valid fields are outingId, speciesName, count, certainty, representativePhotoId, aiConfidence, speciesComments, notes')
    }

    if (typeof patch.outingId === 'string') {
      const hasOuting = await hasOwnedOutings(db, userId, [patch.outingId])
      if (!hasOuting) {
        return route.fail(400, 'Invalid outing reference', 'Target outing is not owned by the authenticated account or does not exist')
      }
    }
    if (typeof patch.outingId === 'string' || 'representativePhotoId' in patch) {
      const current = await listObservationsByIds(db, userId, ids)
      const photoRefs = current.flatMap(observation => {
        const photoId = 'representativePhotoId' in patch
          ? patch.representativePhotoId
          : observation.representativePhotoId
        return typeof photoId === 'string'
          ? [{ photoId, outingId: patch.outingId ?? observation.outingId }]
          : []
      })
      if (current.length !== ids.length || !await hasOwnedPhotos(db, userId, photoRefs)) {
        return route.fail(400, 'Invalid photo reference', 'Representative photo must belong to the requesting account and every target outing', { count: ids.length })
      }
    }

    const statements = ids.map(id =>
      db
        .prepare(`UPDATE observation SET ${updateFields.join(', ')} WHERE id = ? AND userId = ?`)
        .bind(...bindings, id, userId)
    )

    const updateResults = await db.batch(statements)
    const updatedCount = updateResults.reduce((sum, result) => sum + (result.meta?.changes || 0), 0)

    if (updatedCount === 0) {
      return route.fail(404, 'Not found', `No observations were patched from ${countLabel(ids.length, 'requested record')}`)
    }

    if (ids.length > 1) {
      committedBulkPatch = { updatedCount, requestedCount: ids.length }
      route.succeeded(`Committed bulk observation patch for ${updatedCount} of ${countLabel(ids.length, 'requested record')}; starting result verification and dex recomputation`)
    }
    const observations = await listObservationsByIds(db, userId, ids)
    const dexUpdates = await computeDex(db, userId)

    return route.complete(
      Response.json({ observations, dexUpdates: enrichDexEntries(dexUpdates) }),
      `Patched ${countLabel(updatedCount, 'observation')} and recomputed ${countLabel(dexUpdates.length, 'dex entry', 'dex entries')}`,
    )
    }

    return route.fail(400, 'Invalid patch payload', 'PATCH payload does not match single-id or bulk-ids shape')
    } catch {
      const detail = committedBulkPatch
        ? `Committed bulk observation patch for ${committedBulkPatch.updatedCount} of ${countLabel(committedBulkPatch.requestedCount, 'requested record')}; result verification or dex recomputation failed`
        : 'Observation patch failed before a multi-record update was known to have committed'
      return route.fail(500, 'Internal server error', detail)
  }
}
