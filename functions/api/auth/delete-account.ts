import { createAuth } from '../../lib/auth'
import { createLogger, createRouteResponder, type Logger } from '../../lib/log'
import {
  AccountDeletionStageError,
  ProviderRevocationError,
  revokeProvidersAndDeleteUser,
  type AccountDeletionEvent,
  type SafeLinkedProvider,
} from '../../lib/provider-revocation'

function providerLabel(providerId: SafeLinkedProvider): string {
  if (providerId === 'unsupported') return 'Unsupported linked provider'
  if (providerId === 'github') return 'GitHub'
  return `${providerId[0].toUpperCase()}${providerId.slice(1)}`
}

export function logAccountDeletionEvent(log: Logger, event: AccountDeletionEvent): void {
  if (event.stage === 'linked-provider-preflight') {
    if (event.outcome === 'failed') {
      log.error('auth/linkedProviders/read', {
        category: 'Application',
        resultType: 'Failed',
        resultDescription: 'Could not read linked providers before account deletion; no provider revocation or local deletion was started',
      })
      return
    }
    log.info('auth/linkedProviders/read', {
      category: 'Application',
      resultType: 'Succeeded',
      resultDescription: `Found ${event.providerCount} linked provider${event.providerCount === 1 ? '' : 's'} to process before account deletion`,
    })
    return
  }

  if (event.stage === 'local-deletion') {
    if (event.phase === 'started') {
      log.info('auth/account/delete', {
        category: 'Application',
        resultDescription: 'Started durable local account deletion after linked-provider processing completed',
      })
    } else if (event.outcome === 'succeeded') {
      log.info('auth/account/delete', {
        category: 'Application',
        resultType: 'Succeeded',
        resultDescription: 'Deleted the local WingDex account and its cascaded account data after linked-provider processing',
      })
    } else {
      log.error('auth/account/delete', {
        category: 'Application',
        resultType: 'Failed',
        resultDescription: 'Local account deletion failed after linked-provider processing; retry account deletion to complete the durable local transition',
      })
    }
    return
  }

  const provider = providerLabel(event.phase === 'started' ? event.providerId : event.result.providerId)
  if (event.phase === 'started') {
    log.info('auth/provider/revoke', {
      category: 'Application',
      resultDescription: `Started ${provider} credential revocation before local account deletion`,
    })
    return
  }

  if (event.result.outcome === 'manual_action_required') {
    log.warn('auth/provider/revoke', {
      category: 'Application',
      resultType: 'Failed',
      resultDescription: 'Apple revocation credentials were unavailable; local account deletion will continue, but manual revocation in Apple Account settings is required',
    })
  } else if (event.result.outcome === 'failed') {
    log.error('auth/provider/revoke', {
      category: 'Application',
      resultType: 'Failed',
      resultDescription: event.upstreamStatus
        ? `${provider} credential revocation failed with upstream HTTP ${event.upstreamStatus}; local account deletion was stopped before durable local changes`
        : `${provider} credential revocation failed; local account deletion was stopped before durable local changes`,
    })
  } else if (event.result.outcome === 'skipped') {
    log.info('auth/provider/revoke', {
      category: 'Application',
      resultType: 'Succeeded',
      resultDescription: 'No external revocation is required for a credential account; local account deletion can proceed',
    })
  } else {
    log.info('auth/provider/revoke', {
      category: 'Application',
      resultType: 'Succeeded',
      resultDescription: `Revoked ${provider} credentials; local account deletion can proceed after remaining linked providers are processed`,
    })
  }
}

export const onRequestPost: PagesFunction<Env> = async context => {
  const originRoute = createRouteResponder((context.data as RequestData).log, 'auth/account/delete', 'Application')
  const requestOrigin = new URL(context.request.url).origin
  const origin = context.request.headers.get('Origin')
  if (origin !== requestOrigin) {
    return originRoute.fail(403, 'Forbidden', 'Account deletion rejected because the request origin did not match WingDex')
  }

  const auth = createAuth(context.env, { request: context.request })
  const session = await auth.api.getSession({ headers: context.request.headers })
  if (!session?.user?.id) {
    return originRoute.fail(401, 'Unauthorized', 'Account deletion requires an authenticated session')
  }

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
      event => logAccountDeletionEvent(log, event),
    )
    return route.complete(Response.json({
      success: true,
      manualAppleRevocationRequired: result.manualAppleRevocationRequired,
    }, { headers: { 'Cache-Control': 'no-store' } }),
    result.manualAppleRevocationRequired
      ? 'Deleted local account after revoking available providers; manual Apple revocation remains required'
      : 'Revoked linked providers and deleted local account')
  } catch (error) {
    if (error instanceof ProviderRevocationError) {
      const status = error.status ? 502 : error.message.includes('not configured') ? 503 : 409
      const provider = providerLabel(error.providerId)
      return route.fail(
        status,
        error.message,
        error.status
          ? `Account deletion stopped before local deletion because ${provider} revocation failed with upstream HTTP ${error.status}`
          : `Account deletion stopped before local deletion because ${provider} revocation could not complete`,
      )
    }
    if (error instanceof AccountDeletionStageError) {
      return error.stage === 'linked-provider-preflight'
        ? route.fail(500, 'Account deletion failed', 'Linked-provider preflight failed; no provider revocation or local account deletion was started')
        : route.fail(500, 'Account deletion failed', 'Local account deletion failed after linked-provider processing; retry the idempotent account deletion operation')
    }
    return route.fail(500, 'Account deletion failed', 'Local account deletion failed unexpectedly; retry the idempotent operation and inspect the correlated trace if it fails again')
  }
}