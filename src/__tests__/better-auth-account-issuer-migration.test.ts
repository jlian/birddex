import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const migrationsDirectory = path.resolve('migrations')

function applyMigrations(db: DatabaseSync, through: string) {
  const files = readdirSync(migrationsDirectory)
    .filter(file => file.endsWith('.sql') && file <= through)
    .sort()
  for (const file of files) {
    db.exec(readFileSync(path.join(migrationsDirectory, file), 'utf8'))
  }
}

function legacyDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  applyMigrations(db, '0009_import_identity.sql')
  return db
}

describe('Better Auth 1.7 account issuer migration', () => {
  it('backfills configured providers and supports issuer-scoped ownership lookup', () => {
    const db = legacyDatabase()

    const insertUser = db.prepare(
      'INSERT INTO user (id, name, email) VALUES (?, ?, ?)',
    )
    const insertAccount = db.prepare(
      'INSERT INTO account (id, userId, accountId, providerId) VALUES (?, ?, ?, ?)',
    )
    for (const [provider, accountId] of [
      ['apple', 'apple-subject'],
      ['github', 'github-id'],
      ['google', 'google-subject'],
    ] as const) {
      const userId = `user-${provider}`
      insertUser.run(userId, provider, `${provider}@example.com`)
      insertAccount.run(`account-${provider}`, userId, accountId, provider)
    }
    db.prepare(`
      INSERT INTO apple_native_revocation_credential
        (authAccountId, accessToken, refreshToken)
      VALUES (?, ?, ?)
    `).run('account-apple', 'apple-access', 'apple-refresh')

    db.exec(readFileSync(path.join(migrationsDirectory, '0010_better_auth_account_issuer.sql'), 'utf8'))

    const ownershipLookup = db.prepare(
      `SELECT userId FROM account WHERE issuer = ? AND accountId = ?`,
    )
    expect(ownershipLookup.get('https://appleid.apple.com', 'apple-subject')).toEqual({ userId: 'user-apple' })
    expect(ownershipLookup.get('local:oauth:github', 'github-id')).toEqual({ userId: 'user-github' })
    expect(ownershipLookup.get('https://accounts.google.com', 'google-subject')).toEqual({ userId: 'user-google' })

    const columns = db.prepare('PRAGMA table_info(account)').all() as Array<{ name: string; notnull: number }>
    expect(columns.find(column => column.name === 'issuer')).toMatchObject({ notnull: 1 })
    expect(db.prepare(`
      SELECT authAccountId, accessToken, refreshToken
      FROM apple_native_revocation_credential
    `).get()).toEqual({
      authAccountId: 'account-apple',
      accessToken: 'apple-access',
      refreshToken: 'apple-refresh',
    })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])

    const insertMigratedAccount = db.prepare(
      'INSERT INTO account (id, userId, accountId, providerId, issuer) VALUES (?, ?, ?, ?, ?)',
    )
    expect(() => {
      insertMigratedAccount.run(
        'duplicate',
        'user-github',
        'github-id',
        'github-alias',
        'local:oauth:github',
      )
    }).toThrow()
  })

  it('fails closed when a legacy account has an unreviewed provider', () => {
    const db = legacyDatabase()
    db.exec(`
      INSERT INTO user (id, name, email) VALUES ('user-custom', 'custom', 'custom@example.com');
      INSERT INTO account (id, userId, accountId, providerId)
      VALUES ('account-custom', 'user-custom', 'subject', 'custom-provider');
    `)

    expect(() => {
      db.exec(readFileSync(path.join(migrationsDirectory, '0010_better_auth_account_issuer.sql'), 'utf8'))
    }).toThrow()
    expect(db.prepare('SELECT providerId FROM account').get()).toEqual({ providerId: 'custom-provider' })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM pragma_table_info('account') WHERE name = 'issuer'`).get()).toEqual({ count: 0 })
  })

  it('detects issuer collisions before dropping the legacy account table', () => {
    const db = legacyDatabase()
    db.exec(`
      INSERT INTO user (id, name, email) VALUES
        ('user-a', 'a', 'a@example.com'),
        ('user-b', 'b', 'b@example.com');
      INSERT INTO account (id, userId, accountId, providerId) VALUES
        ('account-a', 'user-a', 'same-subject', 'github'),
        ('account-b', 'user-b', 'same-subject', 'github');
    `)

    expect(() => {
      db.exec(readFileSync(path.join(migrationsDirectory, '0010_better_auth_account_issuer.sql'), 'utf8'))
    }).toThrow()
    expect(db.prepare('SELECT COUNT(*) AS count FROM account').get()).toEqual({ count: 2 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM pragma_table_info('account') WHERE name = 'issuer'`).get()).toEqual({ count: 0 })
  })
})
