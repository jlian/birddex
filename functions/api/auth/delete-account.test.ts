import { describe, expect, it, vi } from 'vitest'
import { logAccountDeletionEvent } from './delete-account'
import { revokeProvidersAndDeleteUser, type ProviderAccount } from '../../lib/provider-revocation'
import type { LogFields, Logger } from '../../lib/log'

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type LoggedEvent = { level: string; operationName: string; fields?: LogFields }

const env = {
  APPLE_APP_CLIENT_SECRET: 'apple-app-secret',
  APPLE_CLIENT_ID: 'app.wingdex.signin',
  APPLE_CLIENT_SECRET: 'apple-web-secret',
  GITHUB_CLIENT_ID: 'github-client',
  GITHUB_CLIENT_SECRET: 'github-secret',
  GOOGLE_CLIENT_ID: 'google-client',
  GOOGLE_CLIENT_SECRET: 'google-secret',
}

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

function mockDb(
  accounts: ProviderAccount[],
  options: { preflightFailure?: boolean; deleteFailure?: boolean; deleteChanges?: number } = {},
): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() { return this },
        async all() {
          if (options.preflightFailure) throw new Error('private database error')
          return { results: accounts }
        },
        async run() {
          if (sql.startsWith('DELETE') && options.deleteFailure) throw new Error('private database error')
          return { meta: { changes: options.deleteChanges ?? 1 } }
        },
      }
    },
  } as unknown as D1Database
}

async function deletionEvents(
  accounts: ProviderAccount[],
  fetcher: Fetcher = vi.fn(async () => new Response(null, { status: 204 })),
  options: { preflightFailure?: boolean; deleteFailure?: boolean; deleteChanges?: number } = {},
): Promise<LoggedEvent[]> {
  const { log, events } = mockLogger()
  await revokeProvidersAndDeleteUser(
    mockDb(accounts, options),
    'private-user-id',
    env,
    fetcher,
    event => logAccountDeletionEvent(log, event),
  )
  return events
}

function summaries(events: LoggedEvent[]) {
  return events.map(event => [event.level, event.operationName, event.fields?.resultType, event.fields?.resultDescription])
}

