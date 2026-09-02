import { createRouteResponder } from '../../lib/log'
import { queryInChunks } from '../../lib/d1-chunk'

type CreatePhotoInput = {
  id: string
  outingId: string
  dataUrl?: string
  thumbnail?: string
  exifTime?: string
  gps?: { lat: number; lon: number }
  fileHash: string
  fileName: string
}

function isCreatePhotoInput(value: unknown): value is CreatePhotoInput {
  if (!value || typeof value !== 'object') return false
  const data = value as Record<string, unknown>

  return (
    typeof data.id === 'string' &&
    typeof data.outingId === 'string' &&
    (data.dataUrl === undefined || typeof data.dataUrl === 'string') &&
    (data.thumbnail === undefined || typeof data.thumbnail === 'string') &&
    typeof data.fileHash === 'string' &&
    typeof data.fileName === 'string'
  )
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

async function hasCompatiblePhotoIds(
  db: D1Database,
  userId: string,
  photos: CreatePhotoInput[],
  requireAll = false,
): Promise<boolean> {
  const ids = [...new Set(photos.map(photo => photo.id))]
  if (ids.length === 0) return true
  const expectedOutings = new Map(photos.map(photo => [photo.id, photo.outingId]))
  const existing = await queryInChunks(ids, async (chunk, placeholders) => {
    const result = await db
      .prepare(`SELECT id, userId, outingId FROM photo WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all<{ id: string; userId: string; outingId: string }>()
    return result.results
  })
  return (!requireAll || existing.length === ids.length) &&
    existing.every(photo => photo.userId === userId && photo.outingId === expectedOutings.get(photo.id))
}

function hasConflictingPhotoIds(photos: CreatePhotoInput[]): boolean {
  const outingsById = new Map<string, string>()
  for (const photo of photos) {
    const existing = outingsById.get(photo.id)
    if (existing && existing !== photo.outingId) return true
    outingsById.set(photo.id, photo.outingId)
  }
  return outingsById.size !== photos.length
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

export const onRequestPost: ApiHandler = async context => {
  const userId = (context.data as { user?: { id?: string } }).user?.id
  const route = createRouteResponder((context.data as RequestData).log, 'data/photos/write', 'Application')
  if (!userId) {
    return route.fail(401, 'Unauthorized', 'Authentication is required to persist photos')
  }

  let body: unknown
  try {
    body = await context.request.json()
    } catch {
    return route.fail(400, 'Invalid JSON body', 'Request body could not be parsed as JSON; check Content-Type is application/json and body is valid JSON')
  }

  if (!Array.isArray(body) || !body.every(isCreatePhotoInput)) {
    return route.fail(400, 'Invalid photos payload', 'Photos payload failed validation; expected an array of photo records with required identifiers and file metadata')
  }

  if (body.length === 0) {
    return route.complete(Response.json([]), 'No photos submitted for persistence')
  }
  if (hasConflictingPhotoIds(body)) {
    return route.fail(400, 'Duplicate photo IDs', 'Photo payload must contain unique IDs')
  }

  let stage = 'outing ownership validation'
  try {
    const allOwned = await hasOwnedOutings(
      context.env.DB,
      userId,
      body.map(photo => photo.outingId)
    )
    if (!allOwned) {
      return route.fail(400, 'Invalid outing reference', 'One or more referenced outings are not owned by the authenticated account or do not exist')
    }

    stage = 'existing photo ID compatibility check'
    if (!await hasCompatiblePhotoIds(context.env.DB, userId, body)) {
      return route.fail(409, 'Photo ID conflict', 'One or more photo IDs already belong to another account or outing')
    }

    const statements = body.map(photo =>
    context.env.DB.prepare(
      `INSERT INTO photo (id, outingId, userId, dataUrl, thumbnail, exifTime, gpsLat, gpsLon, fileHash, fileName)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT(id) DO UPDATE SET
         exifTime = excluded.exifTime,
         gpsLat = excluded.gpsLat,
         gpsLon = excluded.gpsLon,
         fileHash = excluded.fileHash,
         fileName = excluded.fileName
       WHERE photo.userId = excluded.userId AND photo.outingId = excluded.outingId`
    ).bind(
      photo.id,
      photo.outingId,
      userId,
      '',
      '',
      photo.exifTime ?? null,
      photo.gps?.lat ?? null,
      photo.gps?.lon ?? null,
      photo.fileHash,
      photo.fileName
    )
    )

    stage = 'photo database batch write'
    await context.env.DB.batch(statements)

    stage = 'post-write photo ID compatibility verification'
    if (!await hasCompatiblePhotoIds(context.env.DB, userId, body, true)) {
      return route.fail(409, 'Photo ID conflict', 'Photo batch was written, but post-write ownership verification found an ID conflict')
    }
    const outingIds = [...new Set(body.map(p => p.outingId))]

    return route.complete(Response.json(
      body.map(photo => ({
        ...photo,
        dataUrl: '',
        thumbnail: '',
        exifTime: photo.exifTime || undefined,
        gps: photo.gps ? { lat: photo.gps.lat, lon: photo.gps.lon } : undefined,
      }))
    ), `Persisted ${countLabel(body.length, 'photo')} across ${countLabel(outingIds.length, 'outing')}`)
  } catch {
    return route.fail(500, 'Internal server error', `Photo persistence failed during ${stage} for ${countLabel(body.length, 'record')}`)
  }
}
