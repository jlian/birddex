import { computeDex, enrichDexEntries } from '../../lib/dex-query'
import { createRouteResponder } from '../../lib/log'
import { hasDexMetaColumn } from '../../lib/schema'

type DexMetaPatch = {
  groupKey?: string
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
    && (value.groupKey === undefined || (
      typeof value.groupKey === 'string'
      && (/^code:.+/.test(value.groupKey) || value.groupKey === `name:${value.speciesName}`)
    ))
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

async function upsertDexMetaPatch(db: D1Database, userId: string, patch: DexMetaPatch) {
  const resolvedCode = patch.groupKey
    ? null
    : (await import('../../lib/species-code-resolve')).resolveSpeciesCode(patch.speciesName) || null
  const groupKey = patch.groupKey ?? (resolvedCode ? `code:${resolvedCode}` : `name:${patch.speciesName}`)
  const speciesCode = groupKey.startsWith('code:') ? groupKey.slice(5) : null
  const supportsSpeciesCode = await hasDexMetaColumn(db, 'speciesCode')
  const supportsGroupKey = await hasDexMetaColumn(db, 'groupKey')

  const existingResult = await db
    .prepare(supportsGroupKey
      ? 'SELECT addedDate, bestPhotoId, notes FROM dex_meta WHERE userId = ? AND groupKey = ? LIMIT 1'
      : 'SELECT addedDate, bestPhotoId, notes FROM dex_meta WHERE userId = ? AND speciesName = ? LIMIT 1')
    .bind(userId, supportsGroupKey ? groupKey : patch.speciesName)
    .all<{ addedDate?: string | null; bestPhotoId?: string | null; notes?: string | null }>()

  const existing = existingResult.results[0]

  const nextAddedDate = 'addedDate' in patch ? patch.addedDate ?? null : (existing?.addedDate ?? null)
  const nextBestPhotoId = 'bestPhotoId' in patch ? patch.bestPhotoId ?? null : (existing?.bestPhotoId ?? null)
  const nextNotes = typeof patch.notes === 'string' ? patch.notes : (existing?.notes ?? '')

  if (!supportsGroupKey) {
    await db
      .prepare(
        `INSERT INTO dex_meta (userId, speciesName, addedDate, bestPhotoId, notes)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(userId, speciesName)
         DO UPDATE SET addedDate = excluded.addedDate, bestPhotoId = excluded.bestPhotoId, notes = excluded.notes`
      )
      .bind(userId, patch.speciesName, nextAddedDate, nextBestPhotoId, nextNotes)
      .run()
    return
  }

  if (supportsSpeciesCode) {
    await db
      .prepare(
        `INSERT INTO dex_meta (userId, groupKey, speciesName, speciesCode, addedDate, bestPhotoId, notes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(userId, groupKey)
         DO UPDATE SET
           speciesName = excluded.speciesName,
           speciesCode = excluded.speciesCode,
           addedDate = excluded.addedDate,
           bestPhotoId = excluded.bestPhotoId,
           notes = excluded.notes`
      )
      .bind(userId, groupKey, patch.speciesName, speciesCode, nextAddedDate, nextBestPhotoId, nextNotes)
      .run()
    return
  }

  throw new Error('groupKey exists without speciesCode')
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
    return route.fail(400, 'Invalid dex patch payload', 'Dex patch payload failed validation; expected {speciesName} with optional groupKey, addedDate, bestPhotoId, notes')
  }

  let appliedPatchCount = 0
  try {
    const currentDex = patches.some(patch => patch.groupKey)
      ? await computeDex(context.env.DB, userId)
      : []
    const entriesByKey = new Map(currentDex.map(entry => [entry.id, entry]))
    for (const patch of patches) {
      if (!patch.groupKey) continue
      const entry = entriesByKey.get(patch.groupKey)
      if (!entry || entry.speciesName !== patch.speciesName) {
        return route.fail(400, 'Invalid dex grouping key', 'groupKey and speciesName must identify an existing dex entry')
      }
    }
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
