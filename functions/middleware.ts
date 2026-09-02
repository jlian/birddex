import { createAuth } from './lib/auth'
import { createLogger, requestCompletionLevel, RESULT_DESCRIPTION_HEADER, RESULT_TYPE_HEADER } from './lib/log'
import type { Category, Identity, ResultType } from './lib/log'
import { parseTraceparent, generateTraceContext, childSpanId, formatTraceparent } from './lib/trace-context'

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'])

/** Max request body sizes in bytes, keyed by path prefix. */
const BODY_LIMITS: Array<{ prefix: string; maxBytes: number }> = [
  { prefix: '/api/import/', maxBytes: 10 * 1024 * 1024 }, // 10 MB (CSV)
]
const DEFAULT_BODY_LIMIT = 1 * 1024 * 1024 // 1 MB for all other API routes

/** Path prefixes that require a registered account rather than any session. */
const ACCOUNT_ONLY_PREFIXES = ['/api/import/', '/api/export/outing/', '/api/export/dex']

/** Route map: pathname prefix + optional method -> operationName + category.
 *  Ordered longest-prefix-first so /api/data/outings/ beats /api/data/outings. */
const ROUTE_MAP: Array<{ prefix: string; route: string; method?: string; op: string; category: Category }> = [
  { prefix: '/api/health', route: '/api/health', op: 'health/database/read', category: 'Application' },
  { prefix: '/api/data/outings/', route: '/api/data/outings/:id', method: 'DELETE', op: 'data/outings/delete', category: 'Application' },
  { prefix: '/api/data/outings/', route: '/api/data/outings/:id', method: 'PATCH', op: 'data/outings/write', category: 'Application' },
  { prefix: '/api/data/outings', route: '/api/data/outings', method: 'POST', op: 'data/outings/write', category: 'Application' },
  { prefix: '/api/data/observations', route: '/api/data/observations', method: 'POST', op: 'data/observations/write', category: 'Application' },
  { prefix: '/api/data/observations', route: '/api/data/observations', method: 'PATCH', op: 'data/observations/write', category: 'Application' },
  { prefix: '/api/data/photos', route: '/api/data/photos', method: 'POST', op: 'data/photos/write', category: 'Application' },
  { prefix: '/api/data/dex', route: '/api/data/dex', method: 'GET', op: 'data/dex/read', category: 'Application' },
  { prefix: '/api/data/dex', route: '/api/data/dex', method: 'PATCH', op: 'data/dex/write', category: 'Application' },
  { prefix: '/api/data/clear', route: '/api/data/clear', method: 'DELETE', op: 'data/clear/delete', category: 'Audit' },
  { prefix: '/api/data/all', route: '/api/data/all', method: 'GET', op: 'data/all/read', category: 'Application' },
  { prefix: '/api/auth/linked-providers', route: '/api/auth/linked-providers', op: 'auth/linkedProviders/read', category: 'Application' },
  { prefix: '/api/auth/apple/revocation-token', route: '/api/auth/apple/revocation-token', op: 'auth/appleRevocationToken/write', category: 'Application' },
  { prefix: '/api/auth/delete-account', route: '/api/auth/delete-account', op: 'auth/account/delete', category: 'Application' },
  { prefix: '/api/auth/mobile/start', route: '/api/auth/mobile/start', op: 'auth/mobileOAuth/invoke', category: 'Application' },
  { prefix: '/api/auth/mobile/callback', route: '/api/auth/mobile/callback', op: 'auth/mobileOAuth/invoke', category: 'Application' },
  { prefix: '/api/auth/', route: '/api/auth/:path', op: 'auth/sessions/invoke', category: 'Application' },
  { prefix: '/api/import/ebird-csv', route: '/api/import/ebird-csv', op: 'import/ebirdCsv/import', category: 'Application' },
  { prefix: '/api/export/outing/', route: '/api/export/outing/:id', op: 'export/outingCsv/export', category: 'Application' },
  { prefix: '/api/export/dex', route: '/api/export/dex', op: 'export/dex/export', category: 'Application' },
  { prefix: '/api/export/sightings', route: '/api/export/sightings', op: 'export/sightings/export', category: 'Application' },
  { prefix: '/api/species/search', route: '/api/species/search', op: 'species/search/read', category: 'Application' },
  { prefix: '/api/species/ebird-code', route: '/api/species/ebird-code', op: 'species/ebirdCode/read', category: 'Application' },
  { prefix: '/api/species/wiki-title', route: '/api/species/wiki-title', op: 'species/wikiTitle/read', category: 'Application' },
  { prefix: '/api/geocoding/reverse', route: '/api/geocoding/reverse', op: 'geocoding/reverse/read', category: 'Application' },
  { prefix: '/api/geocoding/search', route: '/api/geocoding/search', op: 'geocoding/search/read', category: 'Application' },
]

