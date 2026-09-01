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
  taxonCode?: string | null
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
      `INSERT INTO observation (id, outingId, userId, speciesName, speciesCode, taxonCode, count, certainty)
       VALUES (?, ?, 'u1', ?, ?, ?, ?, ?)`)
      .run(`obs${i++}`, r.outing, r.name, r.code, r.taxonCode === undefined ? r.code : r.taxonCode, r.count ?? 1,
           r.certainty ?? 'confirmed')
  }
}

function run(): Array<Record<string, unknown>> {
  // The query binds ?1 in several CTEs, and better-sqlite3 does not accept a
  // numbered placeholder reused this way from .all('u1'), so substitute every
  // occurrence rather than only the first.
  return db.prepare(DEX_QUERY.split('?1').join("'u1'")).all() as Array<Record<string, unknown>>
}

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE outing (id TEXT PRIMARY KEY, userId TEXT, startTime TEXT);
    CREATE TABLE observation (
      id TEXT PRIMARY KEY, outingId TEXT, userId TEXT,
      speciesName TEXT NOT NULL, speciesCode TEXT,
      taxonCode TEXT,
      count INTEGER DEFAULT 1, certainty TEXT DEFAULT 'confirmed');
    CREATE TABLE dex_meta (
      userId TEXT, groupKey TEXT, speciesName TEXT, speciesCode TEXT,
      addedDate TEXT, bestPhotoId TEXT, notes TEXT,
      PRIMARY KEY (userId, groupKey));
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
    expect(rows[0].taxonCode).toBe('norcar')
    expect(rows[0].totalOutings).toBe(2)
    expect(rows[0].totalCount).toBe(2)
  })

  it('omits an arbitrary exact taxon code when a group contains multiple exact taxa', () => {
    seed([
      { name: 'Southern Brown Kiwi (South I.)', code: 'sobkiw1', taxonCode: 'sobkiw2', outing: 'o1' },
      { name: 'Southern Brown Kiwi (Stewart I.)', code: 'sobkiw1', taxonCode: 'sobkiw3', outing: 'o2' },
    ])
    const [row] = run()
    expect(row.speciesName).toBe('Southern Brown Kiwi (South I.)')
    expect(row.speciesCode).toBe('sobkiw1')
    expect(row.taxonCode).toBeNull()
  })

  it('omits exact identity when a coded group mixes known and missing exact codes', () => {
    seed([
      { name: 'Southern Brown Kiwi', code: 'sobkiw1', taxonCode: null, outing: 'o1' },
      { name: 'Southern Brown Kiwi (South I.)', code: 'sobkiw1', taxonCode: 'sobkiw2', outing: 'o2' },
    ])
    expect(run()[0].taxonCode).toBeNull()
  })

  it('omits exact identity when every exact code is missing', () => {
    seed([
      { name: 'Southern Brown Kiwi', code: 'sobkiw1', taxonCode: null, outing: 'o1' },
      { name: 'Old Southern Brown Kiwi label', code: 'sobkiw1', taxonCode: null, outing: 'o2' },
    ])
    expect(run()[0].taxonCode).toBeNull()
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
      `INSERT INTO dex_meta (userId, groupKey, speciesName, speciesCode, notes)
       VALUES ('u1', 'code:norcar', 'Northern Cardinal', 'norcar', 'seen at the feeder')`).run()
    const rows = run()
    expect(rows[0].notes).toBe('seen at the feeder')
  })

  it('falls back to joining dex_meta by name when the code is null', () => {
    seed([{ name: 'Gull sp.', code: null, outing: 'o1' }])
    db.prepare(
      `INSERT INTO dex_meta (userId, groupKey, speciesName, speciesCode, notes)
       VALUES ('u1', 'name:Gull sp.', 'Gull sp.', NULL, 'could not tell which')`).run()
    const rows = run()
    expect(rows[0].notes).toBe('could not tell which')
  })

  it('finds legacy metadata saved under a non-minimum alias', () => {
    // The group displays MIN(speciesName), but old name-keyed metadata can sit
    // under any of the spellings that share the code. Joining only through the
    // displayed name orphaned it, which is the same silent loss this change is
    // meant to fix.
    seed([
      { name: 'Northern Cardinal', code: 'norcar', outing: 'o1' },
      { name: 'Northern Cardinal (Cardinalis cardinalis)', code: 'norcar', outing: 'o1' },
    ])
    db.prepare(
      `INSERT INTO dex_meta (userId, groupKey, speciesName, speciesCode, notes)
       VALUES ('u1', 'code:norcar', 'Northern Cardinal (Cardinalis cardinalis)', 'norcar', 'legacy note')`).run()
    const rows = run()
    expect(rows).toHaveLength(1)
    expect(rows[0].notes).toBe('legacy note')
  })

  it('attaches a name-keyed note to the coded group, not to two groups', () => {
    // During rollout the same name can exist both coded and uncoded. The note
    // must land on one entry, not be duplicated across both.
    seed([
      { name: 'Rock Pigeon', code: 'rocpig', outing: 'o1' },
      { name: 'Rock Pigeon', code: null, outing: 'o2' },
    ])
    db.prepare(
      `INSERT INTO dex_meta (userId, groupKey, speciesName, speciesCode, notes)
       VALUES ('u1', 'code:rocpig', 'Rock Pigeon', 'rocpig', 'one note')`).run()
    const rows = run()
    const withNote = rows.filter(r => r.notes === 'one note')
    expect(withNote).toHaveLength(1)
  })

  it('does not lose metadata that was saved by name before the code existed', () => {
    // functions/api/data/dex.ts still upserts by (userId, speciesName) and
    // leaves speciesCode NULL. Without the name-resolution CTE the note written
    // by that path is invisible to a coded observation, so every note, added
    // date and best photo silently disappears on the next dex recomputation.
    seed([{ name: 'Northern Cardinal', code: 'norcar', outing: 'o1' }])
    db.prepare(
      `INSERT INTO dex_meta (userId, groupKey, speciesName, speciesCode, notes)
       VALUES ('u1', 'code:norcar', 'Northern Cardinal', 'norcar', 'seen at the feeder')`).run()
    const rows = run()
    expect(rows[0].notes).toBe('seen at the feeder')
  })

  it('does not multiply totalCount when metadata is joined by group key', () => {
    seed([{ name: 'Northern Cardinal', code: 'norcar', outing: 'o1', count: 5 }])
    db.prepare(
      `INSERT INTO dex_meta (userId, groupKey, speciesName, speciesCode, notes)
       VALUES ('u1', 'code:norcar', 'Northern Cardinal', 'norcar', 'a')`).run()
    const rows = run()
    expect(rows).toHaveLength(1)
    expect(rows[0].totalCount).toBe(5)
    expect(rows[0].totalOutings).toBe(1)
  })

  it('prefers metadata stored against the code over a name-keyed leftover', () => {
    seed([{ name: 'Northern Cardinal', code: 'norcar', outing: 'o1' }])
    db.prepare(
      `INSERT INTO dex_meta (userId, groupKey, speciesName, speciesCode, notes)
       VALUES ('u1', 'name:Northern Cardinal', 'Northern Cardinal', NULL, 'old note')`).run()
    db.prepare(
      `INSERT INTO dex_meta (userId, groupKey, speciesName, speciesCode, notes)
       VALUES ('u1', 'code:norcar', 'Northern Cardinal', 'norcar', 'new note')`).run()
    const rows = run()
    expect(rows[0].notes).toBe('new note')
  })
})
