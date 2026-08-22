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


describe('Better Auth 1.7 account issuer migration', () => {
  it('backfills configured providers and supports issuer-scoped ownership lookup', () => {
    const db = new DatabaseSync(':memory:')
    applyMigrations(db, '0009_import_identity.sql')

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

    db.exec(readFileSync(path.join(migrationsDirectory, '0010_better_auth_account_issuer.sql'), 'utf8'))

    const ownershipLookup = db.prepare(
      `SELECT userId FROM account WHERE issuer = ? AND accountId = ?`,
    )
    expect(ownershipLookup.get('https://appleid.apple.com', 'apple-subject')).toEqual({ userId: 'user-apple' })
    expect(ownershipLookup.get('local:oauth:github', 'github-id')).toEqual({ userId: 'user-github' })
    expect(ownershipLookup.get('https://accounts.google.com', 'google-subject')).toEqual({ userId: 'user-google' })

    const columns = db.prepare('PRAGMA table_info(account)').all() as Array<{ name: string; notnull: number }>
    expect(columns.find(column => column.name === 'issuer')).toMatchObject({ notnull: 1 })

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
    const db = new DatabaseSync(':memory:')
    applyMigrations(db, '0009_import_identity.sql')
    db.exec(`
      INSERT INTO user (id, name, email) VALUES ('user-custom', 'custom', 'custom@example.com');
      INSERT INTO account (id, userId, accountId, providerId)
      VALUES ('account-custom', 'user-custom', 'subject', 'custom-provider');
    `)

    expect(() => {
      db.exec(readFileSync(path.join(migrationsDirectory, '0010_better_auth_account_issuer.sql'), 'utf8'))
    }).toThrow()
  })
})
