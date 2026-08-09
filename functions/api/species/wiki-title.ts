import { getWikiMetadata } from '../../lib/taxonomy'
import { createRouteResponder } from '../../lib/log'

export const onRequestGet: PagesFunction<Env> = async context => {
  const route = createRouteResponder(context.data.log, 'species/wikiTitle/read', 'Application')
  const name = new URL(context.request.url).searchParams.get('name')

  if (!name?.trim()) {
    return route.complete(
      Response.json({ wikiTitle: null, common: null, scientific: null, thumbnailUrl: null }),
      'Completed wiki metadata lookup with empty species name',
    )
  }

  const metadata = getWikiMetadata(name)
  return route.complete(Response.json({
    wikiTitle: metadata.wikiTitle || null,
    common: metadata.common || null,
    scientific: metadata.scientific || null,
    thumbnailUrl: metadata.thumbnailUrl || null,
  }), `Completed wiki metadata lookup (${metadata.wikiTitle ? 'title found' : 'title missing'})`)
}
