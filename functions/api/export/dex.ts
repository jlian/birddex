import { computeDex } from '../../lib/dex-query'
import { exportDexToCSV } from '../../lib/ebird'
import { createRouteResponder } from '../../lib/log'

export const onRequestGet: PagesFunction<Env> = async context => {
  const userId = (context.data as { user?: { id?: string } }).user?.id
  const route = createRouteResponder((context.data as RequestData).log?.withResourceId('dex'), 'export/dex/export', 'Application')
  if (!userId) {
    return route.fail(401, 'Unauthorized', 'Authentication is required to generate a dex CSV')
  }

  let stage = 'dex computation'
  try {
    const dex = await computeDex(context.env.DB, userId)
    stage = 'dex CSV serialization'
    const csv = exportDexToCSV(dex)
    return route.complete(new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="wingdex-dex.csv"',
        'cache-control': 'no-store',
      },
    }), `Generated dex CSV with ${dex.length} species`)
  } catch {
    return route.fail(500, 'Internal server error', `Dex CSV generation failed during ${stage}`)
  }
}
