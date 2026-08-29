import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RESULT_DESCRIPTION_HEADER } from '../../../lib/log'

const dependencies = vi.hoisted(() => ({
  createAccountMergeIntent: vi.fn(),
  createAuth: vi.fn(),
  finalizationEnabled: vi.fn(),
  finalizeAccountMerge: vi.fn(),
  finalizeBoundAccountMerges: vi.fn(),
}))

vi.mock('../../../lib/account-merge-intent', () => ({
  createAccountMergeIntent: dependencies.createAccountMergeIntent,
}))
vi.mock('../../../lib/account-merge', () => ({
  accountMergeFinalizationEnabled: dependencies.finalizationEnabled,
  finalizeAccountMerge: dependencies.finalizeAccountMerge,
  finalizeBoundAccountMerges: dependencies.finalizeBoundAccountMerges,
}))
vi.mock('../../../lib/auth', () => ({ createAuth: dependencies.createAuth }))

import { onRequestPost as prepareMerge } from './prepare'
import { onRequestPost as finalizeMerge } from './finalize'

const origin = 'https://wingdex.test'

function context(
  path: string,
  body: unknown,
  options: { requestOrigin?: string; env?: Partial<Env> } = {},
) {
  return {
    request: new Request(`${origin}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: options.requestOrigin ?? origin,
      },
      body: JSON.stringify(body),
    }),
    env: { DB: {} as D1Database, ...options.env } as Env,
    data: {},
  }
}

function description(response: Response): string | null {
  return response.headers.get(RESULT_DESCRIPTION_HEADER)
}

describe('account merge routes', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    dependencies.finalizationEnabled.mockReturnValue(true)
    dependencies.createAccountMergeIntent.mockResolvedValue('t'.repeat(43))
    dependencies.finalizeAccountMerge.mockResolvedValue({
      status: 'completed',
      sourceUserId: 'source-user',
      targetUserId: 'target-user',
      promoted: false,
      outings: 2,
      observations: 5,
      photos: 3,
    })
    dependencies.finalizeBoundAccountMerges.mockResolvedValue([])
    dependencies.createAuth.mockReturnValue({
      api: {
        getSession: vi.fn(async () => ({
          session: { id: 'source-session' },
          user: { id: 'source-user', isAnonymous: true },
        })),
      },
    })
  })

  it('prepares from the authenticated anonymous session and ignores caller IDs', async () => {
    const response = await prepareMerge(context('/api/auth/merge/prepare', {
      authMethod: 'github',
      sourceUserId: 'caller-source',
      sourceSessionId: 'caller-session',
    }) as never) as Response

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({ token: 't'.repeat(43) })
    expect(dependencies.createAccountMergeIntent)
      .toHaveBeenCalledWith(expect.anything(), 'source-session', 'github')
    expect(JSON.stringify(dependencies.createAccountMergeIntent.mock.calls)).not.toContain('caller-')
  })

  it('rejects cross-origin, unsupported, and non-anonymous preparation', async () => {
    const crossOrigin = await prepareMerge(context('/api/auth/merge/prepare', {
      authMethod: 'github',
    }, { requestOrigin: 'https://attacker.test' }) as never) as Response
    expect(crossOrigin.status).toBe(403)

    const unsupported = await prepareMerge(context('/api/auth/merge/prepare', {
      authMethod: 'private-provider',
    }) as never) as Response
    expect(unsupported.status).toBe(400)

    dependencies.createAuth.mockReturnValueOnce({
      api: { getSession: vi.fn(async () => ({
        session: { id: 'registered-session' },
        user: { id: 'registered-user', isAnonymous: false },
      })) },
    })
    const registered = await prepareMerge(context('/api/auth/merge/prepare', {
      authMethod: 'passkey',
    }) as never) as Response
    expect(registered.status).toBe(401)
    expect(dependencies.createAccountMergeIntent).not.toHaveBeenCalled()
  })

  it('keeps preparation failures generic and free of private errors', async () => {
    dependencies.createAccountMergeIntent.mockRejectedValueOnce(new Error('private database details'))
    const response = await prepareMerge(context('/api/auth/merge/prepare', {
      authMethod: 'apple',
    }) as never) as Response

    expect(response.status).toBe(409)
    const body = await response.text()
    expect(body).toBe('Account merge could not be prepared')
    expect(description(response)).toBe('The anonymous session changed before its merge intent could be stored')
    expect(`${body} ${description(response)}`).not.toContain('private')
  })

  it('finalizes against the authenticated registered target and returns counts', async () => {
    dependencies.createAuth.mockReturnValueOnce({
      api: { getSession: vi.fn(async () => ({
        session: { id: 'target-session' },
        user: { id: 'target-user', isAnonymous: false },
      })) },
    })
    const response = await finalizeMerge(context('/api/auth/merge/finalize', {
      token: 't'.repeat(43),
      targetUserId: 'caller-target',
    }) as never) as Response

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ observations: 5, targetUserId: 'target-user' })
    expect(dependencies.finalizeAccountMerge)
      .toHaveBeenCalledWith(expect.anything(), 't'.repeat(43), 'target-user')
    expect(JSON.stringify(dependencies.finalizeAccountMerge.mock.calls)).not.toContain('caller-target')
  })

  it('preserves retry when disabled or when finalization fails', async () => {
    dependencies.finalizationEnabled.mockReturnValueOnce(false)
    const disabled = await finalizeMerge(context('/api/auth/merge/finalize', {
      token: 't'.repeat(43),
    }) as never) as Response
    expect(disabled.status).toBe(503)
    expect(description(disabled)).toBe('The merge intent was preserved for retry')
    expect(dependencies.finalizeAccountMerge).not.toHaveBeenCalled()

    dependencies.createAuth.mockReturnValueOnce({
      api: { getSession: vi.fn(async () => ({
        session: { id: 'target-session' },
        user: { id: 'target-user', isAnonymous: false },
      })) },
    })
    dependencies.finalizeAccountMerge.mockRejectedValueOnce(new Error('private merge failure'))
    const failed = await finalizeMerge(context('/api/auth/merge/finalize', {
      token: 't'.repeat(43),
    }) as never) as Response
    expect(failed.status).toBe(409)
    expect(description(failed)).toBe('The anonymous source and merge intent were preserved for retry')
    expect(`${await failed.text()} ${description(failed)}`).not.toContain('private')
  })

  it('discovers target-bound retries without a client token', async () => {
    dependencies.createAuth.mockReturnValueOnce({
      api: { getSession: vi.fn(async () => ({
        session: { id: 'target-session' },
        user: { id: 'target-user', isAnonymous: false },
      })) },
    })
    dependencies.finalizeBoundAccountMerges.mockResolvedValueOnce([{
      status: 'completed',
      sourceUserId: 'source-user',
      targetUserId: 'target-user',
      promoted: false,
      outings: 1,
      observations: 2,
      photos: 3,
    }])

    const response = await finalizeMerge(context('/api/auth/merge/finalize', {}) as never) as Response

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'completed', observations: 2 })
    expect(dependencies.finalizeAccountMerge).not.toHaveBeenCalled()
    expect(dependencies.finalizeBoundAccountMerges)
      .toHaveBeenCalledWith(expect.anything(), 'target-user')
  })
})