import { createRouteResponder, RESULT_DESCRIPTION_HEADER } from '../lib/log'

function degraded(db: 'unexpected' | 'error', failure: Response): Response {
  return Response.json({ status: 'degraded', db }, {
    status: 503,
    headers: {
      [RESULT_DESCRIPTION_HEADER]: failure.headers.get(RESULT_DESCRIPTION_HEADER) || 'D1 health check failed',
    },
  })
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const route = createRouteResponder((context.data as RequestData).log, 'health/database/read', 'Application')
  try {
    const result = await context.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>()
    if (result?.ok === 1) {
      return route.complete(Response.json({ status: 'ok', db: 'ok' }), 'D1 health check succeeded')
    }
    return degraded('unexpected', route.fail(503, 'D1 health check returned unexpected result', 'D1 health check returned an unexpected result; the database may be in a degraded state'))
  } catch {
    return degraded('error', route.fail(503, 'D1 health check failed', 'D1 health check failed; inspect the database binding and trace'))
  }
}
