import { getWikiMetadata } from '../../lib/taxonomy'
import { createRouteResponder } from '../../lib/log'

export const onRequestGet: PagesFunction<Env> = async context => {
  const route = createRouteResponder(context.data.log, 'species/wikiTitle/read', 'Application')
  const name = new URL(context.request.url).searchParams.get('name')

  if (!name?.trim()) {
    return route.complete(
      Response.json({ wikiTitle: null, common: null, scientific: null, thumbnailUrl: null }),
      'Wikipedia metadata lookup returned no metadata because the species name was empty',
    )
  }

  const stage = 'taxonomy metadata lookup'
  try {
    const metadata = getWikiMetadata(name)
    return route.complete(Response.json({
      wikiTitle: metadata.wikiTitle || null,
      common: metadata.common || null,
      scientific: metadata.scientific || null,
      thumbnailUrl: metadata.thumbnailUrl || null,
    }), `Wikipedia metadata lookup ${metadata.wikiTitle ? 'found a title' : 'returned no title'}`)
  } catch {
    return route.fail(500, 'Internal server error', `Wikipedia metadata lookup failed during ${stage}`)
  }
}
