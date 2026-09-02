import { test, expect, request } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { testBaseURL } from './test-server'
import { loadApp } from './helpers'

const API_BASE = testBaseURL
const PREVIEW_BASE = process.env.PREVIEW_BASE_URL || 'https://localhost.wingdex.app'

function buildCookieHeader(setCookieHeaders: string[]) {
  return setCookieHeaders
    .map(value => value.split(';')[0])
    .filter(Boolean)
    .join('; ')
}

async function waitForServerReady(baseURL: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseURL}/api/auth/get-session`)
      if (response.ok) return
    } catch {
      // keep polling
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Timed out waiting for Wrangler server at ${baseURL}`)
}

test.describe('API smoke (request context)', () => {
  test.beforeAll(async () => {
    await waitForServerReady(API_BASE, 10_000)
  })

  test('import is closed to anonymous sessions', async () => {
    const api = await request.newContext({ baseURL: API_BASE })

    const signIn = await api.post('/api/auth/sign-in/anonymous', { data: {} })
    expect(signIn.status()).toBe(200)
    const cookie = buildCookieHeader(
      signIn.headersArray().filter(h => h.name.toLowerCase() === 'set-cookie').map(h => h.value),
    )
    expect(cookie).toBeTruthy()

    // The UI keeps import behind sign-up, but that gate is cosmetic on its own:
    // an anonymous session could call the endpoint directly, and it is the
    // heaviest write path an account can reach.
    const imported = await api.post('/api/import/ebird-csv', {
      headers: { cookie },
      multipart: {
        file: {
          name: 'ebird-import.csv',
          mimeType: 'text/csv',
          buffer: readFileSync(path.resolve('e2e/fixtures/ebird-import.csv')),
        },
      },
    })
    expect(imported.status()).toBe(403)

    // Creating and exporting their own sightings still works, since that is
    // the app rather than account management.
    const outing = await api.post('/api/data/outings', {
      headers: { cookie, 'Content-Type': 'application/json' },
      data: {
        id: `outing_${crypto.randomUUID()}`,
        startTime: '2026-03-01T09:00:00.000Z',
        endTime: '2026-03-01T10:00:00.000Z',
        locationName: 'Anonymous Patch',
        notes: '',
        createdAt: new Date().toISOString(),
      },
    })
    expect(outing.ok(), `outing create failed: ${outing.status()}`).toBe(true)

    const exported = await api.get('/api/export/sightings', { headers: { cookie } })
    expect(exported.status(), 'export stays open as the leave-with-your-data path').toBe(200)
    expect((await api.get('/api/export/dex', { headers: { cookie } })).status()).toBe(403)
    expect((await api.get('/api/export/outing/missing', { headers: { cookie } })).status()).toBe(403)

    await api.dispose()
  })

  test('anonymous auth + protected data CRUD', async () => {
    const api = await request.newContext({ baseURL: API_BASE })

    const unauthSession = await api.get('/api/auth/get-session')
    expect(unauthSession.status()).toBe(200)
    expect(await unauthSession.json()).toBeNull()

    const signIn = await api.post('/api/auth/sign-in/anonymous', {
      data: {},
    })
    expect(signIn.status()).toBe(200)
    const signInJson = await signIn.json()
    expect(signInJson?.token).toBeTruthy()
    expect(signInJson?.user?.id).toBeTruthy()

    const authCookie = buildCookieHeader(
      signIn
        .headersArray()
        .filter(header => header.name.toLowerCase() === 'set-cookie')
        .map(header => header.value),
    )
    expect(authCookie).toBeTruthy()

    const authSession = await api.get('/api/auth/get-session', {
      headers: { cookie: authCookie },
    })
    expect(authSession.status()).toBe(200)
    const authSessionJson = await authSession.json()
    expect(authSessionJson?.user?.id).toBeTruthy()

    const initialData = await api.get('/api/data/all', {
      headers: { cookie: authCookie },
    })
    expect(initialData.status()).toBe(200)
    const initialJson = await initialData.json()
    expect(Array.isArray(initialJson.outings)).toBe(true)

    const outingId = `api-smoke-${Date.now()}`
    const createOuting = await api.post('/api/data/outings', {
      headers: { cookie: authCookie },
      data: {
        id: outingId,
        startTime: '2026-02-20T08:00:00.000Z',
        endTime: '2026-02-20T09:00:00.000Z',
        locationName: 'API Smoke Park',
        createdAt: '2026-02-20T09:00:00.000Z',
      },
    })
    expect(createOuting.status()).toBe(200)

    const replayOuting = await api.post('/api/data/outings', {
      headers: { cookie: authCookie },
      data: {
        id: outingId,
        startTime: '2026-02-20T08:00:00.000Z',
        endTime: '2026-02-20T09:30:00.000Z',
        locationName: 'Renamed API Smoke Park',
        createdAt: '2099-01-01T00:00:00.000Z',
      },
    })
    expect(replayOuting.status()).toBe(200)
    await expect(replayOuting.json()).resolves.toMatchObject({
      id: outingId,
      locationName: 'Renamed API Smoke Park',
      createdAt: '2026-02-20T09:00:00.000Z',
    })

    const postCreateData = await api.get('/api/data/all', {
      headers: { cookie: authCookie },
    })
    expect(postCreateData.status()).toBe(200)
    const postCreateJson = await postCreateData.json()
    const savedOuting = postCreateJson.outings.find((outing: { id: string }) => outing.id === outingId)
    expect(savedOuting).toMatchObject({
      id: outingId,
      locationName: 'Renamed API Smoke Park',
      endTime: '2026-02-20T09:30:00.000Z',
      createdAt: '2026-02-20T09:00:00.000Z',
    })

    const cardinalId = `${outingId}-cardinal`
    const blueJayId = `${outingId}-blue-jay`
    const createObservations = await api.post('/api/data/observations', {
      headers: { cookie: authCookie },
      data: [
        {
          id: cardinalId,
          outingId,
          speciesName: 'Northern Cardinal (Cardinalis cardinalis)',
          count: 1,
          certainty: 'confirmed',
          notes: '',
        },
        {
          id: blueJayId,
          outingId,
          speciesName: 'Blue Jay (Cyanocitta cristata)',
          count: 1,
          certainty: 'confirmed',
          notes: '',
        },
      ],
    })
    expect(createObservations.status()).toBe(200)

    const rejectObservation = await api.patch('/api/data/observations', {
      headers: { cookie: authCookie },
      data: { ids: [cardinalId], patch: { certainty: 'rejected' } },
    })
    expect(rejectObservation.status()).toBe(200)
    const rejectPayload = await rejectObservation.json()
    const remainingBlueJay = rejectPayload.dexUpdates.find(
      (entry: { speciesName: string }) => entry.speciesName.startsWith('Blue Jay'),
    )
    expect(remainingBlueJay?.wikiTitle).toBeTruthy()
    expect(remainingBlueJay?.thumbnailUrl).toMatch(/^https:\/\//)

    await api.dispose()
  })

  // Tagged `@remote-r2` because it needs a real Cloudflare token to reach the
  // PMTiles archive through Wrangler's mixed mode. GitHub withholds secrets
  // from FORK pull requests, so CI excludes this tag when no token is present:
  // otherwise every fork PR would fail here regardless of what it changed.
  test('reverse geocoding reads the remote PMTiles archive @remote-r2', async () => {
    const api = await request.newContext({ baseURL: API_BASE })
    const signIn = await api.post('/api/auth/sign-in/anonymous', { data: {} })
    expect(signIn.status()).toBe(200)
    const token = signIn.headers()['set-auth-token']
    expect(token).toBeTruthy()

    const response = await api.post('/api/geocoding/reverse', {
      headers: { Authorization: `Bearer ${token}` },
      data: { lat: 47.712, lon: -122.372 },
    })
    expect(response.status(), await response.text()).toBe(200)

    const body = await response.json() as {
      result?: { label?: string }
      nearby?: Array<{ label?: string }>
      regionCodes?: { stateProvince?: string; countryCode?: string }
      attribution?: string
    }
    expect(body.result?.label).toBe('Carkeek Park')
    expect(body.nearby?.some(place => place.label === 'Carkeek Park')).toBe(true)
    expect(body.regionCodes).toEqual({ stateProvince: 'US-WA', countryCode: 'US' })
    expect(body.attribution).toBe('(c) OpenStreetMap contributors, ODbL 1.0')

    await api.dispose()
  })

  // Import needs a registered account, and the only way to get one is the passkey
  // ceremony, which needs a browser. These drive the API directly through the
  // promoted page's request context rather than a bare request context.
  test('realistic eBird CSV import (multiple fixtures)', async ({ page }) => {
    await loadApp(page)
    const api = page.request

    const fixturePaths = [
      'e2e/fixtures/ebird-import.csv',
      'e2e/fixtures/ebird-import-variant.csv',
    ]

    for (const fixturePath of fixturePaths) {
      const csvPath = path.resolve(fixturePath)
      const csvBuffer = readFileSync(csvPath)

      const imported = await api.post('/api/import/ebird-csv', {
        multipart: {
          file: {
            name: path.basename(fixturePath),
            mimeType: 'text/csv',
            buffer: csvBuffer,
          },
        },
      })

      expect(imported.status(), `import should succeed for ${fixturePath}`).toBe(200)
      const importJson = await imported.json()
      expect(importJson.imported.outings, `outings imported for ${fixturePath}`).toBeGreaterThan(0)
      expect(importJson.imported.observations, `observations imported for ${fixturePath}`).toBeGreaterThan(0)
    }

    const dataAll = await api.get('/api/data/all')
    expect(dataAll.status()).toBe(200)
    const dataAllJson = await dataAll.json()
    expect(dataAllJson.outings.length).toBeGreaterThan(0)
    expect(dataAllJson.observations.length).toBeGreaterThan(0)
    expect(dataAllJson.dex.length).toBeGreaterThan(0)
  })

  test('re-importing the same export is a no-op', async ({ page }) => {
    await loadApp(page)
    const api = page.request

    const csvBuffer = readFileSync(path.resolve('e2e/fixtures/ebird-import.csv'))

    const firstImport = await api.post('/api/import/ebird-csv', {
      multipart: {
        file: {
          name: 'ebird-import.csv',
          mimeType: 'text/csv',
          buffer: csvBuffer,
        },
      },
    })
    expect(firstImport.status()).toBe(200)
    expect((await firstImport.json()).imported.outings).toBeGreaterThan(0)

    // Re-importing the same export used to insert a second copy of every
    // checklist. Assert it is a genuine no-op: nothing persisted, rows skipped
    // by submission id, and the library unchanged.
    const beforeAll = await api.get('/api/data/all')
    expect(beforeAll.status()).toBe(200)
    const outingCountAfterFirstImport = (await beforeAll.json()).outings.length
    expect(outingCountAfterFirstImport).toBeGreaterThan(0)

    const secondImport = await api.post('/api/import/ebird-csv', {
      multipart: {
        file: {
          name: 'ebird-import.csv',
          mimeType: 'text/csv',
          buffer: csvBuffer,
        },
      },
    })
    expect(secondImport.status()).toBe(200)
    const secondImportJson = await secondImport.json()

    expect(secondImportJson.imported.outings).toBe(0)
    expect(secondImportJson.imported.observations).toBe(0)
    expect(secondImportJson.skipped.rows).toBeGreaterThan(0)

    const afterAll = await api.get('/api/data/all')
    expect(afterAll.status()).toBe(200)
    expect((await afterAll.json()).outings.length).toBe(outingCountAfterFirstImport)

  })

  test('bearer token auth - CRUD without cookies', async () => {
    const api = await request.newContext({ baseURL: API_BASE })

    // Sign in anonymously to get a session token
    const signIn = await api.post('/api/auth/sign-in/anonymous', { data: {} })
    expect(signIn.status()).toBe(200)

    // Use the signed token from set-auth-token header (bearer plugin)
    const token = signIn.headers()['set-auth-token']
    expect(token).toBeTruthy()

    // New context without cookies to ensure we're testing Bearer-only auth
    const bearerApi = await request.newContext({ baseURL: API_BASE })
    const bearerHeader = { Authorization: `Bearer ${token}` }

    // GET /api/data/all with Bearer token (no cookies)
    const data = await bearerApi.get('/api/data/all', { headers: bearerHeader })
    expect(data.status()).toBe(200)
    const dataJson = await data.json()
    expect(Array.isArray(dataJson.outings)).toBe(true)

    // POST to create an outing with Bearer token
    const outingId = `bearer-smoke-${Date.now()}`
    const createOuting = await bearerApi.post('/api/data/outings', {
      headers: { ...bearerHeader, 'Content-Type': 'application/json' },
      data: {
        id: outingId,
        startTime: '2026-03-07T08:00:00.000Z',
        endTime: '2026-03-07T09:00:00.000Z',
        locationName: 'Bearer Smoke Park',
        createdAt: '2026-03-07T09:00:00.000Z',
      },
    })
    expect(createOuting.status()).toBe(200)

    // Verify outing was created
    const postCreate = await bearerApi.get('/api/data/all', { headers: bearerHeader })
    const postCreateJson = await postCreate.json()
    expect(postCreateJson.outings.some((o: { id: string }) => o.id === outingId)).toBe(true)

    // DELETE the outing with Bearer token
    const deleteOuting = await bearerApi.delete(`/api/data/outings/${outingId}`, { headers: bearerHeader })
    expect(deleteOuting.status()).toBe(200)

    // Invalid token returns 401
    const badToken = await bearerApi.get('/api/data/all', {
      headers: { Authorization: 'Bearer invalid-token-12345' },
    })
    expect(badToken.status()).toBe(401)

    await bearerApi.dispose()
    await api.dispose()
  })

  test('bearer token auth - get-session returns user info', async () => {
    const api = await request.newContext({ baseURL: API_BASE })

    const signIn = await api.post('/api/auth/sign-in/anonymous', { data: {} })
    expect(signIn.status()).toBe(200)
    const token = signIn.headers()['set-auth-token']
    expect(token).toBeTruthy()

    // get-session should work with Bearer token (used by iOS fetchUserInfo)
    // Use a fresh context to avoid cookie interference
    const bearerApi = await request.newContext({ baseURL: API_BASE })
    const session = await bearerApi.get('/api/auth/get-session', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(session.status()).toBe(200)
    const sessionJson = await session.json()
    expect(sessionJson?.user?.id).toBeTruthy()

    await bearerApi.dispose()
    await api.dispose()
  })

  test('passkey endpoints require signed session cookie for auth', async () => {
    const api = await request.newContext({ baseURL: API_BASE })
    const fakeClientDataJSON = Buffer.from(JSON.stringify({
      type: 'webauthn.create',
      challenge: 'invalid',
      origin: API_BASE,
    })).toString('base64url')

    // Sign in to get both raw and signed tokens
    const signIn = await api.post('/api/auth/sign-in/anonymous', { data: {} })
    expect(signIn.status()).toBe(200)
    const signInJson = await signIn.json()
    const rawToken = signInJson?.token
    const signedToken = signIn.headers()['set-auth-token']
    expect(rawToken).toBeTruthy()
    expect(signedToken).toBeTruthy()
    expect(rawToken).not.toBe(signedToken) // signed has HMAC suffix

    const freshApi = await request.newContext({ baseURL: API_BASE })

    // list-user-passkeys works with Bearer only (read endpoint)
    const listBearer = await freshApi.get('/api/auth/passkey/list-user-passkeys', {
      headers: { Authorization: `Bearer ${rawToken}` },
    })
    expect(listBearer.status()).toBe(200)

    // generate-register-options works with Bearer only
    const opts = await freshApi.get(
      '/api/auth/passkey/generate-register-options?authenticatorAttachment=platform',
      { headers: { Authorization: `Bearer ${rawToken}`, Origin: API_BASE } },
    )
    expect(opts.status()).toBe(200)

    // Extract challenge cookie from options response
    const challengeCookie = opts
      .headersArray()
      .filter(h => h.name.toLowerCase() === 'set-cookie')
      .map(h => h.value.split(';')[0])
      .find(c => c.includes('passkey'))
    expect(challengeCookie).toBeTruthy()

    // verify-registration with Bearer + raw token cookie = 401 (raw token rejected as cookie)
    const verifyRaw = await freshApi.post('/api/auth/passkey/verify-registration', {
      headers: {
        Authorization: `Bearer ${rawToken}`,
        Origin: API_BASE,
        'Content-Type': 'application/json',
        Cookie: `better-auth.session_token=${rawToken}; ${challengeCookie}`,
      },
      data: {
        response: { id: 'test', rawId: 'test', type: 'public-key',
          response: { clientDataJSON: fakeClientDataJSON, attestationObject: 'test' },
          authenticatorAttachment: 'platform', clientExtensionResults: {} },
        name: 'test',
      },
    })
    // Was 401: verify-registration used to sit behind freshSessionMiddleware, so an
    // unsigned token was rejected before the body was ever examined. Registration is
    // now sessionless by design (#271), the middleware is gone, and the request gets
    // as far as decoding the deliberately fake WebAuthn payload. 401 here would now
    // mean the sessionless path had regressed.
    expect(verifyRaw.status()).not.toBe(401)
    expect(verifyRaw.status()).toBeGreaterThanOrEqual(400)

    // verify-registration with Bearer + signed token cookie = 400 (auth passes, fake data rejected)
    const verifySigned = await freshApi.post('/api/auth/passkey/verify-registration', {
      headers: {
        Authorization: `Bearer ${rawToken}`,
        Origin: API_BASE,
        'Content-Type': 'application/json',
        Cookie: `better-auth.session_token=${signedToken}; __Secure-better-auth.session_token=${signedToken}; ${challengeCookie}`,
      },
      data: {
        response: { id: 'test', rawId: 'test', type: 'public-key',
          response: { clientDataJSON: fakeClientDataJSON, attestationObject: 'test' },
          authenticatorAttachment: 'platform', clientExtensionResults: {} },
        name: 'test',
      },
    })
    // 400 or 500 = auth passed (bad WebAuthn data), NOT 401
    expect(verifySigned.status()).not.toBe(401)

    await freshApi.dispose()
    await api.dispose()
  })

  test('mobile callback returns token that works as Bearer', async () => {
    // Sign in via cookies first (simulating web OAuth flow)
    const api = await request.newContext({ baseURL: API_BASE })
    const signIn = await api.post('/api/auth/sign-in/anonymous', { data: {} })
    expect(signIn.status()).toBe(200)

    const authCookie = buildCookieHeader(
      signIn
        .headersArray()
        .filter(h => h.name.toLowerCase() === 'set-cookie')
        .map(h => h.value),
    )

    // Hit the mobile callback endpoint with the session cookie
    // This simulates what happens after OAuth redirect completes
    const callback = await api.get('/api/auth/mobile/callback', {
      headers: { cookie: authCookie },
      maxRedirects: 0,
    })
    // Should redirect to wingdex:// scheme
    expect([301, 302]).toContain(callback.status())
    const location = callback.headers()['location']
    expect(location).toContain('wingdex://')
    expect(location).toContain('token=')

    // Extract the token from the redirect URL
    const callbackURL = new URL(location!)
    const token = callbackURL.searchParams.get('token')
    const signedToken = callbackURL.searchParams.get('signed_token')
    expect(token).toBeTruthy()
    expect(signedToken).toBeTruthy()

    // The extracted token should work as a Bearer token
    const bearerApi = await request.newContext({ baseURL: API_BASE })
    const data = await bearerApi.get('/api/data/all', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(data.status()).toBe(200)
    const dataJson = await data.json()
    expect(Array.isArray(dataJson.outings)).toBe(true)

    // The signed token from the callback should work for passkey plugin endpoints.
    const passkeys = await bearerApi.get('/api/auth/passkey/list-user-passkeys', {
      headers: {
        Origin: API_BASE,
        Cookie: `better-auth.session_token=${signedToken}; __Secure-better-auth.session_token=${signedToken}`,
      },
    })
    expect(passkeys.status()).toBe(200)
    expect(Array.isArray(await passkeys.json())).toBe(true)

    await bearerApi.dispose()
    await api.dispose()
  })

  test('localhost mobile callback path returns app redirect for local cookies', async () => {
    const api = await request.newContext({ baseURL: API_BASE })

    const signIn = await api.post('/api/auth/sign-in/anonymous', { data: {} })
    expect(signIn.status()).toBe(200)

    const authCookie = buildCookieHeader(
      signIn
        .headersArray()
        .filter(h => h.name.toLowerCase() === 'set-cookie')
        .map(h => h.value),
    )

    const callback = await api.get('/api/auth/mobile/callback', {
      headers: { cookie: authCookie },
      maxRedirects: 0,
    })

    expect([301, 302]).toContain(callback.status())
    const location = callback.headers()['location']
    expect(location).toContain('wingdex://auth/callback?token=')
    expect(location).toContain('signed_token=')

    await api.dispose()
  })

  test('cookie auth still works for protected endpoints', async () => {
    const api = await request.newContext({ baseURL: API_BASE })

    const signIn = await api.post('/api/auth/sign-in/anonymous', { data: {} })
    expect(signIn.status()).toBe(200)

    const authCookie = buildCookieHeader(
      signIn
        .headersArray()
        .filter(h => h.name.toLowerCase() === 'set-cookie')
        .map(h => h.value),
    )

    // Cookie auth should work for data endpoints (web app uses cookies)
    const data = await api.get('/api/data/all', {
      headers: { cookie: authCookie },
    })
    expect(data.status()).toBe(200)
    const dataJson = await data.json()
    expect(Array.isArray(dataJson.outings)).toBe(true)

    // Cookie auth should work for get-session
    const session = await api.get('/api/auth/get-session', {
      headers: { cookie: authCookie },
    })
    expect(session.status()).toBe(200)
    const sessionJson = await session.json()
    expect(sessionJson?.user?.id).toBeTruthy()

    await api.dispose()
  })

  test('account merge origin checks keep same-origin requests and reject cross-origin requests', async () => {
    const api = await request.newContext({ baseURL: API_BASE })

    const sameOrigin = await api.post('/api/auth/merge/prepare', {
      headers: {
        'Content-Type': 'application/json',
        Origin: API_BASE,
      },
      data: { authMethod: 'passkey' },
    })
    expect(sameOrigin.status()).toBe(401)

    const crossOrigin = await api.post('/api/auth/merge/prepare', {
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://attacker.test',
      },
      data: { authMethod: 'passkey' },
    })
    expect(crossOrigin.status()).toBe(403)

    await api.dispose()
  })
})

test.describe('API smoke @live (preview auth)', () => {

  test('preview social OAuth emits hosted callback URI', async () => {
    const api = await request.newContext()

    const response = await api.post(`${PREVIEW_BASE}/api/auth/sign-in/social`, {
      headers: {
        'Content-Type': 'application/json',
        Origin: PREVIEW_BASE,
      },
      data: { provider: 'github' },
    })

    expect(response.status()).toBe(200)
    const body = await response.json() as { url?: string }
    expect(body.url).toBeTruthy()

    const redirectURI = new URL(body.url!).searchParams.get('redirect_uri')
    expect(redirectURI).toBe(`${PREVIEW_BASE}/api/auth/callback/github`)

    await api.dispose()
  })
})
