import { accountMergeTokenHash, type AccountMergeIntent } from './account-merge-intent'

export const accountMergeTablePolicies = {
  session: 'delete-source',
  account: 'reject-source-credentials',
  passkey: 'reject-source-credentials',
  outing: 'move',
  photo: 'move',
  observation: 'move',
  dex_meta: 'fold',
  ai_daily_usage: 'fold',
  importIdentity: 'fold',
} as const

export interface AccountMergeResult {
  status: 'completed'
  sourceUserId: string
  targetUserId: string
  promoted: boolean
  outings: number
  observations: number
  photos: number
}

export function accountMergeFinalizationEnabled(env: Env): boolean {
  return env.ACCOUNT_MERGE_ENABLED !== 'false'
}

interface MergePreflight extends AccountMergeIntent {
  sourceIsAnonymous: number
  targetIsAnonymous: number
  sourceAccountCount: number
  sourcePasskeyCount: number
}

function completedResult(intent: AccountMergeIntent): AccountMergeResult {
  if (!intent.targetUserId) throw new Error('Completed account merge has no target')
  return {
    status: 'completed',
    sourceUserId: intent.sourceUserId,
    targetUserId: intent.targetUserId,
    promoted: intent.sourceUserId === intent.targetUserId,
    outings: intent.outingCount,
    observations: intent.observationCount,
    photos: intent.photoCount,
  }
}

async function intentByHash(db: D1Database, tokenHash: string): Promise<AccountMergeIntent | null> {
  return db.prepare(`
    SELECT tokenHash, sourceUserId, sourceSessionId, authMethod, status,
           targetUserId, outingCount, observationCount, photoCount,
           expiresAt, completedAt
    FROM account_merge_intent
    WHERE tokenHash = ?
  `).bind(tokenHash).first<AccountMergeIntent>()
}

async function mergePreflight(
  db: D1Database,
  tokenHash: string,
  targetUserId: string,
): Promise<MergePreflight> {
  const row = await db.prepare(`
    SELECT intent.tokenHash, intent.sourceUserId, intent.sourceSessionId,
           intent.authMethod, intent.status, intent.targetUserId,
           intent.outingCount, intent.observationCount, intent.photoCount,
           intent.expiresAt, intent.completedAt,
           source.isAnonymous AS sourceIsAnonymous,
           target.isAnonymous AS targetIsAnonymous,
           (SELECT count(*) FROM account WHERE userId = source.id) AS sourceAccountCount,
           (SELECT count(*) FROM passkey WHERE userId = source.id) AS sourcePasskeyCount
    FROM account_merge_intent AS intent
    JOIN user AS source ON source.id = intent.sourceUserId
    JOIN user AS target ON target.id = ?
    WHERE intent.tokenHash = ?
      AND intent.status = 'pending'
        AND intent.targetUserId = ?
      AND (intent.expiresAt > datetime('now') OR intent.targetUserId = ?)
  `).bind(targetUserId, tokenHash, targetUserId, targetUserId).first<MergePreflight>()
  if (!row) throw new Error('Account merge intent is unavailable or expired')
  if (row.sourceUserId !== targetUserId && row.sourceIsAnonymous !== 1) {
    throw new Error('Account merge source is not anonymous')
  }
  if (row.targetIsAnonymous === 1 && row.sourceUserId !== targetUserId) {
    throw new Error('Account merge target must be registered')
  }
  if (row.sourceUserId !== targetUserId && (row.sourceAccountCount > 0 || row.sourcePasskeyCount > 0)) {
    throw new Error('Anonymous account unexpectedly owns credentials')
  }
  return row
}

async function claimAccountMergeTarget(
  db: D1Database,
  tokenHash: string,
  targetUserId: string,
  allowExpiredBinding = false,
): Promise<void> {
  const result = await db.prepare(`
    UPDATE account_merge_intent
    SET targetUserId = ?, updatedAt = datetime('now')
    WHERE tokenHash = ?
      AND status = 'pending'
      AND (? = 1 OR expiresAt > datetime('now') OR targetUserId = ? OR sourceUserId = ?)
      AND (targetUserId IS NULL OR targetUserId = ?)
  `).bind(
    targetUserId,
    tokenHash,
    allowExpiredBinding ? 1 : 0,
    targetUserId,
    targetUserId,
    targetUserId,
  ).run()
  if ((result.meta.changes ?? 0) === 1) return
  const existing = await intentByHash(db, tokenHash)
  if (existing?.status === 'completed' && existing.targetUserId === targetUserId) return
  if (existing?.targetUserId && existing.targetUserId !== targetUserId) {
    throw new Error('Account merge intent is already bound to another target')
  }
  throw new Error('Account merge target could not be claimed')
}