describe('account deletion Application events', () => {
  it('emits only a failed preflight outcome when linked-provider lookup fails', async () => {
    const { log, events } = mockLogger()
    await expect(revokeProvidersAndDeleteUser(
      mockDb([], { preflightFailure: true }),
      'private-user-id',
      env,
      fetch,
      event => logAccountDeletionEvent(log, event),
    )).rejects.toMatchObject({ stage: 'linked-provider-preflight' })

    expect(summaries(events)).toEqual([[
      'Error',
      'auth/linkedProviders/read',
      'Failed',
      'Could not read linked providers before account deletion; no provider revocation or local deletion was started',
    ]])
  })

  it('stops after an external provider failure and records the safe upstream status', async () => {
    const { log, events } = mockLogger()
    const fetcher = vi.fn<Fetcher>(async () => new Response(null, { status: 503 }))
    await expect(revokeProvidersAndDeleteUser(
      mockDb([{ providerId: 'github', accessToken: 'private-token' }]),
      'private-user-id',
      env,
      fetcher,
      event => logAccountDeletionEvent(log, event),
    )).rejects.toMatchObject({ providerId: 'github', status: 503 })

    expect(summaries(events)).toEqual([
      ['Info', 'auth/linkedProviders/read', 'Succeeded', 'Found 1 linked provider to process before account deletion'],
      ['Info', 'auth/provider/revoke', undefined, 'Started GitHub credential revocation before local account deletion'],
      ['Error', 'auth/provider/revoke', 'Failed', 'GitHub credential revocation failed with upstream HTTP 503; local account deletion was stopped before durable local changes'],
    ])
  })

  it('uses Warning and Failed semantics for manual Apple revocation while local deletion continues', async () => {
    const events = await deletionEvents([{ providerId: 'apple' }])

    expect(summaries(events)).toEqual([
      ['Info', 'auth/linkedProviders/read', 'Succeeded', 'Found 1 linked provider to process before account deletion'],
      ['Info', 'auth/provider/revoke', undefined, 'Started Apple credential revocation before local account deletion'],
      ['Warning', 'auth/provider/revoke', 'Failed', 'Apple revocation credentials were unavailable; local account deletion will continue, but manual revocation in Apple Account settings is required'],
      ['Info', 'auth/account/delete', undefined, 'Started durable local account deletion after linked-provider processing completed'],
      ['Info', 'auth/account/delete', 'Succeeded', 'Deleted the local WingDex account and its cascaded account data after linked-provider processing'],
    ])
  })

  it('emits the exact successful provider and local deletion sequence without a terminal-style duplicate', async () => {
    const events = await deletionEvents([
      { providerId: 'credential' },
      { providerId: 'github', accessToken: 'private-token' },
    ])

    expect(summaries(events)).toEqual([
      ['Info', 'auth/linkedProviders/read', 'Succeeded', 'Found 2 linked providers to process before account deletion'],
      ['Info', 'auth/provider/revoke', 'Succeeded', 'No external revocation is required for a credential account; local account deletion can proceed'],
      ['Info', 'auth/provider/revoke', undefined, 'Started GitHub credential revocation before local account deletion'],
      ['Info', 'auth/provider/revoke', 'Succeeded', 'Revoked GitHub credentials; local account deletion can proceed after remaining linked providers are processed'],
      ['Info', 'auth/account/delete', undefined, 'Started durable local account deletion after linked-provider processing completed'],
      ['Info', 'auth/account/delete', 'Succeeded', 'Deleted the local WingDex account and its cascaded account data after linked-provider processing'],
    ])
    expect(events.filter(event => !event.fields?.resultDescription?.startsWith('Started '))
      .every(event => event.fields?.resultType !== undefined)).toBe(true)
    expect(events.every(event => event.fields?.category === 'Application')).toBe(true)
    expect(events.some(event => event.operationName === 'auth/sessions/invoke')).toBe(false)
    expect(JSON.stringify(events)).not.toContain('private-token')
    expect(JSON.stringify(events)).not.toContain('private-user-id')
  })

  it('records local deletion failure after provider processing', async () => {
    const { log, events } = mockLogger()
    await expect(revokeProvidersAndDeleteUser(
      mockDb([], { deleteFailure: true }),
      'private-user-id',
      env,
      fetch,
      event => logAccountDeletionEvent(log, event),
    )).rejects.toMatchObject({ stage: 'local-deletion' })

    expect(summaries(events)).toEqual([
      ['Info', 'auth/linkedProviders/read', 'Succeeded', 'Found 0 linked providers to process before account deletion'],
      ['Info', 'auth/account/delete', undefined, 'Started durable local account deletion after linked-provider processing completed'],
      ['Error', 'auth/account/delete', 'Failed', 'Local account deletion failed after linked-provider processing; retry account deletion to complete the durable local transition'],
    ])
  })

  it('records local deletion failure when no user row changed', async () => {
    const { log, events } = mockLogger()
    await expect(revokeProvidersAndDeleteUser(
      mockDb([], { deleteChanges: 0 }),
      'private-user-id',
      env,
      fetch,
      event => logAccountDeletionEvent(log, event),
    )).rejects.toMatchObject({ stage: 'local-deletion' })

    expect(summaries(events)).toEqual([
      ['Info', 'auth/linkedProviders/read', 'Succeeded', 'Found 0 linked providers to process before account deletion'],
      ['Info', 'auth/account/delete', undefined, 'Started durable local account deletion after linked-provider processing completed'],
      ['Error', 'auth/account/delete', 'Failed', 'Local account deletion failed after linked-provider processing; retry account deletion to complete the durable local transition'],
    ])
  })
})