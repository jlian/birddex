/**
 * Mobile OAuth entry point.
 *
 * ASWebAuthenticationSession opens a URL in a browser - it cannot POST.
 * Better Auth's sign-in/social endpoint expects POST with JSON body and
 * returns { url, redirect: true } plus state/PKCE cookies.
 *
 * This GET handler proxies that internally: it POSTs to Better Auth,
 * captures the redirect URL and Set-Cookie headers, then returns a 302
 * so the browser follows the OAuth flow with the correct cookies.
 *
 * Flow:
 *   1. iOS opens GET /api/auth/mobile/start?provider=github
 *   2. This handler POSTs to Better Auth sign-in/social internally
 *   3. Better Auth returns { url } + sets state cookies
 *   4. We 302 redirect the browser to the OAuth provider, forwarding cookies
 *   5. OAuth flow proceeds... ends at /api/auth/mobile/callback
 */
import { createAuth } from '../../../lib/auth'
import { accountMergeSourceBearer, type AccountMergeAuthMethod } from '../../../lib/account-merge-intent'
import { createRouteResponder } from '../../../lib/log'

export const onRequestGet: ApiHandler = async (context) => {
  const route = createRouteResponder((context.data as RequestData).log, 'auth/mobileOAuth/invoke', 'Application')
  const url = new URL(context.request.url)
  const provider = url.searchParams.get('provider')

  if (!provider) {
    return route.fail(400, 'Missing provider parameter', 'Missing provider query parameter for mobile OAuth')
  }

  const allowedProviders = new Set(['github', 'apple', 'google'])
  if (!allowedProviders.has(provider)) {
    return route.fail(
      400,
      'Unsupported provider parameter',
      'Unsupported OAuth provider; allowed providers are github, apple, and google',
    )
  }

  const mergeToken = url.searchParams.get('merge_token')
  let sourceBearer: string | null = null
  if (mergeToken) {
    sourceBearer = await accountMergeSourceBearer(
      context.env.DB,
      mergeToken,
      provider as AccountMergeAuthMethod,
    )
    if (!sourceBearer) {
      return route.fail(401, 'Invalid account merge token', 'Mobile OAuth requires a live merge intent bound to the current anonymous session and provider')
    }
  }

  // Mobile social OAuth must start in hosted-oauth mode so the provider sees
  // the same public callback origin that is configured in the provider app.
  const auth = createAuth(context.env, { request: context.request, mode: 'hosted-oauth' })

  // Build a synthetic POST to Better Auth's sign-in/social endpoint
  const signInUrl = new URL('/api/auth/sign-in/social', url.origin)
  const requestHeaders = new Headers({
    'Content-Type': 'application/json',
    Origin: url.origin,
    Cookie: context.request.headers.get('Cookie') || '',
  })
  if (sourceBearer) requestHeaders.set('Authorization', `Bearer ${sourceBearer}`)
  const internalReq = new Request(signInUrl.toString(), {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify({
      provider,
      callbackURL: '/api/auth/mobile/callback',
    }),
  })

  const response = await auth.handler(internalReq)

  // Better Auth may return either:
  // 1. JSON { url, redirect: true } with Set-Cookie (newer versions)
  // 2. A 302 redirect with Location header (some configurations)
  let redirectUrl: string

  if (response.status >= 300 && response.status < 400) {
    // 302 redirect - read Location header
    redirectUrl = response.headers.get('Location') || ''
  } else {
    // JSON response
    try {
      const json = (await response.json()) as { url?: string; redirect?: boolean }
      redirectUrl = json.url || ''
    } catch {
      return route.fail(500, 'Invalid response from auth', `Better Auth returned an unparseable response for provider ${provider}; check BETTER_AUTH_URL and provider configuration`, { provider })
    }
  }

  if (!redirectUrl) {
    return route.fail(500, 'No redirect URL from auth provider', `Better Auth returned no redirect URL for provider ${provider}; the provider may not be configured or the callbackURL may be wrong`, { provider })
  }

  // Build a 302 redirect, forwarding all Set-Cookie headers from Better Auth
  // so the browser has the state/PKCE cookies for the OAuth callback
  const headers = new Headers({ Location: redirectUrl })
  const setCookies = response.headers.getSetCookie?.() ?? []
  for (const cookie of setCookies) {
    headers.append('Set-Cookie', cookie)
  }

  // Fallback: if getSetCookie isn't available, iterate manually
  if (setCookies.length === 0) {
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'set-cookie') {
        headers.append('Set-Cookie', value)
      }
    })
  }

  return route.complete(new Response(null, { status: 302, headers }), `Started mobile OAuth flow for provider ${provider}`)
}
