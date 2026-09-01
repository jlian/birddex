import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAccountMergeIntent } from './account-merge-intent'
import {
  accountMergeTablePolicies,
  finalizeAccountMerge,
  finalizeBoundAccountMerges,
  finalizePendingAccountMerge,
} from './account-merge'

function database(through?: string): {
  sqlite: DatabaseSync
  d1: D1Database
  failNextBatchAt: (index: number) => void
  beforeNextBatch: (callback: () => void) => void
} {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON')
  for (const file of readdirSync(path.resolve('migrations')).filter(file => file.endsWith('.sql')).sort()) {
    if (through && file > through) break
    sqlite.exec(readFileSync(path.resolve('migrations', file), 'utf8'))
  }

  function prepared(sql: string) {
    let parameters: SQLInputValue[] = []
    const statement = {
      sql,
      bind(...values: SQLInputValue[]) { parameters = values; return statement },
      async first<T>() { return (sqlite.prepare(sql).get(...parameters) as T | undefined) ?? null },
      async all<T>() {
        return { results: sqlite.prepare(sql).all(...parameters) as T[] }
      },
      run() {
        const result = sqlite.prepare(sql).run(...parameters)
        return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }
      },
    }
    return statement
  }

  let failureIndex: number | null = null
  let beforeBatch: (() => void) | null = null
  const d1 = {
    prepare: prepared,
    async batch(statements: Array<ReturnType<typeof prepared>>) {
      beforeBatch?.()
      beforeBatch = null
      sqlite.exec('BEGIN')
      try {
        const results = statements.map((statement, index) => {
          if (failureIndex === index) throw new Error(`Injected batch failure at ${index}`)
          return statement.run()
        })
        sqlite.exec('COMMIT')
        failureIndex = null
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        failureIndex = null
        throw error
      }
    },
  } as unknown as D1Database
  return {
    sqlite,
    d1,
    failNextBatchAt(index: number) { failureIndex = index },
    beforeNextBatch(callback: () => void) { beforeBatch = callback },
  }
}

function seedUsers(sqlite: DatabaseSync) {
  sqlite.exec(`
    INSERT INTO user (id, name, email, isAnonymous)
    VALUES
      ('source-user', 'quiet-heron', 'temp@example.com', 1),
      ('target-user', 'Target', 'target@example.com', 0);
    INSERT INTO session (id, userId, token, expiresAt)
    VALUES
      ('source-session', 'source-user', 'source-token', datetime('now', '+1 hour')),
      ('target-session', 'target-user', 'target-token', datetime('now', '+1 hour'));
    INSERT INTO account (id, userId, accountId, providerId, issuer)
    VALUES ('target-account', 'target-user', 'github-target', 'github', 'local:oauth:github');
    INSERT INTO passkey (id, name, publicKey, userId, credentialID)
    VALUES ('target-passkey', 'Target passkey', 'public-key', 'target-user', 'credential-id');
  `)
}

