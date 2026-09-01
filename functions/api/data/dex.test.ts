import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { computeDex } = vi.hoisted(() => ({
  computeDex: vi.fn(async () => [{
    id: 'code:norcar',
    speciesName: 'Northern Cardinal',
    speciesCode: 'norcar',
    firstSeenDate: '2026-01-01',
    lastSeenDate: '2026-01-01',
    totalOutings: 1,
    totalCount: 1,
    notes: '',
  }]),
}))

vi.mock('../../lib/dex-query', () => ({
  computeDex,
  enrichDexEntries: vi.fn((rows: unknown[]) => rows),
}))

import { onRequestPatch } from './dex'

function d1(sqlite: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      const statement = {
        bind(...parameters: unknown[]) {
          return {
            ...statement,
            async all<T>() { return { results: sqlite.prepare(sql).all(...parameters) as T[] } },
            async run() {
              const result = sqlite.prepare(sql).run(...parameters)
              return { meta: { changes: Number(result.changes) } }
            },
          }
        },
        async all<T>() { return { results: sqlite.prepare(sql).all() as T[] } },
      }
      return statement
    },
  } as unknown as D1Database
}

function context(db: D1Database, body: unknown) {
  return {
    request: new Request('https://wingdex.test/api/data/dex', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env: { DB: db },
    data: { user: { id: 'u1' } },
  } as never
}

describe('dex metadata grouping identity', () => {
  beforeEach(() => computeDex.mockClear())

  it('rejects a client key that does not identify a current dex entry', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(`CREATE TABLE dex_meta (
      userId TEXT, groupKey TEXT, speciesName TEXT, speciesCode TEXT,
      addedDate TEXT, bestPhotoId TEXT, notes TEXT,
      PRIMARY KEY (userId, groupKey));`)

    const response = await onRequestPatch(context(d1(sqlite), {
      groupKey: 'code:blujay', speciesName: 'Blue Jay', notes: 'wrong group',
    }))

    expect(response.status).toBe(400)
    expect(sqlite.prepare('SELECT count(*) AS count FROM dex_meta').get()).toEqual({ count: 0 })
  })

  it('accepts a current group key when the client display label is stale', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(`CREATE TABLE dex_meta (
      userId TEXT, groupKey TEXT, speciesName TEXT, speciesCode TEXT,
      addedDate TEXT, bestPhotoId TEXT, notes TEXT,
      PRIMARY KEY (userId, groupKey));`)

    const response = await onRequestPatch(context(d1(sqlite), {
      groupKey: 'code:norcar', speciesName: 'Old Cardinal Label', notes: 'feeder',
    }))

    expect(response.status).toBe(200)
    expect(sqlite.prepare('SELECT groupKey, speciesName, notes FROM dex_meta').get()).toEqual({
      groupKey: 'code:norcar', speciesName: 'Northern Cardinal', notes: 'feeder',
    })
  })

  it('writes metadata for an authenticated computed group', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(`CREATE TABLE dex_meta (
      userId TEXT, groupKey TEXT, speciesName TEXT, speciesCode TEXT,
      addedDate TEXT, bestPhotoId TEXT, notes TEXT,
      PRIMARY KEY (userId, groupKey));`)

    const response = await onRequestPatch(context(d1(sqlite), {
      groupKey: 'code:norcar', speciesName: 'Northern Cardinal', notes: 'feeder',
    }))

    expect(response.status).toBe(200)
    expect(sqlite.prepare('SELECT groupKey, speciesName, notes FROM dex_meta').get()).toEqual({
      groupKey: 'code:norcar', speciesName: 'Northern Cardinal', notes: 'feeder',
    })
  })

  it('resolves an omitted key from the current migrated dex group', async () => {
    computeDex.mockResolvedValueOnce([{
      id: 'name:Northern Cardinal',
      speciesName: 'Northern Cardinal',
      firstSeenDate: '2026-01-01',
      lastSeenDate: '2026-01-01',
      totalOutings: 1,
      totalCount: 1,
      notes: '',
    }])
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(`CREATE TABLE dex_meta (
      userId TEXT, groupKey TEXT, speciesName TEXT, speciesCode TEXT,
      addedDate TEXT, bestPhotoId TEXT, notes TEXT,
      PRIMARY KEY (userId, groupKey));`)

    const response = await onRequestPatch(context(d1(sqlite), {
      speciesName: 'Northern Cardinal', notes: 'legacy client',
    }))

    expect(response.status).toBe(200)
    expect(sqlite.prepare('SELECT groupKey, speciesCode, notes FROM dex_meta').get()).toEqual({
      groupKey: 'name:Northern Cardinal', speciesCode: null, notes: 'legacy client',
    })
  })

  it('falls back to the legacy name-keyed schema before migration 0016', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(`CREATE TABLE dex_meta (
      userId TEXT, speciesName TEXT, addedDate TEXT, bestPhotoId TEXT, notes TEXT,
      PRIMARY KEY (userId, speciesName));`)

    const response = await onRequestPatch(context(d1(sqlite), {
      speciesName: 'Northern Cardinal', notes: 'legacy',
    }))

    expect(response.status).toBe(200)
    expect(sqlite.prepare('SELECT speciesName, notes FROM dex_meta').get()).toEqual({
      speciesName: 'Northern Cardinal', notes: 'legacy',
    })
  })
})