export function resolveOperation(pathname: string, method: string): { op: string; category: Category; route: string } {
  for (const route of ROUTE_MAP) {
    const isCatchAll = route.prefix === '/api/auth/'
    const isDynamicSegment = route.prefix.endsWith('/') && !isCatchAll
    const remainder = isDynamicSegment ? pathname.slice(route.prefix.length) : ''
    const pathMatches = isCatchAll
      ? pathname.startsWith(route.prefix)
      : isDynamicSegment
        ? pathname.startsWith(route.prefix) && remainder.length > 0 && !remainder.includes('/')
        : pathname === route.prefix
    if (pathMatches && (!route.method || route.method === method)) {
      return { op: route.op, category: route.category, route: route.route }
    }
  }
  return { op: 'requests/unknown', category: 'Application', route: '/api/:unknown' }
}

/** Extract entity ID segment from dynamic route paths for resourceId. */
export function extractEntitySegment(pathname: string): string | null {
  const generatedOutingId = /^outing_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  const outingMatch = pathname.match(/^\/api\/data\/outings\/([^/]+)$/)
  if (outingMatch && generatedOutingId.test(outingMatch[1])) return `outings/${outingMatch[1]}`
  const exportOutingMatch = pathname.match(/^\/api\/export\/outing\/([^/]+)$/)
  if (exportOutingMatch && generatedOutingId.test(exportOutingMatch[1])) return `outings/${exportOutingMatch[1]}`
  return null
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
}

/** Append security headers to an existing Response without cloning the body. */
function withSecurityHeaders(response: Response): Response {
  const patched = new Response(response.body, response)
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    patched.headers.set(key, value)
  }
  return patched
}

/** Create an error Response with security headers applied. */
function errorResponse(body: string, status: number, extraHeaders?: Record<string, string>): Response {
  const response = new Response(body, { status })
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(key, value)
  }
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      response.headers.set(key, value)
    }
  }
  return response
}

