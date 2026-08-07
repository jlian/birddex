import { createAuth } from '../../lib/auth'
import { createLogger, createRouteResponder } from '../../lib/log'
import { ProviderRevocationError, revokeProvidersAndDeleteUser } from '../../lib/provider-revocation'

export const onRequestPost: PagesFunction<Env> = async context => {
  const auth = createAuth(context.env, { request: context.request })
  const session = await auth.api.getSession({ headers: context.request.headers })
  if (!session?.user?.id) return new Response('Unauthorized', { status: 401 })

  const log = createLogger({
    env: context.env,
    traceId: (context.data as RequestData).traceId || '',
    spanId: (context.data as RequestData).spanId || '',
    userId: session.user.id,
    identity: { authMethod: context.request.headers.has('authorization') ? 'bearer' : 'session' },
    resourceId: `/users/${session.user.id}`,
  })
  const route = createRouteResponder(log, 'auth/account/delete', 'Audit')

  try {
    const revokedProviderCount = await revokeProvidersAndDeleteUser(
      context.env.DB,
      session.user.id,
      context.env,
    )
    route.info('Revoked linked providers and deleted account', { revokedProviderCount })
    return Response.json({ success: true }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof ProviderRevocationError) {
      const status = error.status ? 502 : error.message.includes('not configured') ? 503 : 409
      return route.fail(status, error.message, `Account deletion stopped before local deletion because ${error.providerId} revocation did not complete`, {
        providerId: error.providerId,
        upstreamStatus: error.status,
      })
    }
    const errorDetail = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown deletion error'
    return route.fail(500, 'Account deletion failed', `Local account deletion failed after provider revocation (${errorDetail}); retry the idempotent operation`)
  }
}