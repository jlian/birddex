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

  it('injects a traceparent and does not sign in on a 401', async () => {
    // The implicit sign-in-and-retry was removed: it only ran on localhost, so
    // local dev never saw the signed-out state and guest-mode bugs could not be
    // reproduced there. A 401 is now returned to the caller, exactly as hosted.
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))

    const response = await fetchWithLocalAuthRetry('/api/data/all', { credentials: 'include' })

    expect(response.status).toBe(401)
    expect(signInAnonymous).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const traceparent = new Headers(fetchMock.mock.calls[0][1]?.headers).get('traceparent')
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
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