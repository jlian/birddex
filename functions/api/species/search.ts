import { searchSpecies } from '../../lib/taxonomy'
import { createRouteResponder } from '../../lib/log'

function parseLimit(value: string | null): number {
  if (!value) return 8
  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed)) return 8
  return Math.max(1, Math.min(parsed, 25))
}

export const onRequestGet: ApiHandler = async context => {
  const route = createRouteResponder((context.data as RequestData).log, 'species/search/read', 'Application')
  const userId = (context.data as { user?: { id?: string } }).user?.id
  if (!userId) {
    return route.fail(401, 'Unauthorized', 'Species search requires an authenticated session')
  }

  const query = new URL(context.request.url).searchParams.get('q') ?? ''
  const limit = parseLimit(new URL(context.request.url).searchParams.get('limit'))

  if (!query.trim()) {
    return route.complete(Response.json({ results: [] }), 'Species search returned no matches because the query was empty')
  }

  const stage = 'taxonomy search'
  try {
    const results = searchSpecies(query, limit)
    return route.complete(
      Response.json({ results }),
      `Species search returned ${results.length} ${results.length === 1 ? 'match' : 'matches'}`,
    )
  } catch {
    return route.fail(500, 'Internal server error', `Species search failed during ${stage}`)
  }
}