function seedDurableData(sqlite: DatabaseSync) {
  sqlite.exec(`
    INSERT INTO outing (id, userId, startTime, endTime, locationName, notes)
    VALUES
      ('source-outing', 'source-user', '2026-05-01T10:00:00Z', '2026-05-01T11:00:00Z', 'Lake', 'source outing'),
      ('target-outing', 'target-user', '2026-05-01T10:00:00Z', '2026-05-01T11:00:00Z', 'Lake', 'target outing');
    INSERT INTO photo (id, outingId, userId, dataUrl, thumbnail, fileHash, fileName)
    VALUES
      ('source-photo', 'source-outing', 'source-user', 'source-data', 'source-thumb', 'same-hash', 'bird.jpg'),
      ('target-photo', 'target-outing', 'target-user', 'target-data', 'target-thumb', 'same-hash', 'bird.jpg');
    INSERT INTO observation (
      id, outingId, userId, speciesName, count, certainty,
      representativePhotoId, aiConfidence, notes, speciesComments, submissionId
    ) VALUES
      ('source-confirmed', 'source-outing', 'source-user', 'American Robin', 1, 'confirmed', 'source-photo', 0.95, 'confirmed note', 'confirmed comment', 'S1'),
      ('source-possible', 'source-outing', 'source-user', 'Blue Jay', 2, 'possible', 'source-photo', 0.65, 'possible note', NULL, NULL),
      ('source-pending', 'source-outing', 'source-user', 'Mallard', 3, 'pending', NULL, 0.50, 'pending note', NULL, NULL),
      ('source-rejected', 'source-outing', 'source-user', 'Crow', 4, 'rejected', NULL, 0.10, 'rejected note', NULL, NULL),
      ('source-exact', 'source-outing', 'source-user', 'Killdeer', 1, 'confirmed', NULL, 0.80, 'same note', NULL, 'S3'),
      ('source-different', 'source-outing', 'source-user', 'Osprey', 1, 'possible', NULL, 0.70, 'source changed', NULL, 'S4'),
      ('target-similar', 'target-outing', 'target-user', 'American Robin', 1, 'confirmed', 'target-photo', 0.95, 'confirmed note', 'confirmed comment', 'S2'),
      ('target-exact', 'target-outing', 'target-user', 'Killdeer', 1, 'confirmed', NULL, 0.80, 'same note', NULL, 'S3'),
      ('target-different', 'target-outing', 'target-user', 'Osprey', 1, 'possible', NULL, 0.70, 'target changed', NULL, 'S4');
    INSERT INTO dex_meta (userId, groupKey, speciesName, addedDate, bestPhotoId, notes)
    VALUES
      ('source-user', 'name:American Robin', 'American Robin', '2025-05-01', 'source-photo', 'source note'),
      ('target-user', 'name:American Robin', 'American Robin', '2026-05-01', 'target-photo', 'target note'),
      ('source-user', 'name:Blue Jay', 'Blue Jay', '2024-04-01', 'source-photo', 'source only');
    INSERT INTO importIdentity (userId, source, sourceKey, rowCount, createdAt)
    VALUES
      ('source-user', 'submission', 'S1', 5, '2025-01-01 00:00:00'),
      ('target-user', 'submission', 'S1', 2, '2026-01-01 00:00:00'),
      ('source-user', 'file', 'source-file', 4, '2025-02-01 00:00:00');
    INSERT INTO ai_daily_usage (userId, endpoint, usageDate, requestCount, createdAt, updatedAt)
    VALUES
      ('source-user', 'identify', '2026-05-01', 3, '2026-05-01 08:00:00', '2026-05-01 09:00:00'),
      ('target-user', 'identify', '2026-05-01', 4, '2026-05-01 07:00:00', '2026-05-01 10:00:00'),
      ('source-user', 'chat', '2026-05-01', 2, '2026-05-01 08:00:00', '2026-05-01 09:00:00');
  `)
}

describe('account merge', () => {
  it('declares a merge policy for every table with a direct user foreign key', () => {
    const { sqlite } = database()
    const tableNames = (sqlite.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).all() as Array<{ name: string }>).map(row => row.name)
    const userOwnedTables = tableNames.filter(table => {
      const foreignKeys = sqlite.prepare(`PRAGMA foreign_key_list('${table}')`).all() as Array<{ table: string }>
      return foreignKeys.some(foreignKey => foreignKey.table === 'user')
    }).sort()

    expect(userOwnedTables).toEqual(Object.keys(accountMergeTablePolicies).sort())
  })

  it('moves full-fidelity data, folds composite state, deletes the source, and retries idempotently', async () => {
    const { sqlite, d1 } = database()
    seedUsers(sqlite)
    seedDurableData(sqlite)
    const token = await createAccountMergeIntent(d1, 'source-session', 'github')

    const result = await finalizeAccountMerge(d1, token, 'target-user')
    expect(result).toEqual({
      status: 'completed',
      sourceUserId: 'source-user',
      targetUserId: 'target-user',
      promoted: false,
      outings: 1,
      observations: 5,
      photos: 1,
    })
    await expect(finalizeAccountMerge(d1, token, 'target-user')).resolves.toEqual(result)

    expect(sqlite.prepare("SELECT count(*) AS count FROM user WHERE id = 'source-user'").get()).toEqual({ count: 0 })
    expect(sqlite.prepare("SELECT count(*) AS count FROM session WHERE userId = 'source-user'").get()).toEqual({ count: 0 })
    expect(sqlite.prepare("SELECT count(*) AS count FROM observation WHERE userId = 'target-user'").get()).toEqual({ count: 8 })
    expect(sqlite.prepare("SELECT count(*) AS count FROM observation WHERE id = 'source-exact'").get()).toEqual({ count: 0 })
    expect(sqlite.prepare("SELECT notes FROM observation WHERE id = 'source-different'").get()).toEqual({ notes: 'source changed' })
    expect(sqlite.prepare("SELECT certainty FROM observation WHERE id LIKE 'source-%' ORDER BY id").all())
      .toEqual([
        { certainty: 'confirmed' },
        { certainty: 'possible' },
        { certainty: 'pending' },
        { certainty: 'possible' },
        { certainty: 'rejected' },
      ])
    expect(sqlite.prepare("SELECT outingId, userId, representativePhotoId, aiConfidence, speciesComments, submissionId FROM observation WHERE id = 'source-confirmed'").get())
      .toEqual({
        outingId: 'source-outing',
        userId: 'target-user',
        representativePhotoId: 'source-photo',
        aiConfidence: 0.95,
        speciesComments: 'confirmed comment',
        submissionId: 'S1',
      })
    expect(sqlite.prepare("SELECT outingId, userId, dataUrl, thumbnail FROM photo WHERE id = 'source-photo'").get())
      .toEqual({ outingId: 'source-outing', userId: 'target-user', dataUrl: 'source-data', thumbnail: 'source-thumb' })
    expect(sqlite.prepare("SELECT addedDate, bestPhotoId, notes FROM dex_meta WHERE userId = 'target-user' AND speciesName = 'American Robin'").get())
      .toEqual({ addedDate: '2025-05-01', bestPhotoId: 'target-photo', notes: 'target note\n\nsource note' })
    expect(sqlite.prepare("SELECT rowCount, createdAt FROM importIdentity WHERE userId = 'target-user' AND source = 'submission' AND sourceKey = 'S1'").get())
      .toEqual({ rowCount: 5, createdAt: '2025-01-01 00:00:00' })
    expect(sqlite.prepare("SELECT requestCount, createdAt, updatedAt FROM ai_daily_usage WHERE userId = 'target-user' AND endpoint = 'identify'").get())
      .toEqual({ requestCount: 7, createdAt: '2026-05-01 07:00:00', updatedAt: '2026-05-01 10:00:00' })
    expect(sqlite.prepare("SELECT status, sourceUserId, targetUserId FROM account_merge_intent").get())
      .toEqual({ status: 'completed', sourceUserId: 'source-user', targetUserId: 'target-user' })
    expect(sqlite.prepare("SELECT count(*) AS count FROM account WHERE userId = 'target-user'").get()).toEqual({ count: 1 })
    expect(sqlite.prepare("SELECT count(*) AS count FROM passkey WHERE userId = 'target-user'").get()).toEqual({ count: 1 })
  })

  it('deduplicates renamed labels with the same submission and exact taxon code', async () => {
    const { sqlite, d1 } = database()
    seedUsers(sqlite)
    seedDurableData(sqlite)
    sqlite.exec(`
      INSERT INTO observation (
        id, outingId, userId, speciesName, speciesCode, taxonCode, count, certainty,
        representativePhotoId, aiConfidence, notes, speciesComments, submissionId
      ) VALUES
        ('source-renamed', 'source-outing', 'source-user', 'Old Kiwi Label', 'sobkiw1', 'sobkiw2', 1, 'confirmed', NULL, NULL, '', NULL, 'S5'),
        ('target-renamed', 'target-outing', 'target-user', 'Southern Brown Kiwi (South I.)', 'sobkiw1', 'sobkiw2', 1, 'confirmed', NULL, NULL, '', NULL, 'S5');
    `)
    const token = await createAccountMergeIntent(d1, 'source-session', 'github')

    const result = await finalizeAccountMerge(d1, token, 'target-user')

    expect(result.observations).toBe(5)
    expect(sqlite.prepare("SELECT count(*) AS count FROM observation WHERE id = 'source-renamed'").get())
      .toEqual({ count: 0 })
    expect(sqlite.prepare("SELECT count(*) AS count FROM observation WHERE id = 'target-renamed'").get())
      .toEqual({ count: 1 })
  })

  it('keeps matching labels with different exact taxon codes distinct', async () => {
    const { sqlite, d1 } = database()
    seedUsers(sqlite)
    seedDurableData(sqlite)
    sqlite.exec(`
      INSERT INTO observation (
        id, outingId, userId, speciesName, speciesCode, taxonCode, count, certainty,
        representativePhotoId, aiConfidence, notes, speciesComments, submissionId
      ) VALUES
        ('source-issf', 'source-outing', 'source-user', 'Southern Brown Kiwi', 'sobkiw1', 'sobkiw2', 1, 'confirmed', NULL, NULL, '', NULL, 'S6'),
        ('target-issf', 'target-outing', 'target-user', 'Southern Brown Kiwi', 'sobkiw1', 'sobkiw3', 1, 'confirmed', NULL, NULL, '', NULL, 'S6');
    `)
    const token = await createAccountMergeIntent(d1, 'source-session', 'github')

    const result = await finalizeAccountMerge(d1, token, 'target-user')

    expect(result.observations).toBe(6)
    expect(sqlite.prepare("SELECT userId FROM observation WHERE id = 'source-issf'").get())
      .toEqual({ userId: 'target-user' })
    expect(sqlite.prepare("SELECT count(*) AS count FROM observation WHERE submissionId = 'S6'").get())
      .toEqual({ count: 2 })
  })

  it('uses normalized-name fallback when one duplicate row is uncoded', async () => {
    const { sqlite, d1 } = database()
    seedUsers(sqlite)
    seedDurableData(sqlite)
    sqlite.exec(`
      INSERT INTO observation (
        id, outingId, userId, speciesName, speciesCode, taxonCode, count, certainty,
        representativePhotoId, aiConfidence, notes, speciesComments, submissionId
      ) VALUES
        ('source-legacy', 'source-outing', 'source-user', ' northern cardinal ', NULL, NULL, 1, 'confirmed', NULL, NULL, '', NULL, 'S7'),
        ('target-coded', 'target-outing', 'target-user', 'Northern Cardinal', 'norcar', 'norcar', 1, 'confirmed', NULL, NULL, '', NULL, 'S7');
    `)
    const token = await createAccountMergeIntent(d1, 'source-session', 'github')

    const result = await finalizeAccountMerge(d1, token, 'target-user')

    expect(result.observations).toBe(5)
    expect(sqlite.prepare("SELECT count(*) AS count FROM observation WHERE id = 'source-legacy'").get())
      .toEqual({ count: 0 })
  })

  it('finalizes safely against the pre-groupKey schema during rollout', async () => {
    const { sqlite, d1 } = database('0014_species_code.sql')
    seedUsers(sqlite)
    sqlite.exec(`
      INSERT INTO dex_meta (userId, speciesName, addedDate, notes)
      VALUES
        ('source-user', 'American Robin', '2025-01-01', 'source note'),
        ('target-user', 'American Robin', '2026-01-01', 'target note');
    `)
    const token = await createAccountMergeIntent(d1, 'source-session', 'github')

    await expect(finalizeAccountMerge(d1, token, 'target-user')).resolves.toMatchObject({
      status: 'completed',
      sourceUserId: 'source-user',
      targetUserId: 'target-user',
    })
    expect(sqlite.prepare("SELECT addedDate, notes FROM dex_meta WHERE userId = 'target-user'").get())
      .toEqual({ addedDate: '2025-01-01', notes: 'target note\n\nsource note' })
  })

  it('promotes source equal to target without deleting data or the user', async () => {
    const { sqlite, d1 } = database()
    sqlite.exec(`
      INSERT INTO user (id, name, email, isAnonymous)
      VALUES ('source-user', 'quiet-heron', 'temp@example.com', 1);
      INSERT INTO session (id, userId, token, expiresAt)
      VALUES ('source-session', 'source-user', 'source-token', datetime('now', '+1 hour'));
    `)
    const token = await createAccountMergeIntent(d1, 'source-session', 'passkey')

    const result = await finalizeAccountMerge(d1, token, 'source-user')

    expect(result.promoted).toBe(true)
    expect(sqlite.prepare("SELECT isAnonymous FROM user WHERE id = 'source-user'").get()).toEqual({ isAnonymous: 0 })
    expect(sqlite.prepare("SELECT count(*) AS count FROM session WHERE id = 'source-session'").get()).toEqual({ count: 1 })
    await expect(finalizeAccountMerge(d1, token, 'source-user')).resolves.toEqual(result)
  })

  it('fails closed when an anonymous source unexpectedly owns credentials', async () => {
    const { sqlite, d1 } = database()
    seedUsers(sqlite)
    sqlite.exec(`
      INSERT INTO account (id, userId, accountId, providerId, issuer)
      VALUES ('source-account', 'source-user', 'source-provider-id', 'google', 'https://accounts.google.com');
    `)
    const token = await createAccountMergeIntent(d1, 'source-session', 'google')

    await expect(finalizeAccountMerge(d1, token, 'target-user'))
      .rejects.toThrow('unexpectedly owns credentials')
    expect(sqlite.prepare("SELECT isAnonymous FROM user WHERE id = 'source-user'").get()).toEqual({ isAnonymous: 1 })
  })

  it('binds the first authenticated target even when a later transfer fails', async () => {
    const { sqlite, d1, failNextBatchAt } = database()
    seedUsers(sqlite)
    sqlite.exec(`
      INSERT INTO user (id, name, email, isAnonymous)
      VALUES ('other-target', 'Other', 'other@example.com', 0);
    `)
    const token = await createAccountMergeIntent(d1, 'source-session', 'github')
    failNextBatchAt(1)

    await expect(finalizeAccountMerge(d1, token, 'target-user')).rejects.toThrow('Injected batch failure')
    expect(sqlite.prepare("SELECT status, targetUserId FROM account_merge_intent").get())
      .toEqual({ status: 'pending', targetUserId: 'target-user' })
    await expect(finalizeAccountMerge(d1, token, 'other-target'))
      .rejects.toThrow('already bound to another target')
  })

  it('retries a target-bound intent after the ceremony window expires', async () => {
    const { sqlite, d1, failNextBatchAt } = database()
    seedUsers(sqlite)
    seedDurableData(sqlite)
    const token = await createAccountMergeIntent(d1, 'source-session', 'github')
    failNextBatchAt(3)
    await expect(finalizeAccountMerge(d1, token, 'target-user')).rejects.toThrow('Injected batch failure')
    sqlite.exec("UPDATE account_merge_intent SET expiresAt = datetime('now', '-1 minute')")

    await expect(finalizeAccountMerge(d1, token, 'target-user'))
      .resolves.toMatchObject({ status: 'completed', targetUserId: 'target-user' })
  })

  it('discovers a target-bound retry without its client token', async () => {
    const { sqlite, d1, failNextBatchAt } = database()
    seedUsers(sqlite)
    seedDurableData(sqlite)
    const token = await createAccountMergeIntent(d1, 'source-session', 'github')
    failNextBatchAt(3)
    await expect(finalizeAccountMerge(d1, token, 'target-user')).rejects.toThrow()

    await expect(finalizeBoundAccountMerges(d1, 'target-user'))
      .resolves.toEqual([expect.objectContaining({
        status: 'completed',
        sourceUserId: 'source-user',
        targetUserId: 'target-user',
      })])
  })

  it('lets only the authenticated callback bind after the ceremony window expires', async () => {
    const { sqlite, d1 } = database()
    seedUsers(sqlite)
    seedDurableData(sqlite)
    const token = await createAccountMergeIntent(d1, 'source-session', 'github')
    sqlite.exec("UPDATE account_merge_intent SET expiresAt = datetime('now', '-1 minute')")

    await expect(finalizeAccountMerge(d1, token, 'target-user'))
      .rejects.toThrow('target could not be claimed')
    await expect(finalizePendingAccountMerge(
      d1,
      'source-user',
      'source-session',
      'google',
      'target-user',
    )).resolves.toBeNull()
    await expect(finalizePendingAccountMerge(
      d1,
      'source-user',
      'source-session',
      'github',
      'target-user',
    )).resolves.toMatchObject({ status: 'completed', targetUserId: 'target-user' })
  })

  it('allows an expired same-user passkey promotion to record completion', async () => {
    const { sqlite, d1 } = database()
    sqlite.exec(`
      INSERT INTO user (id, name, email, isAnonymous)
      VALUES ('source-user', 'quiet-heron', 'temp@example.com', 1);
      INSERT INTO session (id, userId, token, expiresAt)
      VALUES ('source-session', 'source-user', 'source-token', datetime('now', '+1 hour'));
    `)
    const token = await createAccountMergeIntent(d1, 'source-session', 'passkey')
    sqlite.exec(`
      UPDATE user SET isAnonymous = 0 WHERE id = 'source-user';
      UPDATE account_merge_intent SET expiresAt = datetime('now', '-1 minute');
    `)

    await expect(finalizeAccountMerge(d1, token, 'source-user'))
      .resolves.toMatchObject({ status: 'completed', promoted: true })
  })

  it('rolls back when credentials appear after preflight but before transfer', async () => {
    const { sqlite, d1, beforeNextBatch } = database()
    seedUsers(sqlite)
    seedDurableData(sqlite)
    const token = await createAccountMergeIntent(d1, 'source-session', 'github')
    beforeNextBatch(() => {
      sqlite.exec(`
        INSERT INTO account (id, userId, accountId, providerId, issuer)
        VALUES ('racing-account', 'source-user', 'racing-id', 'google', 'https://accounts.google.com');
      `)
    })

    await expect(finalizeAccountMerge(d1, token, 'target-user')).rejects.toThrow()
    expect(sqlite.prepare("SELECT count(*) AS count FROM user WHERE id = 'source-user'").get()).toEqual({ count: 1 })
    expect(sqlite.prepare("SELECT count(*) AS count FROM observation WHERE userId = 'source-user'").get()).toEqual({ count: 6 })
    expect(sqlite.prepare("SELECT status FROM account_merge_intent").get()).toEqual({ status: 'pending' })
  })

  it('rolls back when source deletion is silently ignored', async () => {
    const { sqlite, d1 } = database()
    seedUsers(sqlite)
    seedDurableData(sqlite)
    const token = await createAccountMergeIntent(d1, 'source-session', 'github')
    sqlite.exec(`
      CREATE TRIGGER ignore_source_delete
      BEFORE DELETE ON user
      WHEN OLD.id = 'source-user'
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `)

    await expect(finalizeAccountMerge(d1, token, 'target-user')).rejects.toThrow()
    expect(sqlite.prepare("SELECT count(*) AS count FROM user WHERE id = 'source-user'").get()).toEqual({ count: 1 })
    expect(sqlite.prepare("SELECT count(*) AS count FROM observation WHERE userId = 'source-user'").get()).toEqual({ count: 6 })
    expect(sqlite.prepare("SELECT count(*) AS count FROM observation WHERE userId = 'target-user'").get()).toEqual({ count: 3 })
    expect(sqlite.prepare("SELECT status, targetUserId FROM account_merge_intent").get())
      .toEqual({ status: 'pending', targetUserId: 'target-user' })
  })

  it('rolls back every prior statement when a transfer statement fails', async () => {
    const { sqlite, d1, failNextBatchAt } = database()
    seedUsers(sqlite)
    seedDurableData(sqlite)
    const token = await createAccountMergeIntent(d1, 'source-session', 'github')
    failNextBatchAt(9)

    await expect(finalizeAccountMerge(d1, token, 'target-user')).rejects.toThrow('Injected batch failure')

    expect(sqlite.prepare("SELECT status, targetUserId FROM account_merge_intent").get())
      .toEqual({ status: 'pending', targetUserId: 'target-user' })
    expect(sqlite.prepare("SELECT count(*) AS count FROM user WHERE id = 'source-user'").get()).toEqual({ count: 1 })
    expect(sqlite.prepare("SELECT count(*) AS count FROM observation WHERE userId = 'source-user'").get()).toEqual({ count: 6 })
    expect(sqlite.prepare("SELECT count(*) AS count FROM observation WHERE userId = 'target-user'").get()).toEqual({ count: 3 })
  })
})