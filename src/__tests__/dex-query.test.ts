import { describe, it, expect } from 'vitest'
import { computeDex, enrichDexEntries, type DexQueryDB, type DexRow } from '../../functions/lib/dex-query'

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

  it('SQL includes both confirmed and possible observations', () => {
    let capturedSql = ''
    const db: DexQueryDB = {
      prepare(sql: string) {
        capturedSql = sql
        return {
          bind() {
            return { async all() { return { results: [] } } }
          },
        }
      },
    }
    void computeDex(db, 'user-1')
    expect(capturedSql).toContain("IN ('confirmed', 'possible')")
    expect(capturedSql).not.toContain("certainty = 'confirmed'")
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
})
