/**
 * SPIKE (#271). Two things worth asserting: that the migration moves every
 * user-scoped table, and that the ORDER is what protects the data.
 *
 * The second is the point. Every table is ON DELETE CASCADE, so getting this
 * backwards is not a recoverable bug: the rows are gone, not orphaned.
 * The cascade test uses real SQLite semantics via a tiny fake so the
 * assertion is about behavior, not about a mock returning what I told it to.
 */
import { describe, expect, it } from 'vitest'
import { migrateAnonymousData, USER_SCOPED_TABLES } from './anonymous-migration'

/** Minimal D1 stand-in with real cascade behavior for the tables under test. */
function fakeDb() {
  const rows: { table: string; id: string; userId: string }[] = []
  const users = new Set<string>()

  const db = {
    seed(table: string, id: string, userId: string) {
      users.add(userId)
      rows.push({ table, id, userId })
    },
    /** Mirrors ON DELETE CASCADE: dropping a user drops everything keyed to it. */
    deleteUser(userId: string) {
      users.delete(userId)
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].userId === userId) rows.splice(i, 1)
      }
    },
    countFor(userId: string) {
      return rows.filter(r => r.userId === userId).length
    },
    prepare(sql: string) {
      const match = /UPDATE (\w+) SET userId/.exec(sql)
      const table = match ? match[1] : ''
      return {
        bind(toUserId: string, fromUserId: string) {
          return {
            async run() {
              let changes = 0
              for (const row of rows) {
                if (row.table === table && row.userId === fromUserId) {
                  row.userId = toUserId
                  changes++
                }
              }
              return { meta: { changes } }
            },
          }
        },
      }
    },
  }
  return db
}

describe('migrateAnonymousData', () => {
  it('moves rows in every user-scoped table', async () => {
    const db = fakeDb()
    for (const table of USER_SCOPED_TABLES) db.seed(table, `${table}-1`, 'anon')

    const result = await migrateAnonymousData(db as unknown as D1Database, 'anon', 'real')

    expect(result.total).toBe(USER_SCOPED_TABLES.length)
    expect(db.countFor('real')).toBe(USER_SCOPED_TABLES.length)
    expect(db.countFor('anon')).toBe(0)
    for (const table of USER_SCOPED_TABLES) expect(result.moved[table]).toBe(1)
  })

  it('preserves data when the anonymous user is deleted AFTER migrating', async () => {
    const db = fakeDb()
    db.seed('observation', 'o1', 'anon')

    await migrateAnonymousData(db as unknown as D1Database, 'anon', 'real')
    db.deleteUser('anon')

    expect(db.countFor('real')).toBe(1)
  })

  it('shows why the reverse order destroys data (cascade, not orphan)', async () => {
    const db = fakeDb()
    db.seed('observation', 'o1', 'anon')

    // Delete first, migrate second: the cascade already took the row.
    db.deleteUser('anon')
    const result = await migrateAnonymousData(db as unknown as D1Database, 'anon', 'real')

    expect(result.total).toBe(0)
    expect(db.countFor('real')).toBe(0)
  })

  it('is a no-op when the ids match, so a same-id flow cannot corrupt itself', async () => {
    const db = fakeDb()
    db.seed('observation', 'o1', 'same')

    const result = await migrateAnonymousData(db as unknown as D1Database, 'same', 'same')

    expect(result.total).toBe(0)
    expect(db.countFor('same')).toBe(1)
  })
})
