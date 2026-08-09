export interface ProviderAccount {
  providerId: string
  accessToken?: string | null
  refreshToken?: string | null
  nativeAccessToken?: string | null
  nativeRefreshToken?: string | null
}

type ProviderEnv = Pick<Env,
  | 'APPLE_APP_CLIENT_SECRET'
  | 'APPLE_CLIENT_ID'
  | 'APPLE_CLIENT_SECRET'
  | 'GITHUB_CLIENT_ID'
  | 'GITHUB_CLIENT_SECRET'
  | 'GOOGLE_CLIENT_ID'
  | 'GOOGLE_CLIENT_SECRET'
>

type Fetcher = typeof fetch

export type ProviderRevocationOutcome = 'revoked' | 'manual_action_required' | 'skipped' | 'failed'

export interface ProviderRevocationResult {
  providerId: string
  outcome: ProviderRevocationOutcome
}

export interface AccountDeletionResult {
  revokedProviderCount: number
  manualAppleRevocationRequired: boolean
}

export type ProviderRevocationObserver = (
  phase: 'started' | 'completed',
  result: ProviderRevocationResult,
) => void

export class ProviderRevocationError extends Error {
  constructor(
    readonly providerId: string,
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

function requiredToken(account: ProviderAccount): string {
  const token = account.refreshToken || account.accessToken
  if (!token) {
    throw new ProviderRevocationError(
      account.providerId,
      `${account.providerId} must be signed in again before account deletion`,
    )
  }
  return token
}

async function revokeAppleToken(
  account: ProviderAccount,
  clientId: string,
  clientSecret: string,
  fetcher: Fetcher,
): Promise<void> {
  const token = requiredToken(account)
  const response = await fetcher('https://appleid.apple.com/auth/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      token,
      token_type_hint: account.refreshToken ? 'refresh_token' : 'access_token',
    }),
  })
  if (response.ok) return
  // Apple answers an already-revoked or expired token with 400 invalid_grant. Treat only that
  // documented idempotent case as success (mirroring Google's 400 and GitHub's 404) so a
  // deletion that failed after a partial revocation can retry the remaining grants instead of
  // throwing forever on the token it already revoked. Other 400s (notably invalid_client for an
  // expired or malformed client-secret JWT) mean the grant is still live, so they must throw to
  // stop us deleting the local account while Apple keeps the sign-in active.
  if (response.status === 400) {
    let error: unknown
    try {
      error = ((await response.json()) as { error?: unknown }).error
    } catch {
      throw new ProviderRevocationError('apple', 'Apple credential revocation returned an unparseable 400 body', 400)
    }
    if (error === 'invalid_grant') return
    throw new ProviderRevocationError('apple', `Apple credential revocation failed: ${String(error)}`, 400)
  }
  throw new ProviderRevocationError('apple', 'Apple credential revocation failed', response.status)
}

async function revokeApple(account: ProviderAccount, env: ProviderEnv, fetcher: Fetcher): Promise<ProviderRevocationOutcome> {
  const hasWebCredential = !!(account.refreshToken || account.accessToken)
  const hasNativeCredential = !!(account.nativeRefreshToken || account.nativeAccessToken)
  if (!hasWebCredential && !hasNativeCredential) return 'manual_action_required'

  if (hasWebCredential) {
    if (!env.APPLE_CLIENT_ID || !env.APPLE_CLIENT_SECRET) {
      throw new ProviderRevocationError('apple', 'Web Apple revocation is not configured')
    }
    await revokeAppleToken(account, env.APPLE_CLIENT_ID, env.APPLE_CLIENT_SECRET, fetcher)
  }

  if (hasNativeCredential) {
    if (!env.APPLE_APP_CLIENT_SECRET) {
      throw new ProviderRevocationError('apple', 'Native Apple revocation is not configured')
    }
    await revokeAppleToken({
      providerId: 'apple',
      accessToken: account.nativeAccessToken,
      refreshToken: account.nativeRefreshToken,
    }, 'app.wingdex', env.APPLE_APP_CLIENT_SECRET, fetcher)
  }
  return 'revoked'
}

async function revokeGoogle(account: ProviderAccount, env: ProviderEnv, fetcher: Fetcher): Promise<void> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new ProviderRevocationError('google', 'Google revocation is not configured')
  }
  const response = await fetcher('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: requiredToken(account) }),
  })
  if (!response.ok && response.status !== 400) {
    throw new ProviderRevocationError('google', 'Google credential revocation failed', response.status)
  }
}

