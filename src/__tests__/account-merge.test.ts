/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bindPendingAccountMergeTarget,
  discardPendingAccountMergeToken,
  discardUnboundAccountMergeToken,
  finalizeAccountMerge,
  pendingAccountMergeToken,
  pendingAccountMergeTarget,
  prepareAccountMerge,
} from '@/lib/account-merge'

describe('account merge client', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    discardPendingAccountMergeToken()
  })

  it('stores the opaque ticket across an authentication redirect', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ token: 't'.repeat(43) })))

    await expect(prepareAccountMerge('github')).resolves.toBe('t'.repeat(43))
    expect(pendingAccountMergeToken()).toBe('t'.repeat(43))
  })

  it('clears the ticket only after successful finalization', async () => {
    window.sessionStorage.setItem('wingdex.accountMergeToken', 't'.repeat(43))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('retry', { status: 503 }))
      .mockResolvedValueOnce(Response.json({
        status: 'completed',
        sourceUserId: 'source',
        targetUserId: 'target',
        promoted: false,
        outings: 1,
        observations: 2,
        photos: 3,
      }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(finalizeAccountMerge()).rejects.toThrow('503')
    expect(pendingAccountMergeToken()).toBe('t'.repeat(43))
    await expect(finalizeAccountMerge()).resolves.toMatchObject({ targetUserId: 'target' })
    expect(pendingAccountMergeToken()).toBeNull()
  })

  it('preserves bound recovery across sign-out and rejects a different target', () => {
    window.sessionStorage.setItem('wingdex.accountMergeToken', 't'.repeat(43))
    bindPendingAccountMergeTarget('target-1')

    discardUnboundAccountMergeToken()
    expect(pendingAccountMergeToken()).toBe('t'.repeat(43))
    expect(pendingAccountMergeTarget()).toBe('target-1')
    expect(() => bindPendingAccountMergeTarget('target-2')).toThrow('another target')
  })

  it('discards an unbound intent when its anonymous session is abandoned', () => {
    window.sessionStorage.setItem('wingdex.accountMergeToken', 't'.repeat(43))

    discardUnboundAccountMergeToken()

    expect(pendingAccountMergeToken()).toBeNull()
    expect(pendingAccountMergeTarget()).toBeNull()
  })

  it('checks server-side bound recovery without a local token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ status: 'none' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(finalizeAccountMerge()).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/merge/finalize', expect.objectContaining({
      body: '{}',
    }))
  })
})