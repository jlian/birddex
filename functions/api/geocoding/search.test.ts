import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'

import { onRequestPost } from './search'

/**
 * Route-level tests for forward place search.
 *
 * These drive the real handler, not `searchPlacesLocal` directly, because the
 * wiring is the thing under test: a working library reached through no caller
 * is exactly the state this replaced. The D1 stand-in is a real `node:sqlite`
 * database running real FTS5, so the SQL is executed rather than mocked.
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
  region?: string
}

const CORPUS: Row[] = [
  { osm_id: 'w1', label: 'Discovery Park', lat: 47.66, lon: -122.41, score: 25, kind: 'park', imp: 120, aliases: ['discovery park'], state: 'US-WA', country: 'US', region: 'King County' },
  { osm_id: 'w2', label: 'Green Lake', lat: 47.68, lon: -122.33, score: 25, kind: 'water', imp: 90, aliases: ['green lake'], state: 'US-WA', country: 'US', region: 'King County' },
]

/** Minimal D1 shim over node:sqlite, matching the subset the route uses. */
function d1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            all<T>() {
              const rows = db.prepare(sql).all(...values as never[]) as T[]
              return Promise.resolve({ results: rows, success: true, meta: {} })
            },
          }
        },
      }
    },
  } as unknown as D1Database
}

function buildIndex(): D1Database {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE places (
      id INTEGER PRIMARY KEY, osm_id TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
      lat REAL NOT NULL, lon REAL NOT NULL, score INTEGER NOT NULL,
      kind TEXT NOT NULL, imp INTEGER, qid TEXT, alias TEXT NOT NULL,
      state TEXT, country TEXT, region TEXT
    );
    CREATE TABLE place_alias (place_id INTEGER NOT NULL, alias TEXT NOT NULL);
    CREATE VIRTUAL TABLE places_fts USING fts5(
      alias, content=places, content_rowid=id,
      tokenize='unicode61 remove_diacritics 2', detail=none
    );
  `)
  const insert = db.prepare(
    'INSERT INTO places(id,osm_id,label,lat,lon,score,kind,imp,qid,alias,state,country,region)' +
      ' VALUES(?,?,?,?,?,?,?,?,NULL,?,?,?,?)',
  )
  const alias = db.prepare('INSERT INTO place_alias(place_id, alias) VALUES(?,?)')
  CORPUS.forEach((row, i) => {
    const id = i + 1
    insert.run(
      id, row.osm_id, row.label, row.lat, row.lon, row.score, row.kind,
      row.imp ?? null, row.aliases.join('|'), row.state ?? null, row.country ?? null,
      row.region ?? null,
    )
    for (const a of row.aliases) alias.run(id, a)
  })
  db.exec("INSERT INTO places_fts(rowid, alias) SELECT id, REPLACE(alias,'|',' ') FROM places")
  db.exec('CREATE INDEX idx_place_alias ON place_alias(alias, place_id)')
  return d1(db)
}

function invoke(env: Partial<Env>, query: unknown) {
  const context = {
    request: new Request('https://wingdex.app/api/geocoding/search', {
      method: 'POST',
      body: JSON.stringify({ query }),
    }),
    env: {
      GEOCODING_LIMITER: { limit: () => Promise.resolve({ success: true }) },
      ...env,
    },
    data: {},
  }
  return (onRequestPost as unknown as (c: unknown) => Promise<Response>)(context)
}

describe('POST /api/geocoding/search', () => {
  it('answers from the bound place index', async () => {
    const response = await invoke({ PLACES_SEARCH: buildIndex() }, 'discovery park')
    expect(response.status).toBe(200)
    const body = await response.json() as { results: { label: string; context?: string }[] }
    expect(body.results[0].label).toBe('Discovery Park')
    expect(body.results[0].context).toBe('King County, US')
  })

  it('never caches a search response', async () => {
    const response = await invoke({ PLACES_SEARCH: buildIndex() }, 'green lake')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('matches a token prefix, which issue #343 requires', async () => {
    const response = await invoke({ PLACES_SEARCH: buildIndex() }, 'discover par')
    const body = await response.json() as { results: { label: string }[] }
    expect(body.results[0].label).toBe('Discovery Park')
  })

  it('rejects a query outside the 2 to 200 character bound', async () => {
    const response = await invoke({ PLACES_SEARCH: buildIndex() }, 'x')
    expect(response.status).toBe(400)
  })

  it('reports the index as unavailable rather than returning no results', async () => {
    // A failing index must not look like an empty result set, which renders as
    // "no places found" and sends the user hunting for a place that exists.
    const broken = {
      prepare() {
        return { bind() { return { all() { throw new Error('D1_ERROR: no such table') } } } }
      },
    } as unknown as D1Database
    const response = await invoke({ PLACES_SEARCH: broken }, 'discovery park')
    expect(response.status).toBe(503)
  })

  it('does not put the query text in the response', async () => {
    // The query is user input and must not reach a log line or an error body.
    const broken = {
      prepare() {
        return { bind() { return { all() { throw new Error('D1_ERROR: no such table') } } } }
      },
    } as unknown as D1Database
    const response = await invoke({ PLACES_SEARCH: broken }, 'zzsecretplace')
    expect(await response.text()).not.toContain('zzsecretplace')
  })

  it('falls back to the provider only while no index is bound', async () => {
    // Migration behaviour: the binding lands with the published index, and
    // until then forward search must keep working.
    const gateway = await import('../../lib/geocoding-gateway')
    const spy = vi.spyOn(gateway, 'searchPlaces').mockResolvedValue([
      { label: 'Green Lake', lat: 47.68, lon: -122.33 },
    ])
    try {
      const response = await invoke({ GEOAPIFY_KEY: 'test-key' }, 'green lake')
      expect(response.status).toBe(200)
      expect(spy).toHaveBeenCalledOnce()
    } finally {
      spy.mockRestore()
    }
  })

  it('does not fall back when a bound index fails', async () => {
    // The fallback keys on the binding being ABSENT, never on a search
    // failing, so a broken index cannot silently revert to the provider this
    // PR exists to remove.
    const gateway = await import('../../lib/geocoding-gateway')
    const spy = vi.spyOn(gateway, 'searchPlaces')
    const broken = {
      prepare() {
        return { bind() { return { all() { throw new Error('D1_ERROR: no such table') } } } }
      },
    } as unknown as D1Database
    try {
      const response = await invoke({ PLACES_SEARCH: broken, GEOAPIFY_KEY: 'test-key' }, 'green lake')
      expect(response.status).toBe(503)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
