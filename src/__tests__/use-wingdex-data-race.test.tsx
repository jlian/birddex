/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url":"https://wingdex.app/"}
 */
import { act, render } from '@testing-library/react'
import { waitFor } from '@testing-library/dom'
import { useEffect } from 'react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { publishPayload, rollbackItemsById, useWingDexData } from '@/hooks/use-wingdex-data'
import type { Outing } from '@/lib/types'
import type { Observation } from '@/lib/types'
import type { WingDexDataStore } from '@/hooks/use-wingdex-data'

describe('rollbackItemsById', () => {
  it('preserves unrelated concurrent items while removing a failed optimistic insert', () => {
    const previous = [{ id: 'existing', value: 'before' }]
    const current = [
      { id: 'existing', value: 'before' },
      { id: 'optimistic', value: 'pending' },
      { id: 'concurrent', value: 'new' },
    ]

    expect(rollbackItemsById(current, previous, new Set(['optimistic']))).toEqual([
      { id: 'existing', value: 'before' },
      { id: 'concurrent', value: 'new' },
    ])
  })

  it('restores only the prior touched value and preserves unrelated changes', () => {
    const previous = [{ id: 'edited', value: 'before' }]
    const current = [
      { id: 'edited', value: 'optimistic' },
      { id: 'concurrent', value: 'new' },
    ]

    expect(rollbackItemsById(current, previous, new Set(['edited']))).toEqual([
      { id: 'edited', value: 'before' },
      { id: 'concurrent', value: 'new' },
    ])
  })
})

describe('publishPayload', () => {
  it('updates the current snapshot before a chained operation can read it', () => {
    const ref = { current: { observations: [] as string[] } }
    let observedDuringPublish: string[] = []
    const next = { observations: ['new-observation'] }

    publishPayload(ref, next, () => {
      observedDuringPublish = ref.current.observations
    })

    expect(observedDuringPublish).toEqual(['new-observation'])
    expect(ref.current).toBe(next)
  })
})

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function Harness({ userId, hasSession = true, onChange }: { userId: string; hasSession?: boolean; onChange: (store: WingDexDataStore) => void }) {
  const store = useWingDexData(userId, { hasSession })

  useEffect(() => {
    onChange(store)
  }, [store, onChange])

  return null
}

