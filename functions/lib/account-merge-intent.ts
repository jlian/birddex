export type AccountMergeAuthMethod = 'github' | 'google' | 'apple' | 'passkey'

export interface AccountMergeIntent {
  tokenHash: string
  sourceUserId: string
  sourceSessionId: string
  authMethod: AccountMergeAuthMethod
  status: 'pending' | 'merging' | 'completed' | 'failed'
  targetUserId: string | null
  outingCount: number
  observationCount: number
  photoCount: number
  expiresAt: string
  completedAt: string | null
}

export function randomAccountMergeToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

export async function accountMergeTokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function createAccountMergeIntent(
  db: D1Database,
  sourceSessionId: string,
  authMethod: AccountMergeAuthMethod,
): Promise<string> {
  const token = randomAccountMergeToken()
  const tokenHash = await accountMergeTokenHash(token)
  const results = await db.batch([
    db.prepare(`
      DELETE FROM account_merge_intent
      WHERE sourceSessionId = ? AND status = 'pending' AND targetUserId IS NULL
    `).bind(sourceSessionId),
    db.prepare(`
      INSERT INTO account_merge_intent (
        tokenHash, sourceUserId, sourceSessionId, authMethod, expiresAt
      )
      SELECT ?, session.userId, session.id, ?, datetime('now', '+5 minutes')
      FROM session
      JOIN user ON user.id = session.userId
      WHERE session.id = ?
        AND session.expiresAt > datetime('now')
        AND user.isAnonymous = 1
    `).bind(tokenHash, authMethod, sourceSessionId),
    db.prepare(`
      DELETE FROM account_merge_intent
      WHERE status IN ('pending', 'failed')
        AND targetUserId IS NULL
        AND expiresAt <= datetime('now', '-1 day')
    `),
  ])
  if ((results[1]?.meta.changes ?? 0) !== 1) {
    throw new Error('Account merge requires a current anonymous session')
  }
  return token
}

export async function getAccountMergeIntent(
  db: D1Database,
  token: string,
): Promise<AccountMergeIntent | null> {
  if (token.length < 32 || token.length > 256) return null
  return db.prepare(`
    SELECT tokenHash, sourceUserId, sourceSessionId, authMethod, status,
           targetUserId, outingCount, observationCount, photoCount,
           expiresAt, completedAt
    FROM account_merge_intent
    WHERE tokenHash = ?
  `).bind(await accountMergeTokenHash(token)).first<AccountMergeIntent>()
}

export async function findPendingAccountMergeIntent(
  db: D1Database,
  sourceUserId: string,
  sourceSessionId: string,
): Promise<AccountMergeIntent | null> {
  return db.prepare(`
    SELECT tokenHash, sourceUserId, sourceSessionId, authMethod, status,
           targetUserId, outingCount, observationCount, photoCount,
           expiresAt, completedAt
    FROM account_merge_intent
    WHERE sourceUserId = ?
      AND sourceSessionId = ?
      AND status = 'pending'
      AND expiresAt > datetime('now')
    LIMIT 1
  `).bind(sourceUserId, sourceSessionId).first<AccountMergeIntent>()
}

export async function accountMergeSourceBearer(
  db: D1Database,
  token: string,
  authMethod: AccountMergeAuthMethod,
): Promise<string | null> {
  if (token.length < 32 || token.length > 256) return null
  const row = await db.prepare(`
    SELECT session.token
    FROM account_merge_intent AS intent
    JOIN session ON session.id = intent.sourceSessionId
      AND session.userId = intent.sourceUserId
    JOIN user ON user.id = intent.sourceUserId
    WHERE intent.tokenHash = ?
      AND intent.authMethod = ?
      AND intent.status = 'pending'
      AND intent.expiresAt > datetime('now')
      AND session.expiresAt > datetime('now')
      AND user.isAnonymous = 1
  `).bind(await accountMergeTokenHash(token), authMethod).first<{ token: string }>()
  return row?.token ?? null
}