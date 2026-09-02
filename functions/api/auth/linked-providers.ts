import { createAuth } from '../../lib/auth'
import { createRouteResponder, createLogger } from '../../lib/log'

export const onRequestGet: ApiHandler = async context => {
  let route = createRouteResponder((context.data as RequestData).log, 'auth/linkedProviders/read', 'Application')
  let stage = 'authenticated session lookup'
  try {
    const auth = createAuth(context.env, { request: context.request })
    const session = await auth.api.getSession({ headers: context.request.headers })

    if (!session?.user?.id) {
      return route.fail(401, 'Unauthorized', 'Authentication is required to read linked providers')
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

    stage = 'linked provider database query'
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
    }), `Read ${providers.length} linked ${providers.length === 1 ? 'provider' : 'providers'}`)
  } catch {
    return route.fail(500, 'Internal server error', `Linked provider lookup failed during ${stage}`)
  }
}
