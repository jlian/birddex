import { generateTraceparent } from '@/lib/trace'

export function isLocalRuntime(): boolean {
  if (typeof window === 'undefined') return false
  const host = window.location.hostname.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1'
}

/** Inject traceparent header into fetch init for distributed tracing. */
function withTraceparent(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers)
  if (!headers.has('traceparent')) {
    headers.set('traceparent', generateTraceparent())
  }
  return { ...init, headers }
}

/**
 * Fetch with a traceparent header.
 *
 * This used to sign in anonymously and retry whenever a request 401d on
 * localhost. That hid the signed-out state during local development: an
 * account appeared implicitly on the first failed request, so local behavior
 * never matched hosted, and guest-mode bugs could not be reproduced locally.
 *
 * Callers that need an account now create one deliberately (see
 * ensureAnonymousSession in App.tsx), which is the same thing hosted does.
 *
 * The name is kept because it is used in a dozen call sites and still marks
 * the requests that carry tracing; only the implicit sign-in is gone.
 */
export async function fetchWithLocalAuthRetry(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return await fetch(input, withTraceparent(init))
}
