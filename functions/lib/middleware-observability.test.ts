import { describe, expect, it } from 'vitest'
import { extractEntitySegment, onRequest, resolveOperation } from '../_middleware'
import { RESULT_DESCRIPTION_HEADER, RESULT_TYPE_HEADER } from './log'

describe('middleware observability metadata', () => {
  it('uses stable route templates for dynamic outing paths', () => {
    expect(resolveOperation('/api/data/outings/outing_123', 'DELETE')).toEqual({
      op: 'data/outings/delete',
      category: 'Application',
      route: '/api/data/outings/:id',
    })
    expect(resolveOperation('/api/export/outing/outing_123', 'GET')).toEqual({
      op: 'export/outingCsv/export',
      category: 'Application',
      route: '/api/export/outing/:id',
    })
  })

  it('does not classify static-route prefix collisions as real operations', () => {
    expect(resolveOperation('/api/geocoding/search-extra', 'POST')).toMatchObject({
      op: 'requests/unknown',
      route: '/api/:unknown',
    })
    expect(resolveOperation('/api/data/all/private', 'GET')).toMatchObject({
      op: 'requests/unknown',
      route: '/api/:unknown',
    })
  })

  it('does not classify extra dynamic path segments as an outing operation', () => {
    expect(resolveOperation('/api/data/outings/outing_123/private', 'DELETE')).toMatchObject({
      op: 'requests/unknown',
      route: '/api/:unknown',
    })
  })

  it('adds only generated UUID outing IDs to resource metadata', () => {
    expect(extractEntitySegment('/api/data/outings/outing_123')).toBeNull()
    expect(extractEntitySegment('/api/data/outings/private-user-content')).toBeNull()
    expect(extractEntitySegment('/api/data/outings/outing_123e4567-e89b-42d3-a456-426614174000'))
      .toBe('outings/outing_123e4567-e89b-42d3-a456-426614174000')
  })

  it('does not expose outcome metadata on a healthy health response', async () => {
    const response = await onRequest({
      request: new Request('https://example.com/api/health'),
      env: {},
      data: {},
      next: async () => new Response(null, {
        headers: {
          [RESULT_DESCRIPTION_HEADER]: 'D1 health check succeeded',
          [RESULT_TYPE_HEADER]: 'Succeeded',
        },
      }),
      waitUntil: () => {},
    } as unknown as EventContext<Env, string, Record<string, unknown>>)

    expect(response.headers.has(RESULT_DESCRIPTION_HEADER)).toBe(false)
    expect(response.headers.has(RESULT_TYPE_HEADER)).toBe(false)
  })
})
