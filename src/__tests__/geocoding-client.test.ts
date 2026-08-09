import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchPlaces } from '@/lib/geocoding'

describe('geocoding client', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('aborts a stalled Worker request after six seconds', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    ))
    vi.stubGlobal('fetch', fetchMock)

    const request = searchPlaces('Green Lake')
    const expectation = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(6_000)
    await expectation

    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })
})