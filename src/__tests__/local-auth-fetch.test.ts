/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url":"http://localhost:5000/"}
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { signInAnonymous } = vi.hoisted(() => ({
  signInAnonymous: vi.fn(),
}))

vi.mock('@/lib/auth-client', () => ({
  authClient: { signIn: { anonymous: signInAnonymous } },
}))

import { fetchWithLocalAuthRetry } from '@/lib/local-auth-fetch'

describe('fetchWithLocalAuthRetry', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    signInAnonymous.mockReset()
  })

  it('injects one traceparent and retries a local 401 after anonymous sign-in', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    signInAnonymous.mockResolvedValue({ data: { user: { id: 'local-user' } }, error: null })

    const response = await fetchWithLocalAuthRetry('/api/data/all', { credentials: 'include' })

    expect(response.status).toBe(204)
    expect(signInAnonymous).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstTraceparent = new Headers(fetchMock.mock.calls[0][1]?.headers).get('traceparent')
    const retryTraceparent = new Headers(fetchMock.mock.calls[1][1]?.headers).get('traceparent')
    expect(firstTraceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    expect(retryTraceparent).toBe(firstTraceparent)
  })

  it('preserves a caller-provided traceparent', async () => {
    const traceparent = '00-abcdef0123456789abcdef0123456789-abcdef0123456789-01'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

    await fetchWithLocalAuthRetry('/api/data/all', { headers: { traceparent } })

    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('traceparent')).toBe(traceparent)
  })

  it('preserves AbortError without attempting sign-in', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('Aborted', 'AbortError'))

    await expect(fetchWithLocalAuthRetry('/api/data/all')).rejects.toMatchObject({ name: 'AbortError' })
    expect(signInAnonymous).not.toHaveBeenCalled()
  })
})