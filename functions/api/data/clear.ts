import { createRouteResponder } from '../../lib/log'

export const onRequestDelete: ApiHandler = async context => {
  const userId = (context.data as { user?: { id?: string } }).user?.id
  const route = createRouteResponder((context.data as RequestData).log, 'data/clear/delete', 'Audit')
  if (!userId) {
    return route.fail(401, 'Unauthorized', 'Authentication is required to clear account data')
  }

  try {
    await context.env.DB.batch([
      context.env.DB.prepare('DELETE FROM outing WHERE userId = ?').bind(userId),
      context.env.DB.prepare('DELETE FROM dex_meta WHERE userId = ?').bind(userId),
      context.env.DB.prepare('DELETE FROM importIdentity WHERE userId = ?').bind(userId),
    ])
    route.succeeded('Cleared all outings, cascaded observations and photos, dex metadata, and import receipts for the authenticated account')

    return route.complete(Response.json({ cleared: true }), 'Cleared all outings, cascaded observations and photos, dex metadata, and import receipts for the authenticated account')
  } catch {
    return route.fail(500, 'Internal server error', 'Account data clear failed before the outings and dex metadata deletion batch committed')
  }
}
