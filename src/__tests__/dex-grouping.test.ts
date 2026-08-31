/**
 * The dex grouping key moved from speciesName to speciesCode (#306), with a
 * fallback to the name when the code is null.
 *
 * These run the REAL DEX_QUERY against in-memory SQLite rather than a mock,
 * because the thing worth testing is the SQL itself: a mock that returns
 * whatever rows it was handed cannot tell you whether the GROUP BY merged two
 * spellings or collapsed every unresolvable taxon into one entry.
 */
import Database from 'better-sqlite3'
import { describe, it, expect, beforeEach } from 'vitest'

import { DEX_QUERY } from '../../functions/lib/dex-query'

let db: Database.Database

function seed(rows: Array<{
  name: string
  code: string | null
  outing: string
  count?: number
  certainty?: string
}>) {
  const outings = new Set(rows.map(r => r.outing))
  for (const o of outings) {
    db.prepare(`INSERT INTO outing (id, userId, startTime) VALUES (?, 'u1', ?)`)
      .run(o, `2026-01-0${o.slice(-1)}T08:00:00Z`)
  }
  let i = 0
  for (const r of rows) {
    db.prepare(
      `INSERT INTO observation (id, outingId, userId, speciesName, speciesCode, count, certainty)
       VALUES (?, ?, 'u1', ?, ?, ?, ?)`)
      .run(`obs${i++}`, r.outing, r.name, r.code, r.count ?? 1,
           r.certainty ?? 'confirmed')
  }
}

function run(): Array<Record<string, unknown>> {
  return db.prepare(DEX_QUERY.replace('?1', "'u1'")).all() as Array<Record<string, unknown>>
}

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE outing (id TEXT PRIMARY KEY, userId TEXT, startTime TEXT);
    CREATE TABLE observation (
      id TEXT PRIMARY KEY, outingId TEXT, userId TEXT,
      speciesName TEXT NOT NULL, speciesCode TEXT,
      count INTEGER DEFAULT 1, certainty TEXT DEFAULT 'confirmed');
    CREATE TABLE dex_meta (
      userId TEXT, speciesName TEXT, speciesCode TEXT,
      addedDate TEXT, bestPhotoId TEXT, notes TEXT);
  `)
})

describe('dex grouping by species code', () => {
  it('merges two spellings of the same bird into one entry', () => {
    // This is the bug the change exists to fix: iOS writing a bare common name
    // while import writes the canonical form would previously split the dex.
    seed([
      { name: 'Northern Cardinal', code: 'norcar', outing: 'o1' },
      { name: 'Northern Cardinal (Cardinalis cardinalis)', code: 'norcar', outing: 'o2' },
    ])
    const rows = run()
    expect(rows).toHaveLength(1)
    expect(rows[0].speciesCode).toBe('norcar')
    expect(rows[0].totalOutings).toBe(2)
    expect(rows[0].totalCount).toBe(2)
  })

  it('keeps genuinely different species apart', () => {
    seed([
      { name: 'Northern Cardinal', code: 'norcar', outing: 'o1' },
      { name: 'Black Vulture', code: 'blkvul', outing: 'o1' },
    ])
    expect(run()).toHaveLength(2)
  })

  it('does NOT collapse unresolvable taxa into a single null-code entry', () => {
    // The failure mode a plain GROUP BY speciesCode would produce: every taxon
    // the resolver could not place sharing one dex row. Far worse than a split.
    seed([
      { name: 'Gull sp.', code: null, outing: 'o1' },
      { name: 'Pidgey (Pokémon)', code: null, outing: 'o1' },
      { name: 'Northern Cardinal', code: 'norcar', outing: 'o1' },
    ])
    const rows = run()
    expect(rows).toHaveLength(3)
    const names = rows.map(r => r.speciesName).sort()
    expect(names).toEqual(['Gull sp.', 'Northern Cardinal', 'Pidgey (Pokémon)'])
  })

  it('keeps a coded and an uncoded row apart even if the name matches a code', () => {
    // The namespace prefix exists for this: without it a display name equal to
    // another species' code would merge two unrelated birds.
    seed([
      { name: 'norcar', code: null, outing: 'o1' },
      { name: 'Northern Cardinal', code: 'norcar', outing: 'o1' },
    ])
    expect(run()).toHaveLength(2)
  })

  it('still excludes pending and rejected observations', () => {
    seed([
      { name: 'Northern Cardinal', code: 'norcar', outing: 'o1' },
      { name: 'Black Vulture', code: 'blkvul', outing: 'o1', certainty: 'pending' },
      { name: 'Rock Pigeon', code: 'rocpig', outing: 'o1', certainty: 'rejected' },
    ])
    const rows = run()
    expect(rows).toHaveLength(1)
    expect(rows[0].speciesCode).toBe('norcar')
  })

  it('joins dex_meta by code when the observation has one', () => {
    seed([{ name: 'Northern Cardinal', code: 'norcar', outing: 'o1' }])
    db.prepare(
      `INSERT INTO dex_meta (userId, speciesName, speciesCode, notes)
       VALUES ('u1', 'Northern Cardinal', 'norcar', 'seen at the feeder')`).run()
    const rows = run()
    expect(rows[0].notes).toBe('seen at the feeder')
  })

  it('falls back to joining dex_meta by name when the code is null', () => {
    seed([{ name: 'Gull sp.', code: null, outing: 'o1' }])
    db.prepare(
      `INSERT INTO dex_meta (userId, speciesName, speciesCode, notes)
       VALUES ('u1', 'Gull sp.', NULL, 'could not tell which')`).run()
    const rows = run()
    expect(rows[0].notes).toBe('could not tell which')
  })
})