export const onRequest: ApiMiddleware = async (context) => {
  const { pathname } = new URL(context.request.url)

  // Non-API requests -- pass through with security headers only.
  if (!pathname.startsWith('/api/')) {
    return withSecurityHeaders(await context.next())
  }

  // --- Trace context ---
  const incoming = parseTraceparent(context.request.headers.get('traceparent'))
  const traceCtx = incoming
    ? { traceId: incoming.traceId, spanId: childSpanId(), traceFlags: incoming.traceFlags }
    : generateTraceContext()
  const method = context.request.method
  const hasBearer = !!context.request.headers.get('authorization')
  const hasCookie = !!context.request.headers.get('cookie')
  const { op, category: routeCategory, route: routeTemplate } = resolveOperation(pathname, method)

  // Build logger with pre-auth identity (no userId yet)
  let log = createLogger({
    env: context.env,
    traceId: traceCtx.traceId,
    spanId: traceCtx.spanId,
    identity: { authMethod: hasBearer ? 'bearer' : hasCookie ? 'session' : 'none' },
  })

  context.data.traceId = traceCtx.traceId
  context.data.spanId = traceCtx.spanId
  context.data.traceFlags = traceCtx.traceFlags
  context.data.log = log
  context.data.operationName = op
  context.data.category = routeCategory

  const start = Date.now()

  // --- HTTP method validation ---
  if (!ALLOWED_METHODS.has(method)) {
    log.warn('requests/validation/validate', { category: 'Request', resultType: 'Failed', resultSignature: 405, resultDescription: 'Request used an unsupported HTTP method; use GET, POST, PATCH, DELETE, or OPTIONS', durationMs: Date.now() - start })
    const methodResponse = errorResponse('Method Not Allowed', 405, {
      Allow: Array.from(ALLOWED_METHODS).join(', '),
    })
    addTraceHeaders(methodResponse, traceCtx)
    return methodResponse
  }

  // --- Request body size limit ---
  const rawContentLength = context.request.headers.get('content-length')
  const hasBodyMethod = method !== 'GET' && method !== 'OPTIONS'

  if (hasBodyMethod && rawContentLength !== null) {
    const parsedLength = Number(rawContentLength)
    if (!Number.isFinite(parsedLength) || parsedLength < 0) {
      log.warn('requests/validation/validate', { category: 'Request', resultType: 'Failed', resultSignature: 400, resultDescription: 'Content-Length header is not a valid non-negative number', durationMs: Date.now() - start })
      const clResponse = errorResponse('Invalid Content-Length', 400)
      addTraceHeaders(clResponse, traceCtx)
      return clResponse
    }
    if (parsedLength > 0) {
      const limit =
        BODY_LIMITS.find((b) => pathname.startsWith(b.prefix))?.maxBytes ?? DEFAULT_BODY_LIMIT
      if (parsedLength > limit) {
        log.warn('requests/validation/validate', { category: 'Request', resultType: 'Failed', resultSignature: 413, resultDescription: `Request body exceeded the configured route limit`, durationMs: Date.now() - start, properties: { contentLength: parsedLength, limit } })
        const sizeResponse = errorResponse('Payload Too Large', 413)
        addTraceHeaders(sizeResponse, traceCtx)
        return sizeResponse
      }
    }
  }

  // Auth routes and health endpoint -- skip session check but still apply security headers + tracing.
  if (pathname.startsWith('/api/auth') || pathname === '/api/health') {
    try {
      const response = withSecurityHeaders(await context.next())
      addTraceHeaders(response, traceCtx)
      // Suppress completion log for /api/health (internal infra polling, not user-triggered)
      if (pathname !== '/api/health') {
        context.waitUntil(emitCompletionLog(log, op, response, Date.now() - start, method, routeTemplate, takeOutcomeMetadata(response)))
      } else {
        const outcome = takeOutcomeMetadata(response)
        if (!response.ok) {
          // Always log health failures
          context.waitUntil(emitCompletionLog(log, op, response, Date.now() - start, method, routeTemplate, outcome))
        }
      }
      return response
    } catch (err) {
      return handleUnexpectedError(err, log, traceCtx, op, start)
    }
  }

  try {
    const auth = createAuth(context.env, { request: context.request })

  const session = await auth.api.getSession({
    headers: context.request.headers,
  })

  if (!session) {
    log.warn('auth/sessions/validate', { category: 'Request', resultType: 'Failed', resultSignature: 401, resultDescription: 'No valid session cookie or bearer token; check that the request includes session cookies or an Authorization: Bearer header', durationMs: Date.now() - start, properties: { hasBearer } })
    const authResponse = errorResponse('Unauthorized', 401)
    addTraceHeaders(authResponse, traceCtx)
    return authResponse
  }

  context.data.user = {
    ...session.user,
    isAnonymous: session.user.isAnonymous ?? undefined,
  }
  context.data.session = session.session

  // Re-create logger with full identity + resourceId
  const identity: Identity = {
    isAnonymous: !!(session.user as { isAnonymous?: boolean }).isAnonymous,
    authMethod: hasBearer ? 'bearer' : hasCookie ? 'session' : 'none',
  }
  let resourceId = `/users/${session.user.id}`
  const entitySegment = extractEntitySegment(pathname)
  if (entitySegment) resourceId += `/${entitySegment}`
  context.data.autoScopedResourceId = !!entitySegment

  log = createLogger({
    env: context.env,
    traceId: traceCtx.traceId,
    spanId: traceCtx.spanId,
    userId: session.user.id,
    identity,
    resourceId,
  })
  context.data.log = log

  // Routes that need a real account, not just a session. The UI already keeps
  // these behind sign-up, but that gate is cosmetic on its own: an anonymous
  // session can call the endpoint directly. Import is the heaviest write path
  // an account can reach, so the gate is enforced here too.
  //
  // Anonymous sightings export remains available as a recovery fallback.
  // Ordinary outing and dex exports require a registered account like import
  // and Settings.
  if (identity.isAnonymous && ACCOUNT_ONLY_PREFIXES.some(prefix => pathname.startsWith(prefix))) {
    log.warn('auth/sessions/validate', { category: 'Request', resultType: 'Failed', resultSignature: 403, resultDescription: 'Route requires a registered account; the request carried an anonymous session', durationMs: Date.now() - start })
    const accountResponse = errorResponse('Account required', 403)
    addTraceHeaders(accountResponse, traceCtx)
    return accountResponse
  }

    const response = withSecurityHeaders(await context.next())
    addTraceHeaders(response, traceCtx)
    context.waitUntil(emitCompletionLog(log, op, response, Date.now() - start, method, routeTemplate, takeOutcomeMetadata(response)))
    return response
  } catch (err) {
    return handleUnexpectedError(err, log, traceCtx, op, start)
  }
}

