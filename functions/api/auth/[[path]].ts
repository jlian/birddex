import { createAuth, normalizeAuthRequest } from '../../lib/auth'

export const onRequest: PagesFunction<Env> = async (context) => {
  // Generic auth routes rely on request, forwarded, and referer headers to
  // decide whether the public origin is localhost or a hosted dev domain.
  // Do not force hosted mode here or localhost web OAuth callbacks will fail
  // state validation.
  const request = normalizeAuthRequest(context.env, context.request)
  const auth = createAuth(context.env, { request, log: (context.data as RequestData).log })
  return auth.handler(request)
}