async function ownedRowCounts(db: D1Database, sourceUserId: string) {
  const row = await db.prepare(`
    SELECT
      (SELECT count(*) FROM outing WHERE userId = ?) AS outings,
      (SELECT count(*) FROM observation WHERE userId = ?) AS observations,
      (SELECT count(*) FROM photo WHERE userId = ?) AS photos
  `).bind(sourceUserId, sourceUserId, sourceUserId).first<{
    outings: number
    observations: number
    photos: number
  }>()
  if (!row) throw new Error('Could not count account merge rows')
  return row
}

async function exactDuplicateObservationCount(
  db: D1Database,
  sourceUserId: string,
  targetUserId: string,
): Promise<number> {
  const row = await db.prepare(`
    SELECT count(*) AS count
    FROM observation AS source
    WHERE source.userId = ?
      AND source.submissionId IS NOT NULL
      AND trim(source.submissionId) <> ''
      AND EXISTS (
        SELECT 1 FROM observation AS target
        WHERE target.userId = ?
          AND trim(target.submissionId) = trim(source.submissionId)
          AND lower(trim(target.speciesName)) = lower(trim(source.speciesName))
          AND target.count = source.count
          AND target.certainty = source.certainty
          AND target.representativePhotoId IS source.representativePhotoId
          AND target.aiConfidence IS source.aiConfidence
          AND target.speciesComments IS source.speciesComments
          AND target.notes = source.notes
      )
  `).bind(sourceUserId, targetUserId).first<{ count: number }>()
  return row?.count ?? 0
}

function guardSql(): string {
  return `EXISTS (
    SELECT 1 FROM account_merge_intent
    WHERE tokenHash = ? AND status = 'merging' AND targetUserId = ?
  )`
}

async function promoteSameUser(
  db: D1Database,
  intent: MergePreflight,
  targetUserId: string,
): Promise<AccountMergeResult> {
  const statements = [
    db.prepare(`
      UPDATE account_merge_intent
      SET status = 'merging', updatedAt = datetime('now')
      WHERE tokenHash = ? AND status = 'pending' AND targetUserId = ?
    `).bind(intent.tokenHash, targetUserId),
    db.prepare(`
      UPDATE user SET isAnonymous = 0, updatedAt = datetime('now')
      WHERE id = ? AND ${guardSql()}
    `).bind(targetUserId, intent.tokenHash, targetUserId),
    db.prepare(`
      UPDATE account_merge_intent
      SET status = 'completed', completedAt = datetime('now'), updatedAt = datetime('now')
      WHERE tokenHash = ? AND status = 'merging' AND targetUserId = ?
    `).bind(intent.tokenHash, targetUserId),
  ]
  const results = await db.batch(statements)
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    const existing = await intentByHash(db, intent.tokenHash)
    if (existing?.status === 'completed') return completedResult(existing)
    throw new Error('Account promotion was claimed by another finalizer')
  }
  const completed = await intentByHash(db, intent.tokenHash)
  if (completed?.status !== 'completed') throw new Error('Account promotion did not complete')
  return completedResult(completed)
}

