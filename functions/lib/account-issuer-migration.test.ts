import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAuth } from './auth'

const migrationsDirectory = path.resolve('migrations')

function applyMigrations(db: DatabaseSync, through = '0010_better_auth_account_issuer.sql') {
  const files = readdirSync(migrationsDirectory)
    .filter(file => file.endsWith('.sql') && file <= through)
    .sort()
  for (const file of files) {
    db.exec(readFileSync(path.join(migrationsDirectory, file), 'utf8'))
  }
}

function d1Database(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let parameters: SQLInputValue[] = []
      const statement = {
        bind(...values: SQLInputValue[]) {
          parameters = values
          return statement
        },
        async all<T>() {
          const rows = db.prepare(sql).all(...parameters) as T[]
          return {
            results: rows,
            success: true,
            meta: { changes: 0, last_row_id: 0 },
          }
        },
      }
      return statement as unknown as D1PreparedStatement
    },
  } as unknown as D1Database
}

function authEnv(db: DatabaseSync): Env {
  return {
    DB: d1Database(db),
    BETTER_AUTH_SECRET: 'test-secret-at-least-32-characters-long',
    BETTER_AUTH_URL: 'http://localhost:5000',
    GITHUB_CLIENT_ID: 'test-github-id',
    GITHUB_CLIENT_SECRET: 'test-github-secret',
  } as Env
}

describe('Better Auth account issuer ownership lookup', () => {
  it('fails against the pre-1.7 account schema', async () => {
    const db = new DatabaseSync(':memory:')
    applyMigrations(db, '0009_import_identity.sql')
    db.exec(`
      INSERT INTO user (id, name, email) VALUES ('user-github', 'github', 'github@example.com');
      INSERT INTO account (id, userId, accountId, providerId)
      VALUES ('account-github', 'user-github', 'github-id', 'github');
    `)

    const context = await createAuth(authEnv(db)).$context
    await expect(context.internalAdapter.findAccountOwnerByKey({
      issuer: 'local:oauth:github',
      accountId: 'github-id',
    })).rejects.toThrow()
  })

  it('finds an OAuth account by issuer and provider account id', async () => {
    const db = new DatabaseSync(':memory:')
    applyMigrations(db)
    db.exec(`
      INSERT INTO user (id, name, email) VALUES ('user-github', 'github', 'github@example.com');
      INSERT INTO account (id, userId, accountId, providerId, issuer)
      VALUES ('account-github', 'user-github', 'github-id', 'github', 'local:oauth:github');
    `)

    const auth = createAuth(authEnv(db))
    const context = await auth.$context
    const owner = await context.internalAdapter.findAccountOwnerByKey({
      issuer: 'local:oauth:github',
      accountId: 'github-id',
    })

    expect(owner?.kind).toBe('owned')
    if (owner?.kind === 'owned') {
      expect(owner.user.id).toBe('user-github')
      expect(owner.account.providerId).toBe('github')
    }
  })
})
