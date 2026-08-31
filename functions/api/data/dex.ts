import { computeDex, enrichDexEntries } from '../../lib/dex-query'
import { createRouteResponder } from '../../lib/log'
import { hasDexMetaColumn } from '../../lib/schema'
import { resolveSpeciesCode } from '../../lib/taxonomy'

type DexMetaPatch = {
  speciesName: string
  addedDate?: string | null
  bestPhotoId?: string | null
  notes?: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function isDexMetaPatch(value: unknown): value is DexMetaPatch {
  if (!isObject(value)) return false
  return typeof value.speciesName === 'string'
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

async function upsertDexMetaPatch(db: D1Database, userId: string, patch: DexMetaPatch) {
  // Resolve the grouping key alongside the name. dex_meta is still
  // PRIMARY KEY (userId, speciesName), so the row identity does not change, but
  // storing the code lets DEX_QUERY match this metadata to a coded observation
  // directly instead of going through the name-resolution fallback.
  const speciesCode = resolveSpeciesCode(patch.speciesName) || null

  const existingResult = await db
    .prepare('SELECT addedDate, bestPhotoId, notes FROM dex_meta WHERE userId = ? AND speciesName = ? LIMIT 1')
    .bind(userId, patch.speciesName)
    .all<{ addedDate?: string | null; bestPhotoId?: string | null; notes?: string | null }>()

  const existing = existingResult.results[0]

  const nextAddedDate = 'addedDate' in patch ? patch.addedDate ?? null : (existing?.addedDate ?? null)
  const nextBestPhotoId = 'bestPhotoId' in patch ? patch.bestPhotoId ?? null : (existing?.bestPhotoId ?? null)
  const nextNotes = typeof patch.notes === 'string' ? patch.notes : (existing?.notes ?? '')

  const supportsSpeciesCode = await hasDexMetaColumn(db, 'speciesCode')

  if (supportsSpeciesCode) {
    await db
      .prepare(
        `INSERT INTO dex_meta (userId, speciesName, speciesCode, addedDate, bestPhotoId, notes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(userId, speciesName)
         DO UPDATE SET
           speciesCode = excluded.speciesCode,
           addedDate = excluded.addedDate,
           bestPhotoId = excluded.bestPhotoId,
           notes = excluded.notes`
      )
      .bind(userId, patch.speciesName, speciesCode, nextAddedDate, nextBestPhotoId, nextNotes)
      .run()
    return
  }

  await db
    .prepare(
      `INSERT INTO dex_meta (userId, speciesName, addedDate, bestPhotoId, notes)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(userId, speciesName)
       DO UPDATE SET
         addedDate = excluded.addedDate,
         bestPhotoId = excluded.bestPhotoId,
         notes = excluded.notes`
    )
    .bind(userId, patch.speciesName, nextAddedDate, nextBestPhotoId, nextNotes)
    .run()
}

export const onRequestGet: PagesFunction<Env> = async context => {
  const userId = (context.data as { user?: { id?: string } }).user?.id
  const route = createRouteResponder((context.data as RequestData).log?.withResourceId('dex'), 'data/dex/read', 'Application')
  if (!userId) {
    return route.fail(401, 'Unauthorized', 'Authentication is required to read the dex')
  }

  try {
    const dex = await computeDex(context.env.DB, userId)
    return route.complete(Response.json(enrichDexEntries(dex)), `Computed dex with ${dex.length} species`)
  } catch {
    return route.fail(500, 'Internal server error', 'Dex read failed during database query or result computation')
  }
}

export const onRequestPatch: PagesFunction<Env> = async context => {
  const userId = (context.data as { user?: { id?: string } }).user?.id
  const route = createRouteResponder((context.data as RequestData).log?.withResourceId('dex'), 'data/dex/write', 'Application')
  if (!userId) {
    return route.fail(401, 'Unauthorized', 'Authentication is required to patch dex metadata')
  }

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return route.fail(400, 'Invalid JSON body', 'Request body could not be parsed as JSON; check Content-Type is application/json and body is valid JSON')
  }

  const patches = Array.isArray(body) ? body : [body]
  if (!patches.every(isDexMetaPatch)) {
    return route.fail(400, 'Invalid dex patch payload', 'Dex patch payload failed validation; expected {speciesName} with optional addedDate, bestPhotoId, notes')
  }

  let appliedPatchCount = 0
  try {
    for (const patch of patches) {
      await upsertDexMetaPatch(context.env.DB, userId, patch)
      appliedPatchCount += 1
    }
    if (patches.length > 1) {
      route.succeeded(`Applied ${appliedPatchCount} of ${countLabel(patches.length, 'dex metadata patch', 'dex metadata patches')}; starting dex recomputation`)
    }
    const dexUpdates = await computeDex(context.env.DB, userId)
    return route.complete(Response.json({
      dexUpdates: enrichDexEntries(dexUpdates),
    }), `Applied ${countLabel(patches.length, 'dex metadata patch', 'dex metadata patches')} and recomputed ${countLabel(dexUpdates.length, 'dex entry', 'dex entries')}`)
  } catch {
    if (patches.length > 1 && appliedPatchCount > 0 && appliedPatchCount < patches.length) {
      route.failed(`Applied ${appliedPatchCount} of ${countLabel(patches.length, 'dex metadata patch', 'dex metadata patches')} before a later database write failed`)
    }
    const detail = appliedPatchCount > 0
      ? `Applied ${appliedPatchCount} of ${countLabel(patches.length, 'dex metadata patch', 'dex metadata patches')}; a later database write or dex recomputation failed`
      : 'Dex metadata patch failed before any requested patch was applied'
    return route.fail(500, 'Internal server error', detail)
  }
}
