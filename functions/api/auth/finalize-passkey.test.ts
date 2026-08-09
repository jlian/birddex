import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RESULT_DESCRIPTION_HEADER } from '../../lib/log'

const { createAuthMock, waitForPasskeyOwnershipMock } = vi.hoisted(() => ({
  createAuthMock: vi.fn(),
  waitForPasskeyOwnershipMock: vi.fn(),
}))

vi.mock('../../lib/auth', () => ({ createAuth: createAuthMock }))
vi.mock('../../lib/passkey-ownership', () => ({
  waitForPasskeyOwnership: waitForPasskeyOwnershipMock,
}))

import { onRequestPost } from './finalize-passkey'

function contextWithUpdateChanges(changes: number) {
  const run = vi.fn(async () => ({ meta: { changes } }))
  const statement = {
    bind() { return this },
    run,
  }
  return {
    request: new Request('https://wingdex.example/api/auth/finalize-passkey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Birder', passkeyId: 'private-passkey-id' }),
    }),
    env: {
      DB: { prepare: vi.fn(() => statement) },
    },
    data: {
      log: {},
      traceId: 'trace-id',
      spanId: 'span-id',
    },
  } as unknown as Parameters<typeof onRequestPost>[0]
}

describe('passkey account finalization', () => {
  beforeEach(() => {
    createAuthMock.mockReset()
    waitForPasskeyOwnershipMock.mockReset()
    createAuthMock.mockReturnValue({
      api: {
        getSession: vi.fn(async () => ({ user: { id: 'private-user-id', name: 'Birder' } })),
      },
    })
    waitForPasskeyOwnershipMock.mockResolvedValue(true)
  })

  it('emits upgrade success only after the user row changes', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})

    const response = await onRequestPost(contextWithUpdateChanges(1)) as Response

    expect(response.status).toBe(200)
    expect(consoleLog).toHaveBeenCalledOnce()
    expect(consoleLog.mock.calls[0][0]).toMatchObject({
      operationName: 'auth/account/upgrade',
      category: 'Application',
      resultType: 'Succeeded',
      resultDescription: 'Upgraded the temporary anonymous account to a persistent passkey-backed WingDex account',
    })
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain('private-passkey-id')
    consoleLog.mockRestore()
  })

  it('returns an informative failure and emits no success event when no user row changes', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})

    const response = await onRequestPost(contextWithUpdateChanges(0)) as Response

    expect(response.status).toBe(409)
    expect(await response.text()).toBe('Account no longer available')
    expect(response.headers.get(RESULT_DESCRIPTION_HEADER)).toBe(
      'Passkey account upgrade did not update an account row; sign in again before retrying finalization',
    )
    expect(consoleLog).not.toHaveBeenCalled()
    consoleLog.mockRestore()
  })
})