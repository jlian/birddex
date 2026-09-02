import { createAuth, isSameOriginRequest } from '../../../lib/auth'
import {
  createAccountMergeIntent,
  type AccountMergeAuthMethod,
} from '../../../lib/account-merge-intent'
import { createRouteResponder } from '../../../lib/log'

const authMethods = new Set<AccountMergeAuthMethod>(['github', 'google', 'apple', 'passkey'])

export const onRequestPost: ApiHandler = async context => {
  const route = createRouteResponder((context.data as RequestData).log, 'auth/accountMerge/prepare', 'Application')
  if (!isSameOriginRequest(context.env, context.request)) {
    return route.fail(403, 'Forbidden', 'Account merge preparation requires a same-origin request')
  }

  let body: { authMethod?: unknown } | null
  try {
    body = await context.request.json()
  } catch {
    return route.fail(400, 'Invalid request', 'Account merge preparation requires a JSON authMethod field')
  }
  const authMethod = typeof body?.authMethod === 'string'
    ? body.authMethod as AccountMergeAuthMethod
    : null
  if (!authMethod || !authMethods.has(authMethod)) {
    return route.fail(400, 'Unsupported authentication method', 'Account merge supports github, google, apple, and passkey')
  }

  const auth = createAuth(context.env, { request: context.request })
  const session = await auth.api.getSession({ headers: context.request.headers })
  if (!session?.user?.id || !session.session?.id || session.user.isAnonymous !== true) {
    return route.fail(401, 'Anonymous session required', 'Account merge preparation requires the current anonymous WingDex session')
  }

  try {
    const token = await createAccountMergeIntent(context.env.DB, session.session.id, authMethod)
    return route.complete(Response.json({ token }, {
      headers: { 'Cache-Control': 'no-store' },
    }), `Prepared an account merge intent for ${authMethod} authentication`)
  } catch {
    return route.fail(409, 'Account merge could not be prepared', 'The anonymous session changed before its merge intent could be stored')
  }
}