/** Emit the single request-lifecycle completion log with dynamic level. */
function takeOutcomeMetadata(response: Response): { resultDescription?: string; resultType?: ResultType } {
  const resultDescription = response.headers.get(RESULT_DESCRIPTION_HEADER) || undefined
  const rawResultType = response.headers.get(RESULT_TYPE_HEADER)
  const resultType = rawResultType === 'Succeeded' || rawResultType === 'Failed'
    ? rawResultType
    : undefined
  response.headers.delete(RESULT_DESCRIPTION_HEADER)
  response.headers.delete(RESULT_TYPE_HEADER)
  return { resultDescription, resultType }
}

async function emitCompletionLog(
  log: ReturnType<typeof createLogger>,
  op: string,
  response: Response,
  durationMs: number,
  method: string,
  routeTemplate: string,
  outcome?: { resultDescription?: string; resultType?: ResultType },
): Promise<void> {
  const status = response.status
  const resultType = outcome?.resultType || (status < 400 ? 'Succeeded' : 'Failed')
  const resultDescription = outcome?.resultDescription || (resultType === 'Succeeded'
    ? `${op} completed successfully`
    : `${op} failed with HTTP ${status}`)
  const fields = { category: 'Request' as const, resultType: resultType as 'Succeeded' | 'Failed', resultSignature: status, resultDescription, durationMs, properties: { 'http.method': method, 'http.route': routeTemplate } }
  const level = requestCompletionLevel(status, resultType)
  if (level === 'Error') {
    log.error(op, fields)
  } else if (level === 'Warning') {
    log.warn(op, fields)
  } else {
    log.info(op, fields)
  }
}

/** Add W3C Trace Context response headers. */
function addTraceHeaders(response: Response, ctx: { traceId: string; spanId: string; traceFlags: string }): void {
  response.headers.set('traceparent', formatTraceparent(ctx))
  response.headers.set('X-Trace-Id', ctx.traceId)
}

/** Catch-all for unhandled errors in route handlers. */
function handleUnexpectedError(
  err: unknown,
  log: ReturnType<typeof createLogger>,
  traceCtx: { traceId: string; spanId: string; traceFlags: string },
  operationName: string,
  start: number,
): Response {
  void err
  log.error(operationName, {
    category: 'Request',
    resultType: 'Failed',
    resultSignature: 500,
    resultDescription: 'Unhandled route error; inspect the result signature and trace ID, then retry or investigate the route implementation',
    durationMs: Date.now() - start,
  })
  const response = errorResponse('Internal Server Error', 500)
  addTraceHeaders(response, traceCtx)
  return response
}
