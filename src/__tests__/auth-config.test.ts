import { describe, it, expect } from 'vitest'
import { anonymousAccountPolicy, createAuth, normalizeAuthRequest } from '../../functions/lib/auth'
import { passkeyRegistrationAction } from '../../functions/lib/auth'

const mockEnv = {
  DB: {} as D1Database,
  AI: {} as Ai,
  BETTER_AUTH_URL: 'http://localhost:5000',
  BETTER_AUTH_SECRET: 'test-secret-at-least-32-characters-long!!',
  GITHUB_CLIENT_ID: 'test-github-id',
  GITHUB_CLIENT_SECRET: 'test-github-secret',
  APPLE_CLIENT_ID: '',
  APPLE_CLIENT_SECRET: '',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
  CF_ACCOUNT_ID: '',
  AI_GATEWAY_ID: '',
  CF_AIG_TOKEN: '',
  OPENAI_API_KEY: '',
  OPENAI_MODEL: '',
} satisfies Env

describe('auth config', () => {
describe('passkey registration action', () => {
  it('upgrades only anonymous sessions', () => {
    expect(passkeyRegistrationAction({ id: 'user-1', isAnonymous: true }, 'user-1')).toBe('upgrade')
    expect(passkeyRegistrationAction({ id: 'user-1', isAnonymous: false }, 'user-1')).toBe('reuse')
    expect(passkeyRegistrationAction(undefined, 'user-1')).toBe('create')
  })
})
  it('exposes account linking options', () => {
    const auth = createAuth(mockEnv)
    expect(auth.options.account?.accountLinking?.enabled).toBe(true)
    expect(auth.options.account?.accountLinking?.trustedProviders).toContain('github')
    expect(auth.options.account?.accountLinking?.trustedProviders).toContain('apple')
    expect(auth.options.account?.accountLinking?.trustedProviders).toContain('google')
    expect(auth.options.account?.accountLinking?.allowDifferentEmails).toBe(true)
  })

  it('keeps sessions alive for a year', () => {
    const auth = createAuth(mockEnv)
    // Under Chrome's 400-day cookie cap, which silently rewrites anything above it.
    expect(auth.options.session?.expiresIn).toBe(60 * 60 * 24 * 365)
  })

  it('includes passkey and anonymous plugins', () => {
    const auth = createAuth(mockEnv)
    const apiKeys = Object.keys(auth.api)
    // Passkey plugin registers passkey-related endpoints
    expect(apiKeys.some((k) => k.toLowerCase().includes('passkey'))).toBe(true)
    // Anonymous plugin adds signInAnonymous
    expect(apiKeys.some((k) => k.toLowerCase().includes('anonymous'))).toBe(true)
  })

  it('does not delete anonymous WingDex data when social login switches accounts', () => {
    expect(anonymousAccountPolicy.disableDeleteAnonymousUser).toBe(true)
  })

  it('registers GitHub callback route when credentials are set', () => {
    const auth = createAuth(mockEnv)
    // signInSocial + callbackOAuth are registered when socialProviders are configured
    expect(auth.api.signInSocial).toBeDefined()
    expect(auth.api.callbackOAuth).toBeDefined()
  })

  it('omits socialProviders when credentials are missing', () => {
    const authNoGh = createAuth({ ...mockEnv, GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '' })
    // Auth should still create successfully without GitHub
    expect(authNoGh.api).toBeDefined()
  })

  it('registers Apple provider when credentials are set', () => {
    const auth = createAuth({
      ...mockEnv,
      APPLE_CLIENT_ID: 'test-apple-id',
      APPLE_CLIENT_SECRET: 'test-apple-secret',
    })
    expect(auth.api.signInSocial).toBeDefined()
  })

  it('registers Google provider when credentials are set', () => {
    const auth = createAuth({
      ...mockEnv,
      GOOGLE_CLIENT_ID: 'test-google-id',
      GOOGLE_CLIENT_SECRET: 'test-google-secret',
    })
    expect(auth.api.signInSocial).toBeDefined()
  })

  it('maps local two-port runtime to app origin for baseURL', () => {
    const req = new Request('http://localhost:8787/api/auth/get-session', {
      headers: { origin: 'http://localhost:5000' },
    })

    const auth = createAuth({ ...mockEnv, BETTER_AUTH_URL: '' }, { request: req })
    expect(auth.options.baseURL).toBe('http://localhost:5000')
  })

  it('includes request and app origins in trustedOrigins for local runtime', () => {
    const req = new Request('http://localhost:8787/api/auth/get-session', {
      headers: { origin: 'http://localhost:5000' },
    })

    const auth = createAuth({ ...mockEnv, BETTER_AUTH_URL: '' }, { request: req })
    const trusted = auth.options.trustedOrigins as string[] | undefined
    expect(trusted).toContain('http://localhost:5000')
    expect(trusted).toContain('http://localhost:8787')
  })

  it('uses configured non-loopback Origin header in default mode during proxied local dev', () => {
    const req = new Request('http://localhost:8787/api/auth/sign-in/social', {
      headers: { origin: 'https://wingdev.example.net' },
    })

    const auth = createAuth(
      {
        ...mockEnv,
        BETTER_AUTH_URL: 'https://wingdev.example.net',
        TRUSTED_ORIGINS: 'https://wingdev.example.net',
      } as Env,
      { request: req },
    )
    expect(auth.options.baseURL).toBe('https://wingdev.example.net')
  })

  it('uses configured forwarded host in default mode during proxied callback requests', () => {
    const req = new Request('http://localhost:8787/api/auth/callback/google', {
      headers: {
        host: 'wingdev.example.net',
        'x-forwarded-proto': 'https',
      },
    })

    const auth = createAuth(
      {
        ...mockEnv,
        BETTER_AUTH_URL: 'https://wingdev.example.net',
        TRUSTED_ORIGINS: 'https://wingdev.example.net',
      } as Env,
      { request: req },
    )
    expect(auth.options.baseURL).toBe('https://wingdev.example.net')
  })

  it('uses configured referer origin in default mode during hosted callback requests', () => {
    const req = new Request('http://localhost:8787/api/auth/callback/github?code=test&state=test', {
      headers: {
        referer: 'https://wingdev.example.net/',
      },
    })

    const auth = createAuth(
      {
        ...mockEnv,
        BETTER_AUTH_URL: 'https://wingdev.example.net',
        TRUSTED_ORIGINS: 'https://wingdev.example.net',
      } as Env,
      { request: req },
    )
    expect(auth.options.baseURL).toBe('https://wingdev.example.net')
  })

  it('normalizes proxied hosted callback requests before passing to Better Auth', () => {
    const req = new Request('http://localhost:8787/api/auth/callback/github?code=test&state=test', {
      headers: {
        referer: 'https://wingdev.example.net/',
      },
    })

    const normalized = normalizeAuthRequest(
      {
        ...mockEnv,
        BETTER_AUTH_URL: 'https://wingdev.example.net',
        TRUSTED_ORIGINS: 'https://wingdev.example.net',
      } as Env,
      req,
    )
    expect(normalized.url).toBe('https://wingdev.example.net/api/auth/callback/github?code=test&state=test')
  })

  it('uses hosted auth URL when callback request carries secure Better Auth cookies', () => {
    const req = new Request('http://localhost:8787/api/auth/callback/github?code=test&state=test', {
      headers: {
        cookie: '__Secure-better-auth.state=test.sig',
      },
    })

    const auth = createAuth(
      {
        ...mockEnv,
        BETTER_AUTH_URL: 'https://wingdev.example.net',
        TRUSTED_ORIGINS: 'https://wingdev.example.net',
      } as Env,
      { request: req },
    )
    expect(auth.options.baseURL).toBe('https://wingdev.example.net')
  })

  it('normalizes secure-cookie callback requests to hosted auth URL', () => {
    const req = new Request('http://localhost:8787/api/auth/callback/github?code=test&state=test', {
      headers: {
        cookie: '__Secure-better-auth.state=test.sig',
      },
    })

    const normalized = normalizeAuthRequest(
      {
        ...mockEnv,
        BETTER_AUTH_URL: 'https://wingdev.example.net',
        TRUSTED_ORIGINS: 'https://wingdev.example.net',
      } as Env,
      req,
    )
    expect(normalized.url).toBe('https://wingdev.example.net/api/auth/callback/github?code=test&state=test')
  })

  it('trusts appleid.apple.com origin when Apple provider is configured', () => {
    const auth = createAuth({
      ...mockEnv,
      APPLE_CLIENT_ID: 'test-apple-id',
      APPLE_CLIENT_SECRET: 'test-apple-secret',
    })
    const trusted = auth.options.trustedOrigins as string[] | undefined
    expect(trusted).toContain('https://appleid.apple.com')
  })

  it('does not trust appleid.apple.com when Apple provider is not configured', () => {
    const auth = createAuth(mockEnv)
    const trusted = auth.options.trustedOrigins as string[] | undefined
    expect(trusted).not.toContain('https://appleid.apple.com')
  })

  it('includes bearer plugin for native mobile token auth', () => {
    const auth = createAuth(mockEnv)
    // The bearer plugin registers the token endpoint
    const pluginIds = auth.options.plugins?.map(
      (p: { id?: string }) => p.id,
    ) ?? []
    expect(pluginIds).toContain('bearer')
  })

  it('uses localhost baseURL when request is loopback even if BETTER_AUTH_URL is a remote domain', () => {
    const req = new Request('http://localhost:8787/api/auth/get-session', {
      headers: { origin: 'http://localhost:5000' },
    })

    const auth = createAuth(
      { ...mockEnv, BETTER_AUTH_URL: 'https://wingdev.example.net' },
      { request: req },
    )
    expect(auth.options.baseURL).toBe('http://localhost:5000')
  })

  it('uses hosted BETTER_AUTH_URL in hosted OAuth mode during local dev', () => {
    const req = new Request('http://localhost:8787/api/auth/mobile/start?provider=github')

    const auth = createAuth(
      { ...mockEnv, BETTER_AUTH_URL: 'https://wingdev.example.net' },
      { request: req, mode: 'hosted-oauth' },
    )
    expect(auth.options.baseURL).toBe('https://wingdev.example.net')
  })

  it('falls back to localhost in default mode on callback paths without hosted public origin signals', () => {
    const req = new Request('http://localhost:8787/api/auth/callback/google')

    const auth = createAuth(
      { ...mockEnv, BETTER_AUTH_URL: 'https://wingdev.example.net' },
      { request: req },
    )
    expect(auth.options.baseURL).toBe('http://localhost:5000')
  })

  it('uses hosted BETTER_AUTH_URL for OAuth callback routes when mode is hosted OAuth', () => {
    const req = new Request('http://localhost:8787/api/auth/callback/google')

    const auth = createAuth(
      { ...mockEnv, BETTER_AUTH_URL: 'https://wingdev.example.net' },
      { request: req, mode: 'hosted-oauth' },
    )
    expect(auth.options.baseURL).toBe('https://wingdev.example.net')
  })
})
