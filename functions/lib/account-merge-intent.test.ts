import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  accountMergeSourceBearer,
  accountMergeTokenHash,
  createAccountMergeIntent,
  findPendingAccountMergeIntent,
  getAccountMergeIntent,
} from './account-merge-intent'

function database(): { sqlite: DatabaseSync; d1: D1Database } {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON')
  for (const file of readdirSync(path.resolve('migrations')).filter(file => file.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(path.resolve('migrations', file), 'utf8'))
  }

  function prepared(sql: string) {
    let parameters: SQLInputValue[] = []
    const statement = {
      bind(...values: SQLInputValue[]) { parameters = values; return statement },
      async first<T>() { return (sqlite.prepare(sql).get(...parameters) as T | undefined) ?? null },
      run() {
        const result = sqlite.prepare(sql).run(...parameters)
        return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }
      },
    }
    return statement
  }

  const d1 = {
    prepare: prepared,
    async batch(statements: Array<ReturnType<typeof prepared>>) {
      sqlite.exec('BEGIN')
      try {
        const results = statements.map(statement => statement.run())
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  } as unknown as D1Database
  return { sqlite, d1 }
}

function seedUser(sqlite: DatabaseSync, options: { anonymous?: boolean; expired?: boolean } = {}) {
  sqlite.prepare(`
    INSERT INTO user (id, name, email, isAnonymous)
    VALUES ('source-user', 'quiet-heron', 'temp@example.com', ?)
  `).run(options.anonymous === false ? 0 : 1)
  sqlite.prepare(`
    INSERT INTO session (id, userId, token, expiresAt)
    VALUES ('source-session', 'source-user', 'raw-token', datetime('now', ?))
  `).run(options.expired ? '-1 minute' : '+1 hour')
}

describe('account merge intent', () => {
  it('creates a hashed, provider-bound intent from the anonymous session', async () => {
    const { sqlite, d1 } = database()
    seedUser(sqlite)

    const token = await createAccountMergeIntent(d1, 'source-session', 'github')
    const intent = await getAccountMergeIntent(d1, token)

    expect(intent).toMatchObject({
      sourceUserId: 'source-user',
      sourceSessionId: 'source-session',
      authMethod: 'github',
      status: 'pending',
    })
    expect(intent?.tokenHash).toBe(await accountMergeTokenHash(token))
    expect(intent?.tokenHash).not.toBe(token)
    await expect(findPendingAccountMergeIntent(d1, 'source-user', 'source-session'))
      .resolves.toMatchObject({ authMethod: 'github' })
  })

  it('supersedes an older pending intent for the same source session', async () => {
    const { sqlite, d1 } = database()
    seedUser(sqlite)

    const firstToken = await createAccountMergeIntent(d1, 'source-session', 'github')
    const secondToken = await createAccountMergeIntent(d1, 'source-session', 'google')

    await expect(getAccountMergeIntent(d1, firstToken)).resolves.toBeNull()
    await expect(getAccountMergeIntent(d1, secondToken)).resolves.toMatchObject({ authMethod: 'google' })
  })

  it('never deletes a target-bound retry while preparing another ceremony', async () => {
    const { sqlite, d1 } = database()
    seedUser(sqlite)
    const token = await createAccountMergeIntent(d1, 'source-session', 'github')
    sqlite.exec(`
      UPDATE account_merge_intent
      SET targetUserId = 'target-user', expiresAt = datetime('now', '-2 days')
    `)

    await expect(createAccountMergeIntent(d1, 'source-session', 'google')).rejects.toThrow()
    await expect(getAccountMergeIntent(d1, token)).resolves.toMatchObject({
      targetUserId: 'target-user',
      authMethod: 'github',
    })
  })

  it('rejects registered, expired, and unknown source sessions', async () => {
    for (const options of [{ anonymous: false }, { expired: true }]) {
      const { sqlite, d1 } = database()
      seedUser(sqlite, options)
      await expect(createAccountMergeIntent(d1, 'source-session', 'apple'))
        .rejects.toThrow('current anonymous session')
    }

    const { d1 } = database()
    await expect(createAccountMergeIntent(d1, 'missing-session', 'passkey'))
      .rejects.toThrow('current anonymous session')
  })

  it('does not return expired pending intents for finalization', async () => {
    const { sqlite, d1 } = database()
    seedUser(sqlite)
    const token = await createAccountMergeIntent(d1, 'source-session', 'passkey')
    sqlite.exec("UPDATE account_merge_intent SET expiresAt = datetime('now', '-1 second')")

    await expect(findPendingAccountMergeIntent(d1, 'source-user', 'source-session')).resolves.toBeNull()
    await expect(getAccountMergeIntent(d1, token)).resolves.toMatchObject({ status: 'pending' })
  })

  it('recovers the source bearer only for the bound method and live anonymous session', async () => {
    const { sqlite, d1 } = database()
    seedUser(sqlite)
    const token = await createAccountMergeIntent(d1, 'source-session', 'github')

    await expect(accountMergeSourceBearer(d1, token, 'github')).resolves.toBe('raw-token')
    await expect(accountMergeSourceBearer(d1, token, 'google')).resolves.toBeNull()
    sqlite.exec("UPDATE session SET expiresAt = datetime('now', '-1 second')")
    await expect(accountMergeSourceBearer(d1, token, 'github')).resolves.toBeNull()
  })
})