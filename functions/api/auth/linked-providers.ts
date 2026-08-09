import { createAuth } from '../../lib/auth'
import { createRouteResponder, createLogger } from '../../lib/log'

export const onRequestGet: PagesFunction<Env> = async context => {
  let route = createRouteResponder((context.data as RequestData).log, 'auth/linkedProviders/read', 'Application')
  const auth = createAuth(context.env, { request: context.request })
  const session = await auth.api.getSession({ headers: context.request.headers })

  if (!session?.user?.id) {
    return route.fail(401, 'Unauthorized', 'Linked provider lookup requires an authenticated session')
  }

  // Enrich logger with userId after auth (middleware skips session check for /api/auth/* routes)
  const log = (context.data as RequestData).log
  const enrichedLog = log ? createLogger({
    env: context.env,
    traceId: (context.data as RequestData).traceId || '',
    spanId: (context.data as RequestData).spanId || '',
    userId: session.user.id,
    identity: { authMethod: 'session' },
    resourceId: `/users/${session.user.id}`,
  }) : undefined
  route = createRouteResponder(enrichedLog, 'auth/linkedProviders/read', 'Application')

  try {

  const result = await context.env.DB
    .prepare('SELECT providerId FROM account WHERE userId = ?')
    .bind(session.user.id)
    .all<{ providerId?: string | null }>()

  const providers = Array.from(
    new Set(
      result.results
        .map(row => row.providerId)
        .filter((providerId): providerId is string => Boolean(providerId))
    )
  )
  return route.complete(Response.json({ providers }, {
    headers: { 'cache-control': 'no-store' },
  }), `Fetched ${providers.length} linked auth providers`)
  } catch {
    return route.fail(500, 'Internal server error', 'Linked provider lookup failed; inspect the trace and authentication database operation')
  }
}