async function mergeDifferentUsers(
  db: D1Database,
  intent: MergePreflight,
  targetUserId: string,
): Promise<AccountMergeResult> {
  const counts = await ownedRowCounts(db, intent.sourceUserId)
  const duplicateObservations = await exactDuplicateObservationCount(
    db,
    intent.sourceUserId,
    targetUserId,
  )
  const statements = [
    db.prepare(`
      UPDATE account_merge_intent
      SET status = 'merging', updatedAt = datetime('now')
      WHERE tokenHash = ? AND status = 'pending' AND targetUserId = ?
    `).bind(intent.tokenHash, targetUserId),
    db.prepare(`
      UPDATE account_merge_intent
      SET completionGuard = CASE WHEN
        EXISTS (SELECT 1 FROM user WHERE id = ? AND isAnonymous = 1)
        AND NOT EXISTS (SELECT 1 FROM account WHERE userId = ?)
        AND NOT EXISTS (SELECT 1 FROM passkey WHERE userId = ?)
        THEN 1 ELSE 0 END
      WHERE tokenHash = ? AND status = 'merging' AND targetUserId = ?
    `).bind(
      intent.sourceUserId,
      intent.sourceUserId,
      intent.sourceUserId,
      intent.tokenHash,
      targetUserId,
    ),
    db.prepare(`
      DELETE FROM observation AS source
      WHERE source.userId = ?
        AND source.submissionId IS NOT NULL
        AND trim(source.submissionId) <> ''
        AND ${guardSql()}
        AND EXISTS (
          SELECT 1 FROM observation AS target
          WHERE target.userId = ?
            AND trim(target.submissionId) = trim(source.submissionId)
            AND lower(trim(target.speciesName)) = lower(trim(source.speciesName))
            AND target.count = source.count
            AND target.certainty = source.certainty
            AND target.representativePhotoId IS source.representativePhotoId
            AND target.aiConfidence IS source.aiConfidence
            AND target.speciesComments IS source.speciesComments
            AND target.notes = source.notes
        )
    `).bind(intent.sourceUserId, intent.tokenHash, targetUserId, targetUserId),
    db.prepare(`
      INSERT INTO dex_meta (userId, speciesName, speciesCode, addedDate, bestPhotoId, notes)
      SELECT ?, speciesName, speciesCode, addedDate, bestPhotoId, notes
      FROM dex_meta
      WHERE userId = ? AND ${guardSql()}
      ON CONFLICT(userId, speciesName) DO UPDATE SET
        -- Carry the grouping key across the merge. Observations keep theirs
        -- because they are re-owned by UPDATE, but this copies rows, so
        -- omitting the column would silently name-key every merged metadata
        -- row and orphan it from its coded dex entry.
        speciesCode = coalesce(dex_meta.speciesCode, excluded.speciesCode),
        addedDate = CASE
          WHEN dex_meta.addedDate IS NULL THEN excluded.addedDate
          WHEN excluded.addedDate IS NULL THEN dex_meta.addedDate
          ELSE min(dex_meta.addedDate, excluded.addedDate)
        END,
        bestPhotoId = coalesce(dex_meta.bestPhotoId, excluded.bestPhotoId),
        notes = CASE
          WHEN trim(excluded.notes) = '' OR excluded.notes = dex_meta.notes THEN dex_meta.notes
          WHEN trim(dex_meta.notes) = '' THEN excluded.notes
          ELSE dex_meta.notes || char(10) || char(10) || excluded.notes
        END
    `).bind(targetUserId, intent.sourceUserId, intent.tokenHash, targetUserId),
    db.prepare(`DELETE FROM dex_meta WHERE userId = ? AND ${guardSql()}`)
      .bind(intent.sourceUserId, intent.tokenHash, targetUserId),
    db.prepare(`
      INSERT INTO importIdentity (userId, source, sourceKey, rowCount, createdAt)
      SELECT ?, source, sourceKey, rowCount, createdAt
      FROM importIdentity
      WHERE userId = ? AND ${guardSql()}
      ON CONFLICT(userId, source, sourceKey) DO UPDATE SET
        rowCount = max(importIdentity.rowCount, excluded.rowCount),
        createdAt = min(importIdentity.createdAt, excluded.createdAt)
    `).bind(targetUserId, intent.sourceUserId, intent.tokenHash, targetUserId),
    db.prepare(`DELETE FROM importIdentity WHERE userId = ? AND ${guardSql()}`)
      .bind(intent.sourceUserId, intent.tokenHash, targetUserId),
    db.prepare(`
      INSERT INTO ai_daily_usage (userId, endpoint, usageDate, requestCount, createdAt, updatedAt)
      SELECT ?, endpoint, usageDate, requestCount, createdAt, updatedAt
      FROM ai_daily_usage
      WHERE userId = ? AND ${guardSql()}
      ON CONFLICT(userId, endpoint, usageDate) DO UPDATE SET
        requestCount = ai_daily_usage.requestCount + excluded.requestCount,
        createdAt = min(ai_daily_usage.createdAt, excluded.createdAt),
        updatedAt = max(ai_daily_usage.updatedAt, excluded.updatedAt)
    `).bind(targetUserId, intent.sourceUserId, intent.tokenHash, targetUserId),
    db.prepare(`DELETE FROM ai_daily_usage WHERE userId = ? AND ${guardSql()}`)
      .bind(intent.sourceUserId, intent.tokenHash, targetUserId),
    db.prepare(`UPDATE outing SET userId = ? WHERE userId = ? AND ${guardSql()}`)
      .bind(targetUserId, intent.sourceUserId, intent.tokenHash, targetUserId),
    db.prepare(`UPDATE photo SET userId = ? WHERE userId = ? AND ${guardSql()}`)
      .bind(targetUserId, intent.sourceUserId, intent.tokenHash, targetUserId),
    db.prepare(`UPDATE observation SET userId = ? WHERE userId = ? AND ${guardSql()}`)
      .bind(targetUserId, intent.sourceUserId, intent.tokenHash, targetUserId),
    db.prepare(`DELETE FROM session WHERE userId = ? AND ${guardSql()}`)
      .bind(intent.sourceUserId, intent.tokenHash, targetUserId),
    db.prepare(`DELETE FROM user WHERE id = ? AND isAnonymous = 1 AND ${guardSql()}`)
      .bind(intent.sourceUserId, intent.tokenHash, targetUserId),
    db.prepare(`
      UPDATE account_merge_intent
      SET completionGuard = CASE WHEN
        NOT EXISTS (SELECT 1 FROM user WHERE id = ?)
        THEN 1 ELSE 0 END
      WHERE tokenHash = ? AND status = 'merging' AND targetUserId = ?
    `).bind(intent.sourceUserId, intent.tokenHash, targetUserId),
    db.prepare(`
      UPDATE account_merge_intent
      SET status = 'completed', outingCount = ?, observationCount = ?, photoCount = ?,
          completedAt = datetime('now'), updatedAt = datetime('now')
      WHERE tokenHash = ? AND status = 'merging' AND targetUserId = ?
    `).bind(
      counts.outings,
      counts.observations - duplicateObservations,
      counts.photos,
      intent.tokenHash,
      targetUserId,
    ),
  ]
  const results = await db.batch(statements)
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    const existing = await intentByHash(db, intent.tokenHash)
    if (existing?.status === 'completed') return completedResult(existing)
    throw new Error('Account merge was claimed by another finalizer')
  }
  const completed = await intentByHash(db, intent.tokenHash)
  if (completed?.status !== 'completed') throw new Error('Account merge did not complete')
  return completedResult(completed)
}

