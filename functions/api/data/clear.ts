import { createRouteResponder } from '../../lib/log'

/**
 * Prefix marking a checklist as WingDex sample data rather than a real record.
 *
 * Real eBird submission ids are always `S` followed by digits, so this cannot
 * collide with one no matter how many checklists eBird issues.
 */
export const DEMO_SUBMISSION_PREFIX = 'WINGDEX-DEMO-'

export const onRequestDelete: PagesFunction<Env> = async context => {
  const userId = (context.data as { user?: { id?: string } }).user?.id
  const route = createRouteResponder((context.data as RequestData).log, 'data/clear/delete', 'Audit')
  if (!userId) {
    return route.fail(401, 'Unauthorized', 'Authentication is required to clear account data')
  }

  // ?scope=demo removes only the sample checklists, leaving real records alone.
  //
  // This matters as soon as an anonymous visitor can create real observations:
  // an unscoped clear is DELETE FROM outing WHERE userId = ?, so turning the
  // demo off would take a user's own sightings with it. Default stays unscoped
  // so existing callers (account reset, sign-out cleanup) are unchanged.
  const scope = new URL(context.request.url).searchParams.get('scope')
  const demoOnly = scope === 'demo'

  try {
    if (demoOnly) {
      // Observations and photos cascade from outing, so deleting the demo
      // checklists is enough; no per-table sweep. dex_meta is left alone
      // because it is derived, and is recomputed from what remains.
      const result = await context.env.DB
        .prepare('DELETE FROM outing WHERE userId = ? AND submissionId LIKE ?')
        .bind(userId, `${DEMO_SUBMISSION_PREFIX}%`)
        .run()
      // D1 reports meta.changes including rows removed by the cascade, so this is
      // total rows affected, not a checklist count. Named accordingly rather than
      // implying a number it does not carry.
      const removed = result.meta?.changes ?? 0

      return route.complete(
        Response.json({ cleared: true, scope: 'demo', rowsAffected: removed }),
        `Cleared demo checklists and their cascaded observations and photos (${removed} rows affected), leaving real records intact`,
      )
    }

    await context.env.DB.batch([
      context.env.DB.prepare('DELETE FROM outing WHERE userId = ?').bind(userId),
      context.env.DB.prepare('DELETE FROM dex_meta WHERE userId = ?').bind(userId),
    ])
    route.succeeded('Cleared all outings, cascaded observations and photos, and dex metadata for the authenticated account')

    return route.complete(Response.json({ cleared: true }), 'Cleared all outings, cascaded observations and photos, and dex metadata for the authenticated account')
  } catch {
    return route.fail(500, 'Internal server error', 'Account data clear failed before the outings and dex metadata deletion batch committed')
  }
}
