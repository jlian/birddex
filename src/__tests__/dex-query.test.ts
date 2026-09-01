import { describe, it, expect } from 'vitest'
import { computeDex, enrichDexEntries, type DexQueryDB, type DexRow } from '../../functions/lib/dex-query'
import Database from 'better-sqlite3'

/**
 * Minimal mock satisfying DexQueryDB, only needs prepare().bind().all().
 */
function createMockDB(rows: DexRow[]): DexQueryDB {
  return {
    prepare(_sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async all<T>() {
              return { results: rows as T[] }
            },
          }
        },
      }
    },
  }
}

describe('computeDex', () => {
  it('returns dex rows from the database', async () => {
    const mockRows: DexRow[] = [
      {
        id: 'code:norcar',
        speciesName: 'Northern Cardinal',
        firstSeenDate: '2025-09-15T10:00:00-07:00',
        lastSeenDate: '2025-10-01T08:30:00-07:00',
        addedDate: null,
        totalOutings: 3,
        totalCount: 5,
        bestPhotoId: 'photo-1',
        notes: 'Seen at feeder',
      },
      {
        id: 'code:blujay',
        speciesName: 'Blue Jay',
        firstSeenDate: '2025-08-20T07:00:00-07:00',
        lastSeenDate: '2025-08-20T07:00:00-07:00',
        addedDate: '2025-08-20',
        totalOutings: 1,
        totalCount: 2,
        bestPhotoId: null,
        notes: '',
      },
    ]

    const db = createMockDB(mockRows)
    const result = await computeDex(db, 'user-1')

    expect(result).toHaveLength(2)
    expect(result[0].speciesName).toBe('Northern Cardinal')
    expect(result[0].totalOutings).toBe(3)
    expect(result[0].totalCount).toBe(5)
    expect(result[0].bestPhotoId).toBe('photo-1')
    expect(result[0].notes).toBe('Seen at feeder')
    expect(result[1].speciesName).toBe('Blue Jay')
    expect(result[1].totalOutings).toBe(1)
  })

  it('returns empty array when user has no data', async () => {
    const db = createMockDB([])
    const result = await computeDex(db, 'user-no-data')
    expect(result).toEqual([])
  })

  it('preserves all fields including nullable ones', async () => {
    const row: DexRow = {
      id: 'code:baleag',
      speciesName: 'Bald Eagle',
      firstSeenDate: '2026-01-01T12:00:00Z',
      lastSeenDate: '2026-01-01T12:00:00Z',
      addedDate: '2026-01-01',
      totalOutings: 1,
      totalCount: 1,
      bestPhotoId: null,
      notes: '',
    }
    const db = createMockDB([row])
    const result = await computeDex(db, 'u1')
    expect(result[0].addedDate).toBe('2026-01-01')
    expect(result[0].bestPhotoId).toBeNull()
    expect(result[0].notes).toBe('')
  })

  it('SQL includes both confirmed and possible observations', async () => {
    const capturedSql: string[] = []
    const db: DexQueryDB = {
      prepare(sql: string) {
        capturedSql.push(sql)
        return {
          bind() {
            return { async all() { return { results: [] } } }
          },
        }
      },
    }
    await computeDex(db, 'user-1')
    const dexSql = capturedSql.find(sql => sql.includes('FROM observation obs')) ?? ''
    expect(dexSql).toContain("IN ('confirmed', 'possible')")
    expect(dexSql).not.toContain("certainty = 'confirmed'")
  })

  it('computes a name-keyed dex before species-code migrations apply', async () => {
    const sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE outing (id TEXT, userId TEXT, startTime TEXT);
      CREATE TABLE observation (
        id TEXT, outingId TEXT, userId TEXT, speciesName TEXT,
        count INTEGER, certainty TEXT
      );
      CREATE TABLE dex_meta (
        userId TEXT, speciesName TEXT, addedDate TEXT, bestPhotoId TEXT, notes TEXT
      );
      INSERT INTO outing VALUES ('o1', 'u1', '2026-01-01');
      INSERT INTO observation VALUES ('ob1', 'o1', 'u1', 'Northern Cardinal', 2, 'confirmed');
    `)
    const db = {
      prepare(sql: string) {
        return {
          bind(...parameters: unknown[]) {
            return {
              async all<T>() { return { results: sqlite.prepare(sql).all(...parameters) as T[] } },
            }
          },
          async all<T>() { return { results: sqlite.prepare(sql).all() as T[] } },
        }
      },
    } as DexQueryDB

    const rows = await computeDex(db, 'u1')
    expect(rows).toMatchObject([{
      id: 'name:Northern Cardinal',
      speciesName: 'Northern Cardinal',
      speciesCode: null,
      totalCount: 2,
    }])
  })

  it('propagates schema probe failures instead of selecting the legacy query', async () => {
    const db: DexQueryDB = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async all<T>() {
                if (sql.startsWith('PRAGMA table_info')) throw new Error('D1 unavailable')
                return { results: [] as T[] }
              },
            }
          },
        }
      },
    }

    await expect(computeDex(db, 'u1')).rejects.toThrow('D1 unavailable')
  })
})

describe('enrichDexEntries', () => {
  it('adds wiki metadata while preserving dex statistics and notes', () => {
    const row: DexRow = {
      id: 'code:norcar',
      speciesName: 'Northern Cardinal',
      firstSeenDate: '2026-01-01T12:00:00Z',
      lastSeenDate: '2026-01-02T12:00:00Z',
      addedDate: null,
      totalOutings: 2,
      totalCount: 3,
      bestPhotoId: null,
      notes: 'Backyard visitor',
    }

    const [entry] = enrichDexEntries([row])
    expect(entry).toMatchObject({
      speciesName: 'Northern Cardinal',
      totalOutings: 2,
      totalCount: 3,
      notes: 'Backyard visitor',
    })
    expect(entry.wikiTitle).toBeTruthy()
    expect(entry.thumbnailUrl).toMatch(/^https:\/\//)
    expect(entry.addedDate).toBeUndefined()
    expect(entry.bestPhotoId).toBeUndefined()
  })

  it('uses exact taxon identity for canonical display names', () => {
    const [entry] = enrichDexEntries([{
      id: 'code:sobkiw1',
      speciesName: 'Southern Brown Kiwi (South I.)',
      speciesCode: 'sobkiw1',
      taxonCode: 'sobkiw2',
      firstSeenDate: '2026-01-01',
      lastSeenDate: '2026-01-01',
      totalOutings: 1,
      totalCount: 1,
      notes: '',
    }])
    expect(entry).toMatchObject({
      commonName: 'Southern Brown Kiwi (South I.)',
      scientificName: 'Apteryx australis australis',
      taxonCode: 'sobkiw2',
    })
  })

  it('uses a grouping code to enrich legacy names without returning null codes', () => {
    const [entry, unknownEntry] = enrichDexEntries([{
      id: 'code:norcar',
      speciesName: 'Legacy cardinal label',
      speciesCode: 'norcar',
      taxonCode: null,
      firstSeenDate: '2026-01-01',
      lastSeenDate: '2026-01-01',
      totalOutings: 1,
      totalCount: 1,
      notes: '',
    }, {
      id: 'name:Unknown bird',
      speciesName: 'Unknown bird',
      speciesCode: null,
      firstSeenDate: '2026-01-01',
      lastSeenDate: '2026-01-01',
      totalOutings: 1,
      totalCount: 1,
      notes: '',
    }])

    expect(entry).toMatchObject({
      commonName: 'Northern Cardinal',
      scientificName: 'Cardinalis cardinalis',
      speciesCode: 'norcar',
      taxonCode: 'norcar',
    })
    expect(unknownEntry.speciesCode).toBeUndefined()
  })
})
