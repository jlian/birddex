import { createAuth } from '../../lib/auth'
import { createLogger, createRouteResponder } from '../../lib/log'
import { ProviderRevocationError, revokeProvidersAndDeleteUser } from '../../lib/provider-revocation'

export const onRequestPost: PagesFunction<Env> = async context => {
  const originRoute = createRouteResponder((context.data as RequestData).log, 'auth/account/delete', 'Application')
  const requestOrigin = new URL(context.request.url).origin
  const origin = context.request.headers.get('Origin')
  if (origin !== requestOrigin) {
    return originRoute.fail(403, 'Forbidden', 'Account deletion rejected because the request origin did not match WingDex')
  }

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
  const route = createRouteResponder(log, 'auth/account/delete', 'Application')

  try {
    const result = await revokeProvidersAndDeleteUser(
      context.env.DB,
      session.user.id,
      context.env,
      fetch,
      (phase, revocation) => {
        const provider = revocation.providerId === 'credential' ? 'credential' : revocation.providerId
        const resultDescription = phase === 'started'
          ? `Started ${provider} credential revocation before account deletion`
          : revocation.outcome === 'failed'
            ? `${provider} credential revocation failed; local account deletion was stopped and can be retried`
          : revocation.outcome === 'manual_action_required'
            ? 'Apple credentials were unavailable; local deletion will continue and the user must revoke WingDex in Apple Account settings'
            : revocation.outcome === 'skipped'
              ? `Skipped non-revocable ${provider} credential during account deletion`
              : `Completed ${provider} credential revocation before account deletion`
        const event = {
          category: 'Application',
          resultType: phase === 'completed'
            ? revocation.outcome === 'failed' ? 'Failed' : 'Succeeded'
            : undefined,
          resultDescription,
        } as const
        if (phase === 'completed' && revocation.outcome === 'failed') {
          log.error('auth/provider/revoke', event)
        } else {
          log.info('auth/provider/revoke', event)
        }
      },
    )
    route.info(
      result.manualAppleRevocationRequired
        ? 'Deleted the local account after revoking available providers; manual Apple revocation is still required'
        : 'Revoked linked providers and deleted the local account',
    )
    return Response.json({
      success: true,
      manualAppleRevocationRequired: result.manualAppleRevocationRequired,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof ProviderRevocationError) {
      const status = error.status ? 502 : error.message.includes('not configured') ? 503 : 409
      return route.fail(status, error.message, `Account deletion stopped before local deletion because ${error.providerId} revocation did not complete`, {
        providerId: error.providerId,
        upstreamStatus: error.status,
      })
    }
    return route.fail(500, 'Account deletion failed', 'Local account deletion failed unexpectedly; retry the idempotent operation and inspect the correlated trace if it fails again')
  }
}