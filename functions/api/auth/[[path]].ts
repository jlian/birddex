import { createAuth, normalizeAuthRequest } from '../../lib/auth'
import { createRouteResponder, RESULT_TYPE_HEADER } from '../../lib/log'

type AuthRouteClass =
  | 'oauthStart'
  | 'oauthCallback'
  | 'session'
  | 'signOut'
  | 'passkey'
  | 'other'

function classifyAuthRoute(pathname: string): AuthRouteClass {
  if (pathname.includes('/sign-in/social') || pathname.includes('/signin/social')) return 'oauthStart'
  if (pathname.includes('/callback')) return 'oauthCallback'
  if (pathname.includes('/sign-out') || pathname.includes('/signout')) return 'signOut'
  if (pathname.includes('/session')) return 'session'
  if (pathname.includes('/passkey')) return 'passkey'
  return 'other'
}

function describeAuthOutcome(method: string, routeClass: AuthRouteClass, status: number, semanticFailure: boolean): string {
  const routeLabel = routeClass === 'oauthStart'
    ? 'oauth start'
    : routeClass === 'oauthCallback'
      ? 'oauth callback'
      : routeClass === 'signOut'
        ? 'sign-out'
        : routeClass === 'session'
          ? 'session'
          : routeClass === 'passkey'
            ? 'passkey'
            : 'auth'
  if (semanticFailure) {
    return `Handled ${routeLabel} route via ${method} with semantic failure (HTTP ${status})`
  }
  if (status >= 400) {
    return `Handled ${routeLabel} route via ${method} with HTTP ${status}`
  }
  if (status >= 300) {
    return `Handled ${routeLabel} route via ${method} with redirect HTTP ${status}`
  }
  return `Handled ${routeLabel} route via ${method} with HTTP ${status}`
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const route = createRouteResponder((context.data as RequestData).log, 'auth/sessions/invoke', 'Application')
  // Generic auth routes rely on request, forwarded, and referer headers to
  // decide whether the public origin is localhost or a hosted dev domain.
  // Do not force hosted mode here or localhost web OAuth callbacks will fail
  // state validation.
  const request = normalizeAuthRequest(context.env, context.request)
  const auth = createAuth(context.env, { request, log: (context.data as RequestData).log })
  const response = await auth.handler(request)

  const { pathname } = new URL(request.url)
  const routeClass = classifyAuthRoute(pathname)
  const semanticFailure = response.status >= 300 && response.status < 400 && routeClass === 'oauthCallback'
    && (response.headers.get('location') || '').toLowerCase().includes('error=')
  const completed = route.complete(
    response,
    describeAuthOutcome(request.method, routeClass, response.status, semanticFailure),
  )
  if (semanticFailure) {
    completed.headers.set(RESULT_TYPE_HEADER, 'Failed')
  }
  return completed
}
