import { describe, expect, it } from 'vitest'
import { logDurableAuthRouteOutcome } from './[[path]]'
import { logNativeAppleRevocationCredentialStorage } from './apple/revocation-token'
import { logPasskeyAccountUpgrade } from './finalize-passkey'
import type { LogFields, Logger } from '../../lib/log'

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

describe('route-owned auth lifecycle events', () => {
  it('emits passkey create and delete only after successful durable plugin routes', () => {
    const { log, events } = mockLogger()
    logDurableAuthRouteOutcome(log, 'POST', '/api/auth/passkey/verify-registration', 200)
    logDurableAuthRouteOutcome(log, 'POST', '/api/auth/passkey/delete-passkey', 200)
    logDurableAuthRouteOutcome(log, 'POST', '/api/auth/passkey/delete-passkey', 400)
    logDurableAuthRouteOutcome(log, 'GET', '/api/auth/passkey/list-user-passkeys', 200)

    expect(events).toEqual([
      {
        level: 'Info',
        operationName: 'auth/passkey/create',
        fields: {
          category: 'Application',
          resultType: 'Succeeded',
          resultDescription: 'Registered and durably stored a passkey for the authenticated account',
        },
      },
      {
        level: 'Info',
        operationName: 'auth/passkey/delete',
        fields: {
          category: 'Application',
          resultType: 'Succeeded',
          resultDescription: 'Deleted a passkey owned by the authenticated account',
        },
      },
    ])
    expect(events.some(event => event.operationName === 'auth/sessions/invoke')).toBe(false)
  })

  it('emits exact Apple storage and passkey account upgrade outcomes', () => {
    const { log, events } = mockLogger()
    logNativeAppleRevocationCredentialStorage(log)
    logPasskeyAccountUpgrade(log)

    expect(events).toEqual([
      {
        level: 'Info',
        operationName: 'auth/appleRevocationToken/write',
        fields: {
          category: 'Application',
          resultType: 'Succeeded',
          resultDescription: 'Durably stored native Apple revocation credentials for future account deletion',
        },
      },
      {
        level: 'Info',
        operationName: 'auth/account/upgrade',
        fields: {
          category: 'Application',
          resultType: 'Succeeded',
          resultDescription: 'Upgraded the temporary anonymous account to a persistent passkey-backed WingDex account',
        },
      },
    ])
    expect(events.every(event => event.fields?.category === 'Application')).toBe(true)
  })
})