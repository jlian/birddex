import { describe, expect, it, vi } from 'vitest'
import {
  exchangeAppleAuthorizationCode,
  ProviderRevocationError,
  revokeProviderAccount,
  revokeProvidersAndDeleteUser,
  type ProviderAccount,
} from './provider-revocation'

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const env = {
  APPLE_APP_CLIENT_SECRET: 'apple-app-secret',
  GITHUB_CLIENT_ID: 'github-client',
  GITHUB_CLIENT_SECRET: 'github-secret',
  GOOGLE_CLIENT_ID: 'google-client',
  GOOGLE_CLIENT_SECRET: 'google-secret',
}

describe('provider revocation', () => {
  it('revokes an Apple refresh token for the native app client', async () => {
    const fetcher = vi.fn<Fetcher>(async () => new Response(null, { status: 200 }))
    await revokeProviderAccount({ providerId: 'apple', refreshToken: 'refresh' }, env, fetcher)

    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('https://appleid.apple.com/auth/revoke')
    expect(String(init?.body)).toContain('client_id=app.wingdex')
    expect(String(init?.body)).toContain('token_type_hint=refresh_token')
  })

  it('treats already-invalid Google and missing GitHub grants as idempotent success', async () => {
    await expect(revokeProviderAccount(
      { providerId: 'google', accessToken: 'expired' },
      env,
      vi.fn(async () => new Response(null, { status: 400 })),
    )).resolves.toBeUndefined()
    await expect(revokeProviderAccount(
      { providerId: 'github', accessToken: 'revoked' },
      env,
      vi.fn(async () => new Response(null, { status: 404 })),
    )).resolves.toBeUndefined()
  })

  it('blocks deletion when a linked provider has no revocable token', async () => {
    await expect(revokeProviderAccount({ providerId: 'apple' }, env)).rejects.toEqual(
      new ProviderRevocationError('apple', 'apple must be signed in again before account deletion'),
    )
  })

  it('does not delete locally after a provider failure', async () => {
    const accounts: ProviderAccount[] = [
      { providerId: 'github', accessToken: 'github-token' },
      { providerId: 'apple', refreshToken: 'apple-token' },
    ]
    let deleted = false
    const db = {
      prepare(sql: string) {
        return {
          bind() { return this },
          async all() { return { results: accounts } },
          async run() {
            if (sql.startsWith('DELETE')) deleted = true
            return { meta: { changes: 1 } }
          },
        }
      },
    } as unknown as D1Database
    const fetcher = vi.fn<Fetcher>(async (url) => new Response(null, {
      status: String(url).includes('github.com') ? 204 : 503,
    }))

    await expect(revokeProvidersAndDeleteUser(db, 'user-1', env, fetcher)).rejects.toMatchObject({
      providerId: 'apple',
      status: 503,
    })
    expect(deleted).toBe(false)
  })

  it('deletes locally only after every provider succeeds', async () => {
    const accounts: ProviderAccount[] = [
      { providerId: 'credential' },
      { providerId: 'github', accessToken: 'github-token' },
    ]
    let deleted = false
    const db = {
      prepare(sql: string) {
        return {
          bind() { return this },
          async all() { return { results: accounts } },
          async run() {
            if (sql.startsWith('DELETE')) deleted = true
            return { meta: { changes: 1 } }
          },
        }
      },
    } as unknown as D1Database

    await expect(revokeProvidersAndDeleteUser(
      db,
      'user-1',
      env,
      vi.fn(async () => new Response(null, { status: 204 })),
    )).resolves.toBe(1)
    expect(deleted).toBe(true)
  })
})

describe('Apple native token capture', () => {
  it('exchanges an authorization code for stored revocation credentials', async () => {
    const fetcher = vi.fn<Fetcher>(async () => Response.json({
      access_token: 'access',
      refresh_token: 'refresh',
    }))

    await expect(exchangeAppleAuthorizationCode('one-time-code', 'app-secret', fetcher)).resolves.toEqual({
      accessToken: 'access',
      refreshToken: 'refresh',
    })
    expect(String(fetcher.mock.calls[0][1]?.body)).toContain('code=one-time-code')
  })
})