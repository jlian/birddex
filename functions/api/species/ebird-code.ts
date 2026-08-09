import { getEbirdCode } from '../../lib/taxonomy'
import { createRouteResponder } from '../../lib/log'

export const onRequestGet: PagesFunction<Env> = async context => {
  const route = createRouteResponder(context.data.log, 'species/ebirdCode/read', 'Application')
  const userId = (context.data as { user?: { id?: string } }).user?.id
  if (!userId) {
    return route.fail(401, 'Unauthorized', 'eBird code lookup requires an authenticated session')
  }

  const name = new URL(context.request.url).searchParams.get('name') ?? ''
  const trimmed = name.trim()

  if (!trimmed) {
    return route.complete(Response.json({ ebirdCode: null }), 'Completed eBird code lookup with empty species name')
  }

  const ebirdCode = getEbirdCode(trimmed)
  return route.complete(Response.json({ ebirdCode: ebirdCode || null }), `Completed eBird code lookup (${ebirdCode ? 'code found' : 'no code found'})`)
}