describe('useWingDexData addOuting race handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('ignores a delayed account response after sign-out', async () => {
    const staleResponse = deferred<Response>()
    vi.spyOn(globalThis, 'fetch').mockReturnValue(staleResponse.promise)
    let latest: WingDexDataStore | undefined
    const onChange = (store: WingDexDataStore) => { latest = store }
    const view = render(<Harness userId="account-a" onChange={onChange} />)

    await waitFor(() => expect(latest?.isLoading).toBe(true))
    view.rerender(<Harness userId="guest" hasSession={false} onChange={onChange} />)
    await waitFor(() => expect(latest?.isLoading).toBe(false))

    staleResponse.resolve(jsonResponse({
      outings: [{ id: 'private-outing' }],
      photos: [],
      observations: [],
      dex: [],
    }))
    await act(async () => { await staleResponse.promise })

    expect(latest?.outings).toEqual([])
  })

  it('re-inserts saved outing when a stale refresh overwrote optimistic state', async () => {
    const allRequest = deferred<Response>()
    const createOutingRequest = deferred<Response>()

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)

      if (url === '/api/data/all') {
        return allRequest.promise
      }

      if (url === '/api/data/outings' && init?.method === 'POST') {
        return createOutingRequest.promise
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    let latest: WingDexDataStore | null = null

    render(
      <Harness
        userId="user-1"
        onChange={(store) => {
          latest = store
        }}
      />,
    )

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled()
      expect(latest).not.toBeNull()
    })

    const outing: Outing = {
      id: 'outing_123',
      userId: 'user-1',
      startTime: '2025-01-01T10:00:00.000Z',
      endTime: '2025-01-01T11:00:00.000Z',
      locationName: 'Test Park',
      notes: '',
      createdAt: '2025-01-01T11:05:00.000Z',
    }

    act(() => {
      void latest!.addOuting(outing).catch(() => undefined)
    })

    await waitFor(() => {
      expect(latest?.outings).toHaveLength(1)
      expect(latest?.outings[0].id).toBe('outing_123')
    })

    act(() => {
      allRequest.resolve(jsonResponse({ outings: [], photos: [], observations: [], dex: [] }))
    })

    await waitFor(() => {
      expect(latest?.outings).toHaveLength(0)
    })

    act(() => {
      createOutingRequest.resolve(jsonResponse(outing))
    })

    await waitFor(() => {
      expect(latest?.outings).toHaveLength(1)
      expect(latest?.outings[0].id).toBe('outing_123')
    })
  })

  it('re-inserts saved outing on update ack after stale refresh overwrite', async () => {
    const staleRefresh = deferred<Response>()
    const updateOutingRequest = deferred<Response>()

    const baseOuting: Outing = {
      id: 'outing_1',
      userId: 'user-1',
      startTime: '2025-01-01T10:00:00.000Z',
      endTime: '2025-01-01T11:00:00.000Z',
      locationName: 'Old Park',
      notes: '',
      createdAt: '2025-01-01T11:05:00.000Z',
    }

    const savedOuting: Outing = {
      ...baseOuting,
      locationName: 'New Park',
    }

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)

      if (url === '/api/data/all') {
        if (staleRefresh.promise) {
          const callCount = fetchSpy.mock.calls.filter(call => String(call[0]) === '/api/data/all').length
          if (callCount === 1) {
            return Promise.resolve(jsonResponse({ outings: [baseOuting], photos: [], observations: [], dex: [] }))
          }
          return staleRefresh.promise
        }
      }

      if (url === '/api/data/outings/outing_1' && init?.method === 'PATCH') {
        return updateOutingRequest.promise
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    let latest: WingDexDataStore | null = null

    render(
      <Harness
        userId="user-1"
        onChange={(store) => {
          latest = store
        }}
      />,
    )

    await waitFor(() => {
      expect(latest?.outings).toHaveLength(1)
      expect(latest?.outings[0].locationName).toBe('Old Park')
    })

    act(() => {
      latest!.updateOuting('outing_1', { locationName: 'New Park' })
    })

    await waitFor(() => {
      expect(latest?.outings[0].locationName).toBe('New Park')
    })

    await act(async () => {
      void latest!.refresh()
    })

    act(() => {
      staleRefresh.resolve(jsonResponse({ outings: [], photos: [], observations: [], dex: [] }))
    })

    await waitFor(() => {
      expect(latest?.outings).toHaveLength(0)
    })

    act(() => {
      updateOutingRequest.resolve(jsonResponse(savedOuting))
    })

    await waitFor(() => {
      expect(latest?.outings).toHaveLength(1)
      expect(latest?.outings[0].locationName).toBe('New Park')
    })
  })

  it('re-inserts updated observation on patch ack after stale refresh overwrite', async () => {
    const staleRefresh = deferred<Response>()
    const updateObservationRequest = deferred<Response>()

    const baseOuting: Outing = {
      id: 'outing_1',
      userId: 'user-1',
      startTime: '2025-01-01T10:00:00.000Z',
      endTime: '2025-01-01T11:00:00.000Z',
      locationName: 'Test Park',
      notes: '',
      createdAt: '2025-01-01T11:05:00.000Z',
    }

    const baseObservation: Observation = {
      id: 'obs_1',
      outingId: 'outing_1',
      speciesName: 'American Robin',
      count: 1,
      certainty: 'confirmed',
      notes: 'old',
    }

    const savedObservation: Observation = {
      ...baseObservation,
      notes: 'new',
    }

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)

      if (url === '/api/data/all') {
        const callCount = fetchSpy.mock.calls.filter(call => String(call[0]) === '/api/data/all').length
        if (callCount === 1) {
          return Promise.resolve(jsonResponse({ outings: [baseOuting], photos: [], observations: [baseObservation], dex: [] }))
        }
        return staleRefresh.promise
      }

      if (url === '/api/data/observations' && init?.method === 'PATCH') {
        return updateObservationRequest.promise
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    let latest: WingDexDataStore | null = null

    render(
      <Harness
        userId="user-1"
        onChange={(store) => {
          latest = store
        }}
      />,
    )

    await waitFor(() => {
      expect(latest?.observations).toHaveLength(1)
      expect(latest?.observations[0].notes).toBe('old')
    })

    act(() => {
      latest!.updateObservation('obs_1', { notes: 'new' })
    })

    await waitFor(() => {
      expect(latest?.observations[0].notes).toBe('new')
    })

    await act(async () => {
      void latest!.refresh()
    })

    act(() => {
      staleRefresh.resolve(jsonResponse({ outings: [baseOuting], photos: [], observations: [], dex: [] }))
    })

    await waitFor(() => {
      expect(latest?.observations).toHaveLength(0)
    })

    act(() => {
      updateObservationRequest.resolve(
        jsonResponse({ observation: savedObservation, dexUpdates: [] }),
      )
    })

    await waitFor(() => {
      expect(latest?.observations).toHaveLength(1)
      expect(latest?.observations[0].notes).toBe('new')
    })
  })

  it('re-inserts observations returned by bulk patch after stale refresh overwrite', async () => {
    const staleRefresh = deferred<Response>()
    const bulkUpdateRequest = deferred<Response>()

    const baseOuting: Outing = {
      id: 'outing_1',
      userId: 'user-1',
      startTime: '2025-01-01T10:00:00.000Z',
      endTime: '2025-01-01T11:00:00.000Z',
      locationName: 'Test Park',
      notes: '',
      createdAt: '2025-01-01T11:05:00.000Z',
    }

    const baseObservation: Observation = {
      id: 'obs_1',
      outingId: 'outing_1',
      speciesName: 'American Robin',
      count: 1,
      certainty: 'possible',
      notes: 'old',
    }

    const savedObservation: Observation = {
      ...baseObservation,
      certainty: 'confirmed',
      notes: 'bulk-new',
    }

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)

      if (url === '/api/data/all') {
        const callCount = fetchSpy.mock.calls.filter(call => String(call[0]) === '/api/data/all').length
        if (callCount === 1) {
          return Promise.resolve(jsonResponse({ outings: [baseOuting], photos: [], observations: [baseObservation], dex: [] }))
        }
        return staleRefresh.promise
      }

      if (url === '/api/data/observations' && init?.method === 'PATCH') {
        return bulkUpdateRequest.promise
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    let latest: WingDexDataStore | null = null

    render(
      <Harness
        userId="user-1"
        onChange={(store) => {
          latest = store
        }}
      />,
    )

    await waitFor(() => {
      expect(latest?.observations).toHaveLength(1)
      expect(latest?.observations[0].certainty).toBe('possible')
    })

    act(() => {
      latest!.bulkUpdateObservations(['obs_1'], { certainty: 'confirmed', notes: 'bulk-new' })
    })

    await waitFor(() => {
      expect(latest?.observations[0].certainty).toBe('confirmed')
      expect(latest?.observations[0].notes).toBe('bulk-new')
    })

    await act(async () => {
      void latest!.refresh()
    })

    act(() => {
      staleRefresh.resolve(jsonResponse({ outings: [baseOuting], photos: [], observations: [], dex: [] }))
    })

    await waitFor(() => {
      expect(latest?.observations).toHaveLength(0)
    })

    act(() => {
      bulkUpdateRequest.resolve(
        jsonResponse({ observations: [savedObservation], dexUpdates: [] }),
      )
    })

    await waitFor(() => {
      expect(latest?.observations).toHaveLength(1)
      expect(latest?.observations[0].id).toBe('obs_1')
      expect(latest?.observations[0].certainty).toBe('confirmed')
      expect(latest?.observations[0].notes).toBe('bulk-new')
    })
  })
})
