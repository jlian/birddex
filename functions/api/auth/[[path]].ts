import { createAuth, normalizeAuthRequest } from '../../lib/auth'
import { createRouteResponder, RESULT_TYPE_HEADER, type Logger } from '../../lib/log'

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
  if (semanticFailure) {
    return `Social provider callback returned an authentication failure redirect with HTTP ${status}; no callback URL or provider response was logged`
  }
  if (status >= 400) {
    const operation = routeClass === 'oauthStart' ? 'Social provider authorization start'
      : routeClass === 'oauthCallback' ? 'Social provider callback'
        : routeClass === 'signOut' ? 'Sign-out request'
          : routeClass === 'session' ? 'Session request'
            : routeClass === 'passkey' ? 'Passkey request'
              : 'Authentication request'
    return `${operation} failed via ${method} with HTTP ${status}; sensitive provider and credential details were omitted`
  }
  if (status >= 300) {
    return routeClass === 'oauthStart'
      ? `Started social provider authorization and returned redirect HTTP ${status}`
      : routeClass === 'oauthCallback'
        ? `Completed social provider callback processing and returned redirect HTTP ${status}`
        : `Authentication request via ${method} returned redirect HTTP ${status}`
  }
  if (routeClass === 'session') return `Read or refreshed the current authentication session via ${method} with HTTP ${status}`
  if (routeClass === 'signOut') return `Completed sign-out route via ${method} with HTTP ${status}; confirmed server session deletion is logged separately`
  if (routeClass === 'passkey') return `Completed passkey route via ${method} with HTTP ${status}; durable passkey changes are logged separately`
  if (routeClass === 'oauthCallback') return `Completed social provider callback processing via ${method} with HTTP ${status}`
  if (routeClass === 'oauthStart') return `Completed social provider authorization start via ${method} with HTTP ${status}`
  return `Completed authentication route via ${method} with HTTP ${status}`
}

export function logDurableAuthRouteOutcome(
  log: Logger | undefined,
  method: string,
  pathname: string,
  status: number,
): void {
  if (!log || method !== 'POST' || status < 200 || status >= 300) return
  if (pathname.endsWith('/passkey/verify-registration')) {
    log.info('auth/passkey/create', {
      category: 'Application',
      resultType: 'Succeeded',
      resultDescription: 'Registered and durably stored a passkey for the authenticated account',
    })
  } else if (pathname.endsWith('/passkey/delete-passkey')) {
    log.info('auth/passkey/delete', {
      category: 'Application',
      resultType: 'Succeeded',
      resultDescription: 'Deleted a passkey owned by the authenticated account',
    })
  }
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
  logDurableAuthRouteOutcome(
    (context.data as RequestData).log,
    request.method,
    pathname,
    response.status,
  )
  const completed = route.complete(
    response,
    describeAuthOutcome(request.method, routeClass, response.status, semanticFailure),
  )
  if (semanticFailure) {
    completed.headers.set(RESULT_TYPE_HEADER, 'Failed')
  }
  return completed
}
