import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { SearchUnavailableError, searchPlacesLocal } from './place-search'

/**
 * Exercise `searchPlacesLocal` against a REAL SQLite database with the same
 * schema the offline builder produces.
 *
 * Folding and expression building were already covered, but nothing executed
 * the function itself, so the D1 binding, the missing-binding path, query
 * failure, the result limit and the region-code mapping could all regress
 * without a single test failing.
 *
 * A hand-written mock would not have caught the bugs this file exists to
 * prevent: the ranking is expressed in SQL, so the interesting failures are
 * SQL failures. An in-memory database with FTS5 runs the actual query.
 */

interface Row {
  osm_id: string
  label: string
  lat: number
  lon: number
  score: number
  kind: string
  imp: number | null
  aliases: string[]
  state?: string
  country?: string
}

/** Minimal D1-compatible shim over node:sqlite. */
function d1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      const statement = {
        bind(...values: unknown[]) {
          return {
            async all<T>() {
              const results = db.prepare(sql).all(...(values as never[])) as T[]
              return { results, success: true, meta: {} }
            },
          }
        },
      }
      return statement as unknown as D1PreparedStatement
    },
  } as unknown as D1Database
}

function build(rows: Row[]): D1Database {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE places (
      id INTEGER PRIMARY KEY, osm_id TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
      lat REAL NOT NULL, lon REAL NOT NULL, score INTEGER NOT NULL,
      kind TEXT NOT NULL, imp INTEGER, qid TEXT, alias TEXT NOT NULL,
      state TEXT, country TEXT
    );
    CREATE TABLE place_alias (place_id INTEGER NOT NULL, alias TEXT NOT NULL);
    CREATE VIRTUAL TABLE places_fts USING fts5(
      alias, content=places, content_rowid=id,
      tokenize='unicode61 remove_diacritics 2', detail=none
    );
  `)
  const insert = db.prepare(
    'INSERT INTO places(id,osm_id,label,lat,lon,score,kind,imp,qid,alias,state,country)' +
      ' VALUES(?,?,?,?,?,?,?,?,NULL,?,?,?)',
  )
  const alias = db.prepare('INSERT INTO place_alias(place_id, alias) VALUES(?,?)')
  rows.forEach((row, i) => {
    const id = i + 1
    insert.run(
      id, row.osm_id, row.label, row.lat, row.lon, row.score, row.kind,
      row.imp ?? null, row.aliases.join('|'), row.state ?? null, row.country ?? null,
    )
    for (const a of row.aliases) alias.run(id, a)
  })
  db.exec("INSERT INTO places_fts(rowid, alias) SELECT id, REPLACE(alias,'|',' ') FROM places")
  db.exec('CREATE INDEX idx_place_alias ON place_alias(alias, place_id)')
  return d1(db)
}

const CORPUS: Row[] = [
  { osm_id: 'w1', label: 'Discovery Park', lat: 47.66, lon: -122.41, score: 25, kind: 'park', imp: 120, aliases: ['discovery park'], state: 'US-WA', country: 'US' },
  { osm_id: 'w2', label: 'Discovery Parkway', lat: 40.0, lon: -80.0, score: 22, kind: 'landuse', imp: null, aliases: ['discovery parkway'], state: 'US-OH', country: 'US' },
  { osm_id: 'w3', label: 'Central Park', lat: 40.78, lon: -73.96, score: 25, kind: 'park', imp: 200, aliases: ['central park'], state: 'US-NY', country: 'US' },
  { osm_id: 'w4', label: 'Centralni park', lat: 50.0, lon: 14.0, score: 25, kind: 'park', imp: 10, aliases: ['centralni park'], state: 'CZ-10', country: 'CZ' },
  { osm_id: 'w5', label: 'Casablanca', lat: 33.6, lon: -7.6, score: 14, kind: 'admin', imp: 180, aliases: ['casablanca', 'casa', 'dar el beida'], country: 'MA' },
  { osm_id: 'w6', label: 'Memorial Park', lat: 47.1, lon: -122.1, score: 25, kind: 'park', imp: null, aliases: ['memorial park'], state: 'US-WA', country: 'US' },
  { osm_id: 'w7', label: 'Memorial Park', lat: 47.2, lon: -122.2, score: 25, kind: 'park', imp: null, aliases: ['memorial park'], state: 'US-WA', country: 'US' },
  { osm_id: 'w8', label: 'Donana', lat: 37.0, lon: -6.4, score: 24, kind: 'reserve', imp: 150, aliases: ['donana'], state: 'ES-AN', country: 'ES' },
]

describe('searchPlacesLocal', () => {
  it('finds a place and maps its region codes', async () => {
    const results = await searchPlacesLocal(build(CORPUS), 'Discovery Park')
    expect(results[0]).toEqual({
      label: 'Discovery Park',
      stateProvince: 'US-WA',
      countryCode: 'US',
      context: 'US-WA',
      lat: 47.66,
      lon: -122.41,
    })
  })

  it('ranks an exact alias above a longer prefix match', async () => {
    // Without the exact-alias boost, bm25 alone can put `Discovery Parkway`
    // first, since both rows match the same tokens.
    const results = await searchPlacesLocal(build(CORPUS), 'discovery park')
    expect(results[0].label).toBe('Discovery Park')
  })

  it('ranks an exact match above a foreign near-match', async () => {
    const results = await searchPlacesLocal(build(CORPUS), 'central park')
    expect(results[0].label).toBe('Central Park')
  })

  it('ranks identical exact names by category, then importance, per issue step 12', async () => {
    // Text quality cannot separate names that are identical, so the documented
    // order takes over: category score, then importance, then the stable id.
    // Among equal-category rows, importance decides, so New York wins.
    const rows: Row[] = [
      { osm_id: 'w21', label: 'Central Park', lat: 40.78, lon: -73.96, score: 25, kind: 'park', imp: 156, aliases: ['central park'], state: 'US-NY', country: 'US' },
      { osm_id: 'w22', label: 'Central Park', lat: 49.0, lon: 16.0, score: 25, kind: 'park', imp: 43, aliases: ['central park'], country: 'CZ' },
    ]
    const results = await searchPlacesLocal(build(rows), 'central park')
    expect(results[0].stateProvince).toBe('US-NY')
  })

  it('still uses the category score to break a tie among non-exact matches', async () => {
    // Outside the exact group the original order stands: a park outranks a
    // hotel when neither name matches the query exactly.
    const rows: Row[] = [
      { osm_id: 'w30', label: 'Lakeside Hotel', lat: 1, lon: 1, score: 19, kind: 'lodging', imp: null, aliases: ['lakeside hotel'], country: 'US' },
      { osm_id: 'w31', label: 'Lakeside Park', lat: 2, lon: 2, score: 25, kind: 'park', imp: null, aliases: ['lakeside park'], country: 'US' },
    ]
    const results = await searchPlacesLocal(build(rows), 'lakeside')
    expect(results[0].label).toBe('Lakeside Park')
  })

  it('boosts an exact match on a SECONDARY alias', async () => {
    // `casa` is the second of three aliases. When aliases were space-joined
    // into one column, equality could only ever fire for single-alias rows.
    const results = await searchPlacesLocal(build(CORPUS), 'casa')
    expect(results[0].label).toBe('Casablanca')
  })

  it('matches a partial last token, per the issue requirement', async () => {
    const results = await searchPlacesLocal(build(CORPUS), 'discover par')
    expect(results[0].label).toBe('Discovery Park')
  })

  it('folds diacritics so an ASCII query finds an accented name', async () => {
    const results = await searchPlacesLocal(build(CORPUS), 'Doñana')
    expect(results[0].label).toBe('Donana')
  })

  it('keeps distinct places that share a name and a region', async () => {
    // Two real parks called `Memorial Park` in US-WA are different
    // destinations. De-duplicating by label silently removed a valid answer.
    const results = await searchPlacesLocal(build(CORPUS), 'memorial park')
    expect(results.filter((r) => r.label === 'Memorial Park')).toHaveLength(2)
  })

  it('omits region fields when the record has none', async () => {
    const results = await searchPlacesLocal(build(CORPUS), 'casablanca')
    expect(results[0].stateProvince).toBeUndefined()
    expect(results[0].countryCode).toBe('MA')
  })

  it('returns at most five results', async () => {
    const many: Row[] = Array.from({ length: 12 }, (_, i) => ({
      osm_id: `n${i}`, label: `Lake ${i}`, lat: 1, lon: 1, score: 24,
      kind: 'water', imp: null, aliases: [`lake ${i}`], country: 'US',
    }))
    const results = await searchPlacesLocal(build(many), 'lake')
    expect(results).toHaveLength(5)
  })

  it('is deterministic across identical calls', async () => {
    const db = build(CORPUS)
    const a = await searchPlacesLocal(db, 'park')
    const b = await searchPlacesLocal(db, 'park')
    expect(a.map((r) => r.label)).toEqual(b.map((r) => r.label))
  })

  it('returns nothing for a query that matches no place', async () => {
    expect(await searchPlacesLocal(build(CORPUS), 'zzzznotaplace')).toEqual([])
  })

  it('returns nothing when folding empties the query', async () => {
    // Punctuation-only input passes the length check but folds to nothing, and
    // an empty MATCH expression is an FTS5 syntax error rather than no results.
    expect(await searchPlacesLocal(build(CORPUS), '---')).toEqual([])
  })

  it('treats FTS5 operators as literal text', async () => {
    // Unquoted, `OR` would widen the query and a bare `*` would error.
    await expect(searchPlacesLocal(build(CORPUS), 'park OR lake')).resolves.toEqual([])
    await expect(searchPlacesLocal(build(CORPUS), 'park*')).resolves.toBeInstanceOf(Array)
  })

  it('rejects a query outside 2 to 200 characters', async () => {
    const db = build(CORPUS)
    await expect(searchPlacesLocal(db, 'a')).rejects.toThrow('Invalid search query')
    await expect(searchPlacesLocal(db, 'x'.repeat(201))).rejects.toThrow('Invalid search query')
  })

  it('raises rather than returning empty when no database is bound', async () => {
    // An empty array renders as "no places found", which would send someone
    // hunting for a place that exists. A missing binding is a 503.
    await expect(searchPlacesLocal(undefined, 'discovery park')).rejects.toBeInstanceOf(
      SearchUnavailableError,
    )
  })

  it('raises when the query itself fails', async () => {
    const broken = {
      prepare() {
        return { bind() { return { all() { throw new Error('D1_ERROR: no such table') } } } }
      },
    } as unknown as D1Database
    await expect(searchPlacesLocal(broken, 'discovery park')).rejects.toBeInstanceOf(
      SearchUnavailableError,
    )
  })
})
