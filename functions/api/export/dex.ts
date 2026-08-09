import { computeDex } from '../../lib/dex-query'
import { exportDexToCSV } from '../../lib/ebird'
import { createRouteResponder } from '../../lib/log'

export const onRequestGet: PagesFunction<Env> = async context => {
  const userId = (context.data as { user?: { id?: string } }).user?.id
  const route = createRouteResponder((context.data as RequestData).log?.withResourceId('dex'), 'export/dex/export', 'Application')
  if (!userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  try {
  const dex = await computeDex(context.env.DB, userId)
  const csv = exportDexToCSV(dex)
  return route.complete(new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="wingdex-dex.csv"',
      'cache-control': 'no-store',
    },
  }), `Exported dex CSV with ${dex.length} species`)
  } catch {
    return route.fail(500, 'Internal server error', 'Dex export failed; inspect the trace and database query')
  }
}