async function revokeGitHub(account: ProviderAccount, env: ProviderEnv, fetcher: Fetcher): Promise<void> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw new ProviderRevocationError('github', 'GitHub revocation is not configured')
  }
  const accessToken = account.accessToken
  if (!accessToken) {
    throw new ProviderRevocationError('github', 'github must be signed in again before account deletion')
  }
  const response = await fetcher(`https://api.github.com/applications/${encodeURIComponent(env.GITHUB_CLIENT_ID)}/token`, {
    method: 'DELETE',
    headers: {
      Accept: 'application/vnd.github+json',
      // Without this, fetch labels the JSON body text/plain and GitHub can reject
      // the revocation, which would block account deletion.
      'Content-Type': 'application/json',
      Authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`,
      'User-Agent': 'WingDex/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ access_token: accessToken }),
  })
  if (!response.ok && response.status !== 404) {
    throw new ProviderRevocationError('github', 'GitHub credential revocation failed', response.status)
  }
}

export async function revokeProviderAccount(
  account: ProviderAccount,
  env: ProviderEnv,
  fetcher: Fetcher = fetch,
): Promise<ProviderRevocationResult> {
  switch (account.providerId) {
    case 'apple':
      return { providerId: 'apple', outcome: await revokeApple(account, env, fetcher) }
    case 'google':
      await revokeGoogle(account, env, fetcher)
      return { providerId: 'google', outcome: 'revoked' }
    case 'github':
      await revokeGitHub(account, env, fetcher)
      return { providerId: 'github', outcome: 'revoked' }
    case 'credential':
      return { providerId: 'credential', outcome: 'skipped' }
    default:
      throw new ProviderRevocationError(account.providerId, `Unsupported linked provider: ${account.providerId}`)
  }
}

export async function revokeProvidersAndDeleteUser(
  db: D1Database,
  userId: string,
  env: ProviderEnv,
  fetcher: Fetcher = fetch,
  observer?: ProviderRevocationObserver,
): Promise<AccountDeletionResult> {
  const accounts = await db
    .prepare(
      `SELECT account.providerId, account.accessToken, account.refreshToken,
              native.accessToken AS nativeAccessToken,
              native.refreshToken AS nativeRefreshToken
       FROM account
       LEFT JOIN apple_native_revocation_credential AS native
         ON native.authAccountId = account.id
       WHERE account.userId = ?`
    )
    .bind(userId)
    .all<ProviderAccount>()

  const outcomes: ProviderRevocationResult[] = []
  for (const account of accounts.results) {
    observer?.('started', { providerId: account.providerId, outcome: 'skipped' })
    try {
      const result = await revokeProviderAccount(account, env, fetcher)
      outcomes.push(result)
      observer?.('completed', result)
    } catch (error) {
      observer?.('completed', { providerId: account.providerId, outcome: 'failed' })
      throw error
    }
  }

  await db.prepare('DELETE FROM "user" WHERE id = ?').bind(userId).run()
  return {
    revokedProviderCount: outcomes.filter(result => result.outcome === 'revoked').length,
    manualAppleRevocationRequired: outcomes.some(
      result => result.providerId === 'apple' && result.outcome === 'manual_action_required',
    ),
  }
}

export interface AppleTokenResponse {
  accessToken: string
  refreshToken: string
  subject: string
}

function appleSubject(idToken: string): string {
  const payload = idToken.split('.')[1]
  if (!payload) {
    throw new ProviderRevocationError('apple', 'Apple token response omitted a valid subject')
  }
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
      .padEnd(Math.ceil(payload.length / 4) * 4, '=')
    const decoded = JSON.parse(atob(base64)) as { sub?: unknown }
    if (typeof decoded.sub === 'string' && decoded.sub.length > 0) return decoded.sub
  } catch {
    // Report malformed token responses consistently below.
  }
  throw new ProviderRevocationError('apple', 'Apple token response omitted a valid subject')
}

export async function storeNativeAppleRevocationCredentials(
  db: D1Database,
  userId: string,
  tokens: AppleTokenResponse,
): Promise<boolean> {
  const account = await db.prepare(
    `SELECT id FROM account
     WHERE userId = ?1 AND providerId = 'apple' AND accountId = ?2`
  ).bind(userId, tokens.subject).first<{ id: string }>()
  if (!account) return false

  await db.prepare(
    `INSERT INTO apple_native_revocation_credential
       (authAccountId, accessToken, refreshToken, updatedAt)
     VALUES (?1, ?2, ?3, datetime('now'))
     ON CONFLICT(authAccountId) DO UPDATE SET
       accessToken = excluded.accessToken,
       refreshToken = excluded.refreshToken,
       updatedAt = excluded.updatedAt`
  ).bind(account.id, tokens.accessToken, tokens.refreshToken).run()
  return true
}

export async function exchangeAppleAuthorizationCode(
  code: string,
  appClientSecret: string,
  fetcher: Fetcher = fetch,
): Promise<AppleTokenResponse> {
  const response = await fetcher('https://appleid.apple.com/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: 'app.wingdex',
      client_secret: appClientSecret,
      code,
      grant_type: 'authorization_code',
    }),
  })
  if (!response.ok) {
    throw new ProviderRevocationError('apple', 'Apple authorization code exchange failed', response.status)
  }
  const body = await response.json() as {
    access_token?: string
    refresh_token?: string
    id_token?: string
  }
  if (!body.access_token || !body.refresh_token || !body.id_token) {
    throw new ProviderRevocationError('apple', 'Apple token response omitted revocation credentials')
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    subject: appleSubject(body.id_token),
  }
}