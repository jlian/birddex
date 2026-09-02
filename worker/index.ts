import { Hono } from 'hono'
import type { Context } from 'hono'
import { onRequest as requestMiddleware } from '../functions/middleware'
import { RESULT_DESCRIPTION_HEADER, RESULT_TYPE_HEADER } from '../functions/lib/log'
import { onRequest as auth } from '../functions/api/auth/[[path]]'
import { onRequestPost as createAppleRevocationToken } from '../functions/api/auth/apple/revocation-token'
import { onRequestPost as deleteAccount } from '../functions/api/auth/delete-account'
import { onRequestGet as linkedProviders } from '../functions/api/auth/linked-providers'
import { onRequestPost as finalizeAccountMerge } from '../functions/api/auth/merge/finalize'
import { onRequestPost as prepareAccountMerge } from '../functions/api/auth/merge/prepare'
import { onRequestGet as mobileAuthCallback } from '../functions/api/auth/mobile/callback'
import { onRequestGet as startMobileAuth } from '../functions/api/auth/mobile/start'
import { onRequestGet as getAllData } from '../functions/api/data/all'
import { onRequestDelete as clearData } from '../functions/api/data/clear'
import { onRequestGet as getDex, onRequestPatch as updateDex } from '../functions/api/data/dex'
import { onRequestPost as createObservations, onRequestPatch as updateObservations } from '../functions/api/data/observations'
import { onRequestDelete as deleteOuting, onRequestPatch as updateOuting } from '../functions/api/data/outings/[id]'
import { onRequestPost as createOuting } from '../functions/api/data/outings'
import { onRequestPost as createPhotos } from '../functions/api/data/photos'
import { onRequestGet as exportDex } from '../functions/api/export/dex'
import { onRequestGet as exportOuting } from '../functions/api/export/outing/[id]'
import { onRequestGet as exportSightings } from '../functions/api/export/sightings'
import { onRequestPost as reverseGeocode } from '../functions/api/geocoding/reverse'
import { onRequestPost as searchPlaces } from '../functions/api/geocoding/search'
import { onRequestGet as health } from '../functions/api/health'
import { onRequestPost as importEbirdCsv } from '../functions/api/import/ebird-csv'
import { onRequestGet as resolveEbirdCode } from '../functions/api/species/ebird-code'
import { onRequestGet as searchSpecies } from '../functions/api/species/search'
import { onRequestGet as resolveWikiTitle } from '../functions/api/species/wiki-title'

type AppEnv = {
  Bindings: Env
  Variables: {
    requestData: RequestData
  }
}

type AppContext = Context<AppEnv>
type RouteHandler = ApiHandler

function apiContext(
  context: AppContext,
  data: RequestData,
): ApiContext {
  return {
    request: context.req.raw,
    waitUntil: promise => context.executionCtx.waitUntil(promise),
    env: context.env,
    params: context.req.param(),
    data,
  }
}

function route(handler: RouteHandler) {
  return (context: AppContext) => handler(
    apiContext(context, context.get('requestData')),
  )
}

export function createWorkerApp() {
  const worker = new Hono<AppEnv>()

  // Let the existing request middleware own sanitized 500 handling and logging.
  // Hono otherwise catches route exceptions first and logs the raw error.
  worker.onError(error => {
    throw error
  })

  worker.use('*', async (context, next) => {
    const data: RequestData = {}
    context.set('requestData', data)
    const response = await requestMiddleware({
      ...apiContext(context, data),
      next: async () => {
        await next()
        return context.res
      },
    })
    context.res.headers.delete(RESULT_DESCRIPTION_HEADER)
    context.res.headers.delete(RESULT_TYPE_HEADER)
    context.res = response
  })

  return worker
}

const app = createWorkerApp()

app.get('/api/health', route(health))

app.get('/api/data/all', route(getAllData))
app.delete('/api/data/clear', route(clearData))
app.get('/api/data/dex', route(getDex))
app.patch('/api/data/dex', route(updateDex))
app.post('/api/data/observations', route(createObservations))
app.patch('/api/data/observations', route(updateObservations))
app.post('/api/data/outings', route(createOuting))
app.patch('/api/data/outings/:id', route(updateOuting))
app.delete('/api/data/outings/:id', route(deleteOuting))
app.post('/api/data/photos', route(createPhotos))

app.get('/api/auth/linked-providers', route(linkedProviders))
app.post('/api/auth/apple/revocation-token', route(createAppleRevocationToken))
app.post('/api/auth/delete-account', route(deleteAccount))
app.post('/api/auth/merge/finalize', route(finalizeAccountMerge))
app.post('/api/auth/merge/prepare', route(prepareAccountMerge))
app.get('/api/auth/mobile/callback', route(mobileAuthCallback))
app.get('/api/auth/mobile/start', route(startMobileAuth))
app.all('/api/auth', route(auth))
app.all('/api/auth/*', route(auth))

app.get('/api/export/dex', route(exportDex))
app.get('/api/export/outing/:id', route(exportOuting))
app.get('/api/export/sightings', route(exportSightings))
app.post('/api/geocoding/reverse', route(reverseGeocode))
app.post('/api/geocoding/search', route(searchPlaces))
app.post('/api/import/ebird-csv', route(importEbirdCsv))
app.get('/api/species/ebird-code', route(resolveEbirdCode))
app.get('/api/species/search', route(searchSpecies))
app.get('/api/species/wiki-title', route(resolveWikiTitle))

export default app
