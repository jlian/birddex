import { createRouteResponder } from '../../lib/log'

export const onRequestDelete: PagesFunction<Env> = async context => {
  const userId = (context.data as { user?: { id?: string } }).user?.id
  const route = createRouteResponder((context.data as RequestData).log, 'data/clear/delete', 'Audit')
  if (!userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  try {
    await context.env.DB.batch([
      context.env.DB.prepare('DELETE FROM outing WHERE userId = ?').bind(userId),
      context.env.DB.prepare('DELETE FROM dex_meta WHERE userId = ?').bind(userId),
    ])

    return route.complete(Response.json({ cleared: true }), 'Cleared all outings and dex metadata for the authenticated user')
  } catch {
    return route.fail(500, 'Internal server error', 'Data clear failed; inspect the trace and database batch')
  }
}
