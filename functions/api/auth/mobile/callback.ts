/**
 * Mobile OAuth callback bridge.
 *
 * After a social OAuth flow (GitHub / Apple), Better Auth creates a session,
 * sets a session cookie, and redirects the user to the configured callbackURL.
 * For mobile clients, that callbackURL points here.
 *
 * This handler reads the session via cookie, extracts the raw session token,
 * and redirects to the app's custom URL scheme with the token + user info
 * so ASWebAuthenticationSession can capture it.
 *
 * The iOS app stores this token in Keychain and sends it as
 * Authorization: Bearer on all subsequent requests. The bearer() plugin
 * on the server validates it natively.
 *
 * Flow:
 *   1. iOS opens /api/auth/signin/github?callbackURL=/api/auth/mobile/callback
 *   2. OAuth happens... Better Auth sets cookie + redirects here
 *   3. We read the session, redirect to wingdex://auth/callback?token=...
 *   4. ASWebAuthenticationSession captures the custom scheme URL
 */
import { createAuth } from '../../../lib/auth'
import { createRouteResponder, createLogger } from '../../../lib/log'

const APP_SCHEME = 'wingdex'

function extractSignedSessionToken(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null

  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim()
    if (!trimmed) continue

    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex === -1) continue

    const name = trimmed.slice(0, separatorIndex)
    if (name !== 'better-auth.session_token' && name !== '__Secure-better-auth.session_token') {
      continue
    }

    return trimmed.slice(separatorIndex + 1)
  }

  return null
}

export const onRequestGet: ApiHandler = async (context) => {
  let route = createRouteResponder((context.data as RequestData).log, 'auth/mobileOAuth/invoke', 'Application')
  // Try default mode first so localhost e2e/local cookies keep working.
  // If that does not resolve a session but the request carries a secure hosted
  // session cookie, retry in hosted-oauth mode so Better Auth uses the hosted
  // secure-cookie semantics needed by the mobile social OAuth flow.
  let auth = createAuth(context.env, { request: context.request })
  let session = await auth.api.getSession({ headers: context.request.headers })
  const cookieHeader = context.request.headers.get('cookie')
  const hasSecureSessionCookie = cookieHeader?.includes('__Secure-better-auth.session_token=') ?? false
  if (!session && hasSecureSessionCookie) {
    auth = createAuth(context.env, { request: context.request, mode: 'hosted-oauth' })
    session = await auth.api.getSession({ headers: context.request.headers })
  }

  if (!session?.user?.id || !session?.session?.token) {
    const errorUrl = `${APP_SCHEME}://auth/callback?error=no_session`
    return route.failWithHeaders(
      302,
      '',
      { Location: errorUrl },
      'Mobile OAuth callback failed because no session could be resolved from callback cookies',
    )
  }

  // Enrich logger with userId after auth (middleware skips session check for /api/auth/* routes)
  const enrichedLog = createLogger({
    env: context.env,
    traceId: (context.data as RequestData).traceId || '',
    spanId: (context.data as RequestData).spanId || '',
    userId: session.user.id,
    identity: { authMethod: 'session' },
    resourceId: `/users/${session.user.id}`,
  })
  route = createRouteResponder(enrichedLog, 'auth/mobileOAuth/invoke', 'Application')

  // Build callback URL with proper percent-encoding (not form-encoding).
  // URLSearchParams encodes spaces as + which Swift's URLComponents doesn't decode.
  // Use encodeURIComponent instead which produces %20 for spaces.
  const p = (key: string, value: string) => `${key}=${encodeURIComponent(value)}`
  const parts = [
    p('token', session.session.token),
    p('expires_at', session.session.expiresAt.toISOString()),
    p('user_id', session.user.id),
    p('user_name', session.user.name || ''),
    p('user_email', session.user.email || ''),
  ]
  const signedToken = extractSignedSessionToken(cookieHeader)
  if (signedToken) {
    parts.push(p('signed_token', signedToken))
  }
  if (session.user.image) {
    parts.push(p('user_image', session.user.image))
  }

  const callbackUrl = `${APP_SCHEME}://auth/callback?${parts.join('&')}`
  return route.complete(
    Response.redirect(callbackUrl, 302),
    'Completed mobile OAuth callback redirect to app scheme',
  )
}