async function finalizeAccountMergeHash(
  db: D1Database,
  tokenHash: string,
  targetUserId: string,
  allowExpiredBinding = false,
): Promise<AccountMergeResult> {
  const existing = await intentByHash(db, tokenHash)
  if (!existing) throw new Error('Account merge intent was not found')
  if (existing.status === 'completed') {
    if (existing.targetUserId !== targetUserId) throw new Error('Account merge target does not match')
    return completedResult(existing)
  }
  await claimAccountMergeTarget(db, tokenHash, targetUserId, allowExpiredBinding)
  const preflight = await mergePreflight(db, tokenHash, targetUserId)
  return preflight.sourceUserId === targetUserId
    ? promoteSameUser(db, preflight, targetUserId)
    : mergeDifferentUsers(db, preflight, targetUserId)
}

export async function finalizeAccountMerge(
  db: D1Database,
  token: string,
  targetUserId: string,
): Promise<AccountMergeResult> {
  if (token.length < 32 || token.length > 256) throw new Error('Invalid account merge token')
  return finalizeAccountMergeHash(db, await accountMergeTokenHash(token), targetUserId)
}

export async function finalizePendingAccountMerge(
  db: D1Database,
  sourceUserId: string,
  sourceSessionId: string,
  authMethod: 'github' | 'google' | 'apple' | 'passkey',
  targetUserId: string,
): Promise<AccountMergeResult | null> {
  const pending = await db.prepare(`
    SELECT tokenHash FROM account_merge_intent
    WHERE sourceUserId = ? AND sourceSessionId = ? AND authMethod = ?
      AND status = 'pending'
      AND expiresAt > datetime('now', '-1 day')
    LIMIT 1
  `).bind(sourceUserId, sourceSessionId, authMethod).first<{ tokenHash: string }>()
  if (!pending) return null
  return finalizeAccountMergeHash(db, pending.tokenHash, targetUserId, true)
}

export async function finalizeBoundAccountMerges(
  db: D1Database,
  targetUserId: string,
): Promise<AccountMergeResult[]> {
  const pending = await db.prepare(`
    SELECT tokenHash FROM account_merge_intent
    WHERE targetUserId = ? AND status = 'pending'
    ORDER BY createdAt
  `).bind(targetUserId).all<{ tokenHash: string }>()
  const results: AccountMergeResult[] = []
  for (const row of pending.results ?? []) {
    results.push(await finalizeAccountMergeHash(db, row.tokenHash, targetUserId))
  }
  return results
}