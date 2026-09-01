import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/dex-query', () => ({
  computeDex: vi.fn(async () => []),
  enrichDexEntries: vi.fn((rows: unknown[]) => rows),
}))

import { onRequestPatch, onRequestPost } from './observations'

type BoundStatement = D1PreparedStatement & { run(): Promise<D1Result> }

function createDatabase(): { sqlite: DatabaseSync; d1: D1Database } {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE outing (id TEXT PRIMARY KEY, userId TEXT NOT NULL);
    CREATE TABLE observation (
      id TEXT PRIMARY KEY,
      outingId TEXT NOT NULL,
      userId TEXT NOT NULL,
      speciesName TEXT NOT NULL,
      speciesCode TEXT,
      taxonCode TEXT,
      count INTEGER NOT NULL,
      certainty TEXT NOT NULL,
      representativePhotoId TEXT,
      aiConfidence REAL,
      speciesComments TEXT,
      notes TEXT NOT NULL
    );
    INSERT INTO outing (id, userId) VALUES ('outing-1', 'user-1');
  `)

  const d1 = {
    prepare(sql: string) {
      const statement = {
        bind(...parameters: unknown[]) {
          return {
            ...statement,
            async all<T>() {
              return { results: sqlite.prepare(sql).all(...parameters) as T[] }
            },
            async run() {
              const result = sqlite.prepare(sql).run(...parameters)
              return { meta: { changes: Number(result.changes) } }
            },
          }
        },
        async all<T>() {
          return { results: sqlite.prepare(sql).all() as T[] }
        },
      }
      return statement
    },
    async batch(statements: BoundStatement[]) {
      return Promise.all(statements.map(statement => statement.run()))
    },
  } as unknown as D1Database

  return { sqlite, d1 }
}

function context(db: D1Database, method: 'POST' | 'PATCH', body: unknown) {
  return {
    request: new Request('https://wingdex.test/api/data/observations', {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env: { DB: db },
    data: { user: { id: 'user-1' } },
  } as never
}

describe('observation taxon identity persistence', () => {
  let sqlite: DatabaseSync
  let d1: D1Database

  beforeEach(() => {
    ({ sqlite, d1 } = createDatabase())
  })

  afterEach(() => {
    sqlite.close()
  })

  it('stores the exact ISSF code alongside its REPORT_AS grouping code', async () => {
    const response = await onRequestPost(context(d1, 'POST', [{
      id: 'observation-1',
      outingId: 'outing-1',
      speciesName: 'Southern Brown Kiwi (South I.)',
      count: 1,
      certainty: 'confirmed',
    }])) as Response

    expect(response.status).toBe(200)
    expect(sqlite.prepare('SELECT taxonCode, speciesCode FROM observation').get()).toEqual({
      taxonCode: 'sobkiw2',
      speciesCode: 'sobkiw1',
    })
    await expect(response.json()).resolves.toMatchObject({
      observations: [{ taxonCode: 'sobkiw2', speciesCode: 'sobkiw1' }],
    })
  })

  it('recomputes both codes when PATCH changes speciesName', async () => {
    sqlite.prepare(`
      INSERT INTO observation
        (id, outingId, userId, speciesName, speciesCode, taxonCode, count, certainty, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('observation-1', 'outing-1', 'user-1', 'Mallard', 'mallar3', 'mallar3', 1, 'confirmed', '')

    const response = await onRequestPatch(context(d1, 'PATCH', {
      id: 'observation-1',
      speciesName: 'Southern Brown Kiwi (South I.)',
    })) as Response

    expect(response.status).toBe(200)
    expect(sqlite.prepare('SELECT speciesName, taxonCode, speciesCode FROM observation').get()).toEqual({
      speciesName: 'Southern Brown Kiwi (South I.)',
      taxonCode: 'sobkiw2',
      speciesCode: 'sobkiw1',
    })
    await expect(response.json()).resolves.toMatchObject({
      observation: { taxonCode: 'sobkiw2', speciesCode: 'sobkiw1' },
    })
  })

  it('recomputes both codes for every observation in a bulk PATCH', async () => {
    const insert = sqlite.prepare(`
      INSERT INTO observation
        (id, outingId, userId, speciesName, speciesCode, taxonCode, count, certainty, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const id of ['observation-1', 'observation-2']) {
      insert.run(id, 'outing-1', 'user-1', 'Mallard', 'mallar3', 'mallar3', 1, 'confirmed', '')
    }

    const response = await onRequestPatch(context(d1, 'PATCH', {
      ids: ['observation-1', 'observation-2'],
      patch: { speciesName: 'Southern Brown Kiwi (South I.)' },
    })) as Response

    expect(response.status).toBe(200)
    expect(sqlite.prepare('SELECT taxonCode, speciesCode FROM observation ORDER BY id').all()).toEqual([
      { taxonCode: 'sobkiw2', speciesCode: 'sobkiw1' },
      { taxonCode: 'sobkiw2', speciesCode: 'sobkiw1' },
    ])
    await expect(response.json()).resolves.toMatchObject({
      observations: [
        { taxonCode: 'sobkiw2', speciesCode: 'sobkiw1' },
        { taxonCode: 'sobkiw2', speciesCode: 'sobkiw1' },
      ],
    })
  })
})