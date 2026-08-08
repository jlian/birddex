import { describe, expect, it, vi } from 'vitest'
import {
  exchangeAppleAuthorizationCode,
  ProviderRevocationError,
  revokeProviderAccount,
  revokeProvidersAndDeleteUser,
  storeNativeAppleRevocationCredentials,
  type ProviderAccount,
} from './provider-revocation'

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const env = {
  APPLE_APP_CLIENT_SECRET: 'apple-app-secret',
  APPLE_CLIENT_ID: 'app.wingdex.signin',
  APPLE_CLIENT_SECRET: 'apple-web-secret',
  GITHUB_CLIENT_ID: 'github-client',
  GITHUB_CLIENT_SECRET: 'github-secret',
  GOOGLE_CLIENT_ID: 'google-client',
  GOOGLE_CLIENT_SECRET: 'google-secret',
}

describe('provider revocation', () => {
  it('revokes a web Apple token with its Services ID credentials', async () => {
    const fetcher = vi.fn<Fetcher>(async () => new Response(null, { status: 200 }))
    await revokeProviderAccount({ providerId: 'apple', refreshToken: 'refresh' }, env, fetcher)

    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('https://appleid.apple.com/auth/revoke')
    expect(String(init?.body)).toContain('client_id=app.wingdex.signin')
    expect(String(init?.body)).toContain('client_secret=apple-web-secret')
    expect(String(init?.body)).toContain('token_type_hint=refresh_token')
  })

  it('revokes a native Apple token with its bundle ID credentials', async () => {
    const fetcher = vi.fn<Fetcher>(async () => new Response(null, { status: 200 }))
    await revokeProviderAccount({
      providerId: 'apple',
      nativeRefreshToken: 'native-refresh',
    }, env, fetcher)

    expect(String(fetcher.mock.calls[0][1]?.body)).toContain('client_id=app.wingdex')
    expect(String(fetcher.mock.calls[0][1]?.body)).toContain('client_secret=apple-app-secret')
    expect(String(fetcher.mock.calls[0][1]?.body)).toContain('token=native-refresh')
  })

  it('revokes both web and native Apple grants with their issuing clients', async () => {
    const fetcher = vi.fn<Fetcher>(async () => new Response(null, { status: 200 }))
    await revokeProviderAccount({
      providerId: 'apple',
      refreshToken: 'web-refresh',
      nativeRefreshToken: 'native-refresh',
    }, env, fetcher)

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(String(fetcher.mock.calls[0][1]?.body)).toContain('client_id=app.wingdex.signin')
    expect(String(fetcher.mock.calls[1][1]?.body)).toContain('client_id=app.wingdex')
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

  it('treats an already-revoked Apple grant as success so retries reach remaining grants', async () => {
    const fetcher = vi.fn<Fetcher>(async () => new Response(null, { status: 400 }))
    await expect(revokeProviderAccount({
      providerId: 'apple',
      refreshToken: 'already-revoked-web',
      nativeRefreshToken: 'native-refresh',
    }, env, fetcher)).resolves.toBeUndefined()

    // The web token 400 (invalid_grant) must not short-circuit; the native grant is still revoked.
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(String(fetcher.mock.calls[1][1]?.body)).toContain('token=native-refresh')
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
  const idToken = (subject: string) => [
    'header',
    btoa(JSON.stringify({ sub: subject })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'),
    'signature',
  ].join('.')

  it('exchanges an authorization code for stored revocation credentials', async () => {
    const fetcher = vi.fn<Fetcher>(async () => Response.json({
      access_token: 'access',
      refresh_token: 'refresh',
      id_token: idToken('apple-subject-1'),
    }))

    await expect(exchangeAppleAuthorizationCode('one-time-code', 'app-secret', fetcher)).resolves.toEqual({
      accessToken: 'access',
      refreshToken: 'refresh',
      subject: 'apple-subject-1',
    })
    expect(String(fetcher.mock.calls[0][1]?.body)).toContain('code=one-time-code')
  })

  it('stores native credentials separately from Better Auth web tokens', async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = []
    const db = {
      prepare(sql: string) {
        const statement = { sql, values: [] as unknown[] }
        statements.push(statement)
        return {
          bind(...values: unknown[]) {
            statement.values = values
            return this
          },
          async first() { return { id: 'apple-account-1' } },
          async run() { return { meta: { changes: 1 } } },
        }
      },
    } as unknown as D1Database

    await expect(storeNativeAppleRevocationCredentials(db, 'user-1', {
      accessToken: 'native-access',
      refreshToken: 'native-refresh',
      subject: 'apple-subject-1',
    })).resolves.toBe(true)

    expect(statements[0].sql).toContain("providerId = 'apple'")
    expect(statements[0].sql).toContain('accountId = ?2')
    expect(statements[0].values).toEqual(['user-1', 'apple-subject-1'])
    expect(statements[1].sql).toContain('INSERT INTO apple_native_revocation_credential')
    expect(statements[1].sql).not.toContain('UPDATE account')
    expect(statements[1].values).toEqual([
      'apple-account-1',
      'native-access',
      'native-refresh',
    ])
  })

  it('rejects token responses without an Apple subject', async () => {
    const fetcher = vi.fn<Fetcher>(async () => Response.json({
      access_token: 'access',
      refresh_token: 'refresh',
      id_token: idToken(''),
    }))

    await expect(exchangeAppleAuthorizationCode('one-time-code', 'app-secret', fetcher)).rejects.toEqual(
      new ProviderRevocationError('apple', 'Apple token response omitted a valid subject'),
    )
  })

  it('does not store credentials when the Apple subject is not linked', async () => {
    let inserted = false
    const db = {
      prepare(sql: string) {
        return {
          bind() { return this },
          async first() { return null },
          async run() {
            if (sql.includes('INSERT INTO apple_native_revocation_credential')) inserted = true
            return { meta: { changes: 1 } }
          },
        }
      },
    } as unknown as D1Database

    await expect(storeNativeAppleRevocationCredentials(db, 'user-1', {
      accessToken: 'native-access',
      refreshToken: 'native-refresh',
      subject: 'different-apple-subject',
    })).resolves.toBe(false)
    expect(inserted).toBe(false)
  })
})