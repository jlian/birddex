export interface ProviderAccount {
  providerId: string
  accessToken?: string | null
  refreshToken?: string | null
}

type ProviderEnv = Pick<Env,
  | 'APPLE_APP_CLIENT_SECRET'
  | 'GITHUB_CLIENT_ID'
  | 'GITHUB_CLIENT_SECRET'
  | 'GOOGLE_CLIENT_ID'
  | 'GOOGLE_CLIENT_SECRET'
>

type Fetcher = typeof fetch

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

async function revokeApple(account: ProviderAccount, env: ProviderEnv, fetcher: Fetcher): Promise<void> {
  if (!env.APPLE_APP_CLIENT_SECRET) {
    throw new ProviderRevocationError('apple', 'Native Apple revocation is not configured')
  }
  const token = requiredToken(account)
  const response = await fetcher('https://appleid.apple.com/auth/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: 'app.wingdex',
      client_secret: env.APPLE_APP_CLIENT_SECRET,
      token,
      token_type_hint: account.refreshToken ? 'refresh_token' : 'access_token',
    }),
  })
  if (!response.ok) {
    throw new ProviderRevocationError('apple', 'Apple credential revocation failed', response.status)
  }
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
): Promise<void> {
  switch (account.providerId) {
    case 'apple':
      return revokeApple(account, env, fetcher)
    case 'google':
      return revokeGoogle(account, env, fetcher)
    case 'github':
      return revokeGitHub(account, env, fetcher)
    case 'credential':
      return
    default:
      throw new ProviderRevocationError(account.providerId, `Unsupported linked provider: ${account.providerId}`)
  }
}

export async function revokeProvidersAndDeleteUser(
  db: D1Database,
  userId: string,
  env: ProviderEnv,
  fetcher: Fetcher = fetch,
): Promise<number> {
  const accounts = await db
    .prepare('SELECT providerId, accessToken, refreshToken FROM account WHERE userId = ?')
    .bind(userId)
    .all<ProviderAccount>()

  for (const account of accounts.results) {
    await revokeProviderAccount(account, env, fetcher)
  }

  await db.prepare('DELETE FROM "user" WHERE id = ?').bind(userId).run()
  return accounts.results.filter(account => account.providerId !== 'credential').length
}

export interface AppleTokenResponse {
  accessToken: string
  refreshToken: string
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
  const body = await response.json() as { access_token?: string; refresh_token?: string }
  if (!body.access_token || !body.refresh_token) {
    throw new ProviderRevocationError('apple', 'Apple token response omitted revocation credentials')
  }
  return { accessToken: body.access_token, refreshToken: body.refresh_token }
}