import {
  accountMergeFinalizationEnabled,
  finalizeAccountMerge,
  finalizeBoundAccountMerges,
  type AccountMergeResult,
} from '../../../lib/account-merge'
import { createAuth, isSameOriginRequest } from '../../../lib/auth'
import { createRouteResponder } from '../../../lib/log'

export const onRequestPost: ApiHandler = async context => {
  const route = createRouteResponder((context.data as RequestData).log, 'auth/accountMerge/finalize', 'Application')
  if (!isSameOriginRequest(context.env, context.request)) {
    return route.fail(403, 'Forbidden', 'Account merge finalization requires a same-origin request')
  }
  if (!accountMergeFinalizationEnabled(context.env)) {
    return route.fail(503, 'Account merge is temporarily unavailable', 'The merge intent was preserved for retry')
  }

  let body: { token?: unknown } | null
  try {
    body = await context.request.json()
  } catch {
    return route.fail(400, 'Invalid request', 'Account merge finalization requires a JSON token field')
  }
  if (body?.token !== undefined && (
    typeof body.token !== 'string' || body.token.length < 32 || body.token.length > 256
  )) {
    return route.fail(400, 'Invalid account merge token', 'Account merge finalization requires the opaque token returned before authentication')
  }

  const auth = createAuth(context.env, { request: context.request })
  const session = await auth.api.getSession({ headers: context.request.headers })
  if (!session?.user?.id || session.user.isAnonymous === true) {
    return route.fail(401, 'Registered session required', 'Account merge finalization requires the authenticated target account')
  }

  try {
    const results: AccountMergeResult[] = []
    if (typeof body?.token === 'string') {
      results.push(await finalizeAccountMerge(context.env.DB, body.token, session.user.id))
    }
    results.push(...await finalizeBoundAccountMerges(context.env.DB, session.user.id))
    const uniqueResults = Array.from(new Map(
      results.map(result => [result.sourceUserId, result]),
    ).values())
    if (uniqueResults.length === 0) {
      return route.complete(Response.json({ status: 'none' }, {
        headers: { 'Cache-Control': 'no-store' },
      }), 'No pending account merge exists for the authenticated target')
    }
    const result = {
      status: 'completed' as const,
      sourceUserId: uniqueResults.length === 1 ? uniqueResults[0].sourceUserId : 'multiple',
      targetUserId: session.user.id,
      promoted: uniqueResults.every(entry => entry.promoted),
      outings: uniqueResults.reduce((sum, entry) => sum + entry.outings, 0),
      observations: uniqueResults.reduce((sum, entry) => sum + entry.observations, 0),
      photos: uniqueResults.reduce((sum, entry) => sum + entry.photos, 0),
    }
    return route.complete(Response.json(result, {
      headers: { 'Cache-Control': 'no-store' },
    }), result.promoted
      ? 'Completed anonymous account promotion'
      : `Completed account merge with ${result.outings} outings, ${result.observations} observations, and ${result.photos} photos`)
  } catch {
    return route.fail(409, 'Account merge could not be completed', 'The anonymous source and merge intent were preserved for retry')
  }
}