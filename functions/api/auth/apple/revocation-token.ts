import { createAuth } from '../../../lib/auth'
import { createLogger, createRouteResponder, type Logger } from '../../../lib/log'
import {
  exchangeAppleAuthorizationCode,
  ProviderRevocationError,
  storeNativeAppleRevocationCredentials,
} from '../../../lib/provider-revocation'

export function logNativeAppleRevocationCredentialStorage(log: Logger): void {
  log.info('auth/appleRevocationToken/write', {
    category: 'Application',
    resultType: 'Succeeded',
    resultDescription: 'Durably stored native Apple revocation credentials for future account deletion',
  })
}

export const onRequestPost: PagesFunction<Env> = async context => {
  let route = createRouteResponder((context.data as RequestData).log, 'auth/appleRevocationToken/write', 'Application')
  const auth = createAuth(context.env, { request: context.request })
  const session = await auth.api.getSession({ headers: context.request.headers })
  if (!session?.user?.id) {
    return route.fail(401, 'Unauthorized', 'Apple credential capture requires an authenticated session')
  }

  const log = createLogger({
    env: context.env,
    traceId: (context.data as RequestData).traceId || '',
    spanId: (context.data as RequestData).spanId || '',
    userId: session.user.id,
    identity: { authMethod: 'bearer' },
    resourceId: `/users/${session.user.id}`,
  })
  route = createRouteResponder(log, 'auth/appleRevocationToken/write', 'Application')

  let body: { authorizationCode?: unknown } | null
  try {
    body = await context.request.json()
  } catch {
    return route.fail(400, 'Invalid JSON body', 'Apple credential capture could not parse the request; retry native sign-in')
  }
  if (typeof body?.authorizationCode !== 'string' || body.authorizationCode.length < 8 || body.authorizationCode.length > 4096) {
    return route.fail(400, 'Invalid Apple authorization code', 'Native sign-in did not provide a valid one-time code; restart Sign in with Apple')
  }
  if (!context.env.APPLE_APP_CLIENT_SECRET) {
    return route.fail(503, 'Native Apple credential capture is not configured', 'APPLE_APP_CLIENT_SECRET is missing; run the Apple secret rotation workflow')
  }

  try {
    const tokens = await exchangeAppleAuthorizationCode(
      body.authorizationCode,
      context.env.APPLE_APP_CLIENT_SECRET,
    )
    const stored = await storeNativeAppleRevocationCredentials(
      context.env.DB,
      session.user.id,
      tokens,
    )
    if (!stored) {
      return route.fail(409, 'Apple account is not linked', 'Apple token exchange succeeded but no linked Apple account was found; restart native sign-in')
    }
    logNativeAppleRevocationCredentialStorage(log)
    return route.complete(
      Response.json({ success: true }, { headers: { 'Cache-Control': 'no-store' } }),
      'Completed native Apple revocation credential capture; durable storage is recorded as an Application event',
    )
  } catch (error) {
    if (error instanceof ProviderRevocationError) {
      return route.fail(502, 'Apple credential capture failed', `Apple token exchange failed with HTTP ${error.status || 'unknown'}`)
    }
    return route.fail(500, 'Apple credential capture failed', 'Apple credential storage failed unexpectedly; inspect the trace and retry native sign-in')
  }
}