import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogFields, Logger } from './log'
import { RESULT_DESCRIPTION_HEADER } from './log'

const dependencies = vi.hoisted(() => ({
  computeDex: vi.fn(),
  groupPreviewsIntoOutings: vi.fn(),
  getOutingColumnNames: vi.fn(),
  hasObservationColumn: vi.fn(),
}))

vi.mock('./dex-query', () => ({
  computeDex: dependencies.computeDex,
  enrichDexEntries: (rows: unknown) => rows,
}))

vi.mock('./ebird', () => ({
  groupPreviewsIntoOutings: dependencies.groupPreviewsIntoOutings,
}))

vi.mock('./schema', () => ({
  getOutingColumnNames: dependencies.getOutingColumnNames,
  hasObservationColumn: dependencies.hasObservationColumn,
}))

import { onRequestDelete as clearData } from '../api/data/clear'
import { onRequestPatch as patchDex } from '../api/data/dex'
import { onRequestPost as createObservations, onRequestPatch as patchObservations } from '../api/data/observations'
import { onRequestDelete as deleteOuting } from '../api/data/outings/[id]'
import { onRequestPost as reverseGeocode } from '../api/geocoding/reverse'
import { onRequestPost as searchGeocoding } from '../api/geocoding/search'
import { onRequestPost as confirmEBirdImport } from '../api/import/ebird-csv/confirm'

type CapturedEvent = { operationName: string; fields?: LogFields }

function createEventLogger(order?: string[]) {
  const events: CapturedEvent[] = []
  const capture = (operationName: string, fields?: LogFields) => {
    events.push({ operationName, fields })
    order?.push('event')
  }
  const log: Logger = {
    info: capture,
    debug: () => {},
    trace: () => {},
    warn: capture,
    error: capture,
    critical: capture,
    withResource: () => log,
    withResourceId: () => log,
  }
  return { events, log }
}

function jsonRequest(body: unknown): Request {
  return new Request('https://wingdex.test/api/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function routeContext(request: Request, db: D1Database, log: Logger, params: Record<string, string> = {}) {
  return {
    request,
    env: {
      DB: db,
      GEOAPIFY_KEY: 'provider-key',
      GEOCODING_LIMITER: { limit: async () => ({ success: true }) },
    },
    data: { user: { id: 'user-1' }, log },
    params,
  }
}

function boundStatement(overrides: Record<string, unknown> = {}): D1PreparedStatement {
  const statement = {
    bind: vi.fn(() => statement),
    ...overrides,
  }
  return statement as unknown as D1PreparedStatement
}

describe('non-auth durable observability', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    dependencies.computeDex.mockReset()
    dependencies.groupPreviewsIntoOutings.mockReset()
    dependencies.getOutingColumnNames.mockReset().mockResolvedValue(new Set<string>())
    dependencies.hasObservationColumn.mockReset().mockResolvedValue(false)
  })

  it('emits the all-data Audit event only after the cascade batch commits', async () => {
    const order: string[] = []
    const { events, log } = createEventLogger(order)
    const db = {
      prepare: vi.fn(() => boundStatement()),
      batch: vi.fn(async () => {
        order.push('batch')
        return []
      }),
    } as unknown as D1Database

    const response = await clearData(routeContext(
      new Request('https://wingdex.test/api/data/clear', { method: 'DELETE' }),
      db,
      log,
    ) as never)

    expect(response.status).toBe(200)
    expect(order).toEqual(['batch', 'event'])
    expect(events).toEqual([expect.objectContaining({
      operationName: 'data/clear/delete',
      fields: expect.objectContaining({
        category: 'Audit',
        resultType: 'Succeeded',
        resultDescription: 'Cleared all outings, cascaded observations and photos, and dex metadata for the authenticated account',
      }),
    })])
  })

  it('reports outing deletion before a post-delete dex failure without exposing the path ID', async () => {
    const order: string[] = []
    const { events, log } = createEventLogger(order)
    const privateOutingId = 'caller-secret-outing-id'
    const db = {
      prepare: vi.fn(() => boundStatement({
        run: vi.fn(async () => {
          order.push('delete')
          return { meta: { changes: 1 } }
        }),
      })),
    } as unknown as D1Database
    dependencies.computeDex.mockImplementationOnce(async () => {
      order.push('dex')
      throw new Error('dex failed')
    })

    const response = await deleteOuting(routeContext(
      new Request(`https://wingdex.test/api/data/outings/${privateOutingId}`, { method: 'DELETE' }),
      db,
      log,
      { id: privateOutingId },
    ) as never)

    expect(response.status).toBe(500)
    expect(order).toEqual(['delete', 'event', 'dex'])
    expect(events[0].fields?.resultType).toBe('Succeeded')
    expect(events[0].fields?.resultDescription).toContain('Deleted 1 outing with cascaded observations and photos')
    expect(response.headers.get(RESULT_DESCRIPTION_HEADER)).toContain('post-delete dex recomputation failed')
    expect(JSON.stringify({ events, description: response.headers.get(RESULT_DESCRIPTION_HEADER) })).not.toContain(privateOutingId)
  })

  it('distinguishes a committed eBird batch from post-commit dex failure using aggregate counts', async () => {
    const order: string[] = []
    const { events, log } = createEventLogger(order)
    const validPreview = btoa(JSON.stringify({ source: 'preview-private-value' }))
    const invalidPreview = 'not-valid-base64!'
    dependencies.groupPreviewsIntoOutings.mockReturnValue({
      outings: [{
        id: 'generated-outing',
        startTime: '2026-08-09T10:00:00.000Z',
        endTime: '2026-08-09T11:00:00.000Z',
        locationName: 'private location',
        notes: '',
        createdAt: '2026-08-09T10:00:00.000Z',
      }],
      observations: [{
        id: 'generated-observation',
        outingId: 'generated-outing',
        speciesName: 'private species',
        count: 1,
        certainty: 'confirmed',
        notes: '',
      }],
    })
    dependencies.computeDex
      .mockImplementationOnce(async () => {
        order.push('prior-dex')
        return []
      })
      .mockImplementationOnce(async () => {
        order.push('post-commit-dex')
        throw new Error('dex failed')
      })
    const db = {
      prepare: vi.fn(() => boundStatement()),
      batch: vi.fn(async () => {
        order.push('batch')
        return []
      }),
    } as unknown as D1Database

    const response = await confirmEBirdImport(routeContext(
      jsonRequest({ previewIds: [validPreview, invalidPreview] }),
      db,
      log,
    ) as never)

    expect(response.status).toBe(500)
    expect(order).toEqual(['prior-dex', 'batch', 'event', 'post-commit-dex'])
    expect(events[0].fields?.resultType).toBe('Succeeded')
    expect(events[0].fields?.resultDescription).toBe(
      'Committed eBird import batch from 2 selected previews and 1 valid preview, persisting 1 outing and 1 observation',
    )
    expect(response.headers.get(RESULT_DESCRIPTION_HEADER)).toContain('Committed eBird import batch')
    expect(JSON.stringify(events)).not.toContain('private location')
    expect(JSON.stringify(events)).not.toContain('private species')
    expect(JSON.stringify(events)).not.toContain(validPreview)
  })

  it('records a verified observation batch before dex recomputation fails', async () => {
    const order: string[] = []
    const { events, log } = createEventLogger(order)
    let batchCommitted = false
    const observations = [
      { id: 'private-observation-1', outingId: 'outing-1', speciesName: 'private species 1', count: 1, certainty: 'confirmed' },
      { id: 'private-observation-2', outingId: 'outing-1', speciesName: 'private species 2', count: 2, certainty: 'possible' },
    ]
    const db = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes('SELECT id FROM outing')) {
          return boundStatement({ all: vi.fn(async () => ({ results: [{ id: 'outing-1' }] })) })
        }
        if (sql.includes('SELECT id, userId, outingId FROM observation')) {
          return boundStatement({
            all: vi.fn(async () => ({
              results: batchCommitted
                ? observations.map(observation => ({ id: observation.id, userId: 'user-1', outingId: observation.outingId }))
                : [],
            })),
          })
        }
        return boundStatement()
      }),
      batch: vi.fn(async () => {
        batchCommitted = true
        order.push('batch')
        return []
      }),
    } as unknown as D1Database
    dependencies.computeDex.mockImplementationOnce(async () => {
      order.push('dex')
      throw new Error('dex failed')
    })

    const response = await createObservations(routeContext(jsonRequest(observations), db, log) as never)

    expect(response.status).toBe(500)
    expect(order).toEqual(['batch', 'event', 'dex'])
    expect(events[0].fields?.resultType).toBe('Succeeded')
    expect(events[0].fields?.resultDescription).toBe('Committed and verified 2 observations across 1 outing; starting dex recomputation')
    expect(JSON.stringify(events)).not.toContain('private-observation')
    expect(JSON.stringify(events)).not.toContain('private species')
  })

  it('marks committed observation batches failed when post-commit ownership verification fails', async () => {
    const { events, log } = createEventLogger()
    let batchCommitted = false
    const observations = [
      { id: 'private-observation-1', outingId: 'outing-1', speciesName: 'private species 1', count: 1, certainty: 'confirmed' },
      { id: 'private-observation-2', outingId: 'outing-1', speciesName: 'private species 2', count: 1, certainty: 'confirmed' },
    ]
    const db = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes('SELECT id FROM outing')) {
          return boundStatement({ all: vi.fn(async () => ({ results: [{ id: 'outing-1' }] })) })
        }
        if (sql.includes('SELECT id, userId, outingId FROM observation')) {
          return boundStatement({
            all: vi.fn(async () => ({
              results: batchCommitted
                ? observations.map(observation => ({ ...observation, userId: 'other-user' }))
                : [],
            })),
          })
        }
        return boundStatement()
      }),
      batch: vi.fn(async () => {
        batchCommitted = true
        return []
      }),
    } as unknown as D1Database

    const response = await createObservations(routeContext(jsonRequest(observations), db, log) as never)

    expect(response.status).toBe(409)
    expect(events).toHaveLength(1)
    expect(events[0].fields?.resultType).toBe('Failed')
    expect(events[0].fields?.resultDescription).toBe(
      'Committed 2-record observation batch, but post-commit ownership verification failed',
    )
    expect(JSON.stringify(events)).not.toContain('private-observation')
    expect(JSON.stringify(events)).not.toContain('private species')
  })

  it('records a committed bulk observation patch before readback or dex failure', async () => {
    const order: string[] = []
    const { events, log } = createEventLogger(order)
    const privateIds = ['private-observation-1', 'private-observation-2']
    const db = {
      prepare: vi.fn(() => boundStatement({
        all: vi.fn(async () => ({
          results: privateIds.map(id => ({
            id,
            outingId: 'outing-1',
            speciesName: 'private species',
            count: 1,
            certainty: 'confirmed',
            notes: 'updated',
          })),
        })),
      })),
      batch: vi.fn(async () => {
        order.push('batch')
        return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }]
      }),
    } as unknown as D1Database
    dependencies.computeDex.mockImplementationOnce(async () => {
      order.push('dex')
      throw new Error('dex failed')
    })

    const response = await patchObservations(routeContext(
      jsonRequest({ ids: privateIds, patch: { notes: 'private notes' } }),
      db,
      log,
    ) as never)

    expect(response.status).toBe(500)
    expect(order).toEqual(['batch', 'event', 'dex'])
    expect(events[0].fields?.resultType).toBe('Succeeded')
    expect(events[0].fields?.resultDescription).toBe('Committed bulk observation patch for 2 of 2 requested records; starting result verification and dex recomputation')
    expect(JSON.stringify(events)).not.toContain('private-observation')
  })

  it('reports partial dex multi-patch state after a later write fails', async () => {
    const { events, log } = createEventLogger()
    let insertCount = 0
    const db = {
      prepare: vi.fn((sql: string) => {
        if (sql.startsWith('SELECT')) {
          return boundStatement({ all: vi.fn(async () => ({ results: [] })) })
        }
        return boundStatement({
          run: vi.fn(async () => {
            insertCount += 1
            if (insertCount === 2) throw new Error('write failed')
            return { meta: { changes: 1 } }
          }),
        })
      }),
    } as unknown as D1Database

    const response = await patchDex(routeContext(jsonRequest([
      { speciesName: 'private species 1', notes: 'private notes 1' },
      { speciesName: 'private species 2', notes: 'private notes 2' },
      { speciesName: 'private species 3', notes: 'private notes 3' },
    ]), db, log) as never)

    expect(response.status).toBe(500)
    expect(events).toHaveLength(1)
    expect(events[0].fields?.resultType).toBe('Failed')
    expect(events[0].fields?.resultDescription).toBe('Applied 1 of 3 dex metadata patches before a later database write failed')
    expect(response.headers.get(RESULT_DESCRIPTION_HEADER)).toContain('Applied 1 of 3 dex metadata patches')
    expect(JSON.stringify(events)).not.toContain('private species')
    expect(JSON.stringify(events)).not.toContain('private notes')
  })

  it('marks a completed dex multi-patch durable write succeeded before recomputation', async () => {
    const { events, log } = createEventLogger()
    const db = {
      prepare: vi.fn((sql: string) => sql.startsWith('SELECT')
        ? boundStatement({ all: vi.fn(async () => ({ results: [] })) })
        : boundStatement({ run: vi.fn(async () => ({ meta: { changes: 1 } })) })),
    } as unknown as D1Database
    dependencies.computeDex.mockResolvedValueOnce([])

    const response = await patchDex(routeContext(jsonRequest([
      { speciesName: 'private species 1' },
      { speciesName: 'private species 2' },
    ]), db, log) as never)

    expect(response.status).toBe(200)
    expect(events).toHaveLength(1)
    expect(events[0].fields?.resultType).toBe('Succeeded')
    expect(events[0].fields?.resultDescription).toBe(
      'Applied 2 of 2 dex metadata patches; starting dex recomputation',
    )
    expect(JSON.stringify(events)).not.toContain('private species')
  })

  it('keeps a single dex metadata patch free of handler-owned Application events', async () => {
    const { events, log } = createEventLogger()
    const db = {
      prepare: vi.fn((sql: string) => sql.startsWith('SELECT')
        ? boundStatement({ all: vi.fn(async () => ({ results: [] })) })
        : boundStatement({ run: vi.fn(async () => ({ meta: { changes: 1 } })) })),
    } as unknown as D1Database
    dependencies.computeDex.mockResolvedValueOnce([])

    const response = await patchDex(routeContext(jsonRequest({
      speciesName: 'private species',
      notes: 'private notes',
    }), db, log) as never)

    expect(response.status).toBe(200)
    expect(events).toEqual([])
  })

  it('emits only a privacy-safe Application fallback event from the reverse route', async () => {
    const { events, log } = createEventLogger()
    const latitude = '47.68049'
    const longitude = '-122.32771'
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ features: [] }))
      .mockResolvedValueOnce(Response.json({ results: [] })))

    const response = await reverseGeocode(routeContext(
      jsonRequest({ lat: latitude, lon: longitude }),
      {} as D1Database,
      log,
    ) as never)

    expect(response.status).toBe(200)
    expect(events).toEqual([expect.objectContaining({
      operationName: 'geocoding/reverse/read',
      fields: expect.objectContaining({
        category: 'Application',
        resultDescription: 'Places lookup returned no usable named outdoor place; starting reverse geocoding fallback',
      }),
    })])
    expect(events[0].fields?.resultType).toBeUndefined()
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain(latitude)
    expect(serialized).not.toContain(longitude)
    expect(serialized).not.toContain('provider-key')
    expect(serialized).not.toContain('geoapify.com')
  })

  it('keeps reverse geocoding provider failures stage-specific', async () => {
    const places = createEventLogger()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 403 })))

    const placesResponse = await reverseGeocode(routeContext(
      jsonRequest({ lat: '47.68049', lon: '-122.32771' }),
      {} as D1Database,
      places.log,
    ) as never)

    expect(placesResponse.status).toBe(502)
    expect(placesResponse.headers.get(RESULT_DESCRIPTION_HEADER)).toBe('Places lookup provider returned HTTP 403; retry reverse geocoding')
    expect(places.events).toEqual([])

    const fallback = createEventLogger()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ features: [] }))
      .mockRejectedValueOnce(new Error('private provider error')))

    const fallbackResponse = await reverseGeocode(routeContext(
      jsonRequest({ lat: '47.68049', lon: '-122.32771' }),
      {} as D1Database,
      fallback.log,
    ) as never)

    expect(fallbackResponse.status).toBe(502)
    expect(fallbackResponse.headers.get(RESULT_DESCRIPTION_HEADER)).toBe('Reverse geocoding fallback network request failed; retry reverse geocoding')
    expect(fallback.events).toHaveLength(1)
    expect(JSON.stringify(fallback.events)).not.toContain('private provider error')
  })

  it('rejects a null JSON body on the geocoding routes without a 500', async () => {
    const { log } = createEventLogger()
    vi.stubGlobal('fetch', vi.fn())

    const reverseResponse = await reverseGeocode(routeContext(
      jsonRequest(null),
      {} as D1Database,
      log,
    ) as never)
    expect(reverseResponse.status).toBe(400)

    const searchResponse = await searchGeocoding(routeContext(
      jsonRequest(null),
      {} as D1Database,
      log,
    ) as never)
    expect(searchResponse.status).toBe(400)
  })
})