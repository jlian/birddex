import { describe, expect, it } from 'vitest'
import { createAuth } from './auth'
import type { LogFields, Logger } from './log'

type LoggedEvent = { level: string; operationName: string; fields?: LogFields }

function mockLogger(): { log: Logger; events: LoggedEvent[] } {
  const events: LoggedEvent[] = []
  const log = {
    info: (operationName: string, fields?: LogFields) => events.push({ level: 'Info', operationName, fields }),
    debug: (operationName: string, fields?: LogFields) => events.push({ level: 'Debug', operationName, fields }),
    trace: (operationName: string, fields?: LogFields) => events.push({ level: 'Trace', operationName, fields }),
    warn: (operationName: string, fields?: LogFields) => events.push({ level: 'Warning', operationName, fields }),
    error: (operationName: string, fields?: LogFields) => events.push({ level: 'Error', operationName, fields }),
    critical: (operationName: string, fields?: LogFields) => events.push({ level: 'Critical', operationName, fields }),
    withResource: () => log,
    withResourceId: () => log,
  } satisfies Logger
  return { log, events }
}

const testEnv = {
  BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters',
  BETTER_AUTH_URL: 'https://wingdex.app',
  DB: {} as D1Database,
} as Env

describe('auth routes', () => {
  it('does not expose Better Auth built-in account deletion', async () => {
    const request = new Request('https://wingdex.app/api/auth/delete-user', { method: 'POST' })
    const auth = createAuth(testEnv, { request })

    const context = await auth.$context

    expect(context.options.user?.deleteUser?.enabled).toBe(false)
  })

  it('emits the exact new social account hook sequence with safe provider context', async () => {
    const { log, events } = mockLogger()
    const auth = createAuth(testEnv, {
      request: new Request('https://wingdex.app/api/auth/callback/github'),
      log,
    })
    const hooks = (await auth.$context).options.databaseHooks
    const userAfter = hooks?.user?.create?.after
    const accountAfter = hooks?.account?.create?.after
    const sessionAfter = hooks?.session?.create?.after

    await userAfter?.({ id: 'user-private', isAnonymous: false } as unknown as Parameters<NonNullable<typeof userAfter>>[0])
    await accountAfter?.({ userId: 'user-private', providerId: 'github' } as Parameters<NonNullable<typeof accountAfter>>[0])
    await sessionAfter?.({ userId: 'user-private' } as Parameters<NonNullable<typeof sessionAfter>>[0], null)

    expect(events).toEqual([
      {
        level: 'Info',
        operationName: 'auth/account/create',
        fields: {
          category: 'Application',
          resultType: 'Succeeded',
          resultDescription: 'Created a persistent WingDex account during authentication',
        },
      },
      {
        level: 'Info',
        operationName: 'auth/provider/link',
        fields: {
          category: 'Application',
          resultType: 'Succeeded',
          resultDescription: 'Linked the github provider to a newly created WingDex account during authentication',
        },
      },
      {
        level: 'Info',
        operationName: 'auth/session/create',
        fields: {
          category: 'Application',
          resultType: 'Succeeded',
          resultDescription: 'Created a server session for a newly created persistent account',
        },
      },
    ])
    expect(JSON.stringify(events)).not.toContain('user-private')
  })

  it('distinguishes anonymous, existing-account link, passkey session, and confirmed sign-out hooks', async () => {
    const { log, events } = mockLogger()
    const auth = createAuth(testEnv, {
      request: new Request('https://wingdex.app/api/auth/sign-in/anonymous'),
      log,
    })
    const hooks = (await auth.$context).options.databaseHooks
    const userAfter = hooks?.user?.create?.after
    const accountAfter = hooks?.account?.create?.after
    const sessionCreateAfter = hooks?.session?.create?.after
    const sessionDeleteAfter = hooks?.session?.delete?.after

    await userAfter?.({ id: 'anonymous-private', isAnonymous: true } as unknown as Parameters<NonNullable<typeof userAfter>>[0])
    await sessionCreateAfter?.({ userId: 'anonymous-private' } as Parameters<NonNullable<typeof sessionCreateAfter>>[0], null)
    await accountAfter?.({ userId: 'existing-private', providerId: 'apple' } as Parameters<NonNullable<typeof accountAfter>>[0])
    await sessionCreateAfter?.(
      { userId: 'existing-private' } as Parameters<NonNullable<typeof sessionCreateAfter>>[0],
      { path: '/passkey/verify-authentication' } as Parameters<NonNullable<typeof sessionCreateAfter>>[1],
    )
    await sessionDeleteAfter?.(
      {} as Parameters<NonNullable<typeof sessionDeleteAfter>>[0],
      { path: '/revoke-session' } as Parameters<NonNullable<typeof sessionDeleteAfter>>[1],
    )
    await sessionDeleteAfter?.(
      {} as Parameters<NonNullable<typeof sessionDeleteAfter>>[0],
      { path: '/sign-out' } as Parameters<NonNullable<typeof sessionDeleteAfter>>[1],
    )

    expect(events.map(event => [event.operationName, event.fields?.resultDescription])).toEqual([
      ['auth/account/create', 'Created a temporary anonymous WingDex account for the guest session'],
      ['auth/session/create', 'Created a server session for a newly created temporary anonymous account'],
      ['auth/provider/link', 'Linked the apple provider to an existing WingDex account during authentication'],
      ['auth/session/create', 'Created a server session after successful passkey authentication'],
      ['auth/session/delete', 'Deleted the server session during sign-out; the authentication cookie can now be cleared'],
    ])
    expect(events.every(event => event.fields?.category === 'Application')).toBe(true)
    expect(events.some(event => event.operationName === 'auth/sessions/invoke')).toBe(false)
  })

  it('does not echo arbitrary provider values from account hooks', async () => {
    const { log, events } = mockLogger()
    const auth = createAuth(testEnv, {
      request: new Request('https://wingdex.app/api/auth/callback/unknown'),
      log,
    })
    const accountAfter = (await auth.$context).options.databaseHooks?.account?.create?.after

    await accountAfter?.(
      { userId: 'private-user', providerId: 'private-provider-value' } as Parameters<NonNullable<typeof accountAfter>>[0],
    )

    expect(events[0]?.fields?.resultDescription).toBe(
      'Linked an unsupported provider to an existing WingDex account during authentication',
    )
    expect(JSON.stringify(events)).not.toContain('private-provider-value')
  })
})
