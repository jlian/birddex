import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RESULT_DESCRIPTION_HEADER } from '../lib/log'

const dependencies = vi.hoisted(() => ({
  computeDex: vi.fn(),
  createAuth: vi.fn(),
  exportDexToCSV: vi.fn(),
  getEbirdCode: vi.fn(),
  getOutingColumnNames: vi.fn(),
  getWikiMetadata: vi.fn(),
  hasObservationColumn: vi.fn(),
  searchSpecies: vi.fn(),
}))

vi.mock('../lib/auth', () => ({ createAuth: dependencies.createAuth }))
vi.mock('../lib/dex-query', () => ({
  computeDex: dependencies.computeDex,
  enrichDexEntries: (rows: unknown) => rows,
}))
vi.mock('../lib/ebird', () => ({ exportDexToCSV: dependencies.exportDexToCSV }))
vi.mock('../lib/schema', () => ({
  getOutingColumnNames: dependencies.getOutingColumnNames,
  hasObservationColumn: dependencies.hasObservationColumn,
}))
vi.mock('../lib/taxonomy', () => ({
  getEbirdCode: dependencies.getEbirdCode,
  getWikiMetadata: dependencies.getWikiMetadata,
  searchSpecies: dependencies.searchSpecies,
}))

import { onRequestGet as readLinkedProviders } from './auth/linked-providers'
import { onRequestGet as readAllData } from './data/all'
import { onRequestPatch as patchOuting } from './data/outings/[id]'
import { onRequestPost as persistPhotos } from './data/photos'
import { onRequestGet as exportDex } from './export/dex'
import { onRequestGet as readEbirdCode } from './species/ebird-code'
import { onRequestGet as searchSpecies } from './species/search'
import { onRequestGet as readWikiMetadata } from './species/wiki-title'

function statement(overrides: Record<string, unknown> = {}): D1PreparedStatement {
  const prepared = {
    bind: vi.fn(() => prepared),
    ...overrides,
  }
  return prepared as unknown as D1PreparedStatement
}

function context(
  url: string,
  options: {
    db?: D1Database
    body?: unknown
    method?: string
    params?: Record<string, string>
    userId?: string | null
  } = {},
) {
  const request = new Request(url, {
    method: options.method,
    headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  return {
    request,
    env: { DB: options.db ?? ({} as D1Database) },
    data: options.userId === null ? {} : { user: { id: options.userId ?? 'user-1' } },
    params: options.params ?? {},
  }
}

function description(response: Response): string | null {
  return response.headers.get(RESULT_DESCRIPTION_HEADER)
}

describe('request result descriptions', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    dependencies.computeDex.mockResolvedValue([])
    dependencies.createAuth.mockReturnValue({
      api: { getSession: vi.fn(async () => ({ user: { id: 'user-1' } })) },
    })
    dependencies.exportDexToCSV.mockReturnValue('csv')
    dependencies.getEbirdCode.mockReturnValue('amecro')
    dependencies.getOutingColumnNames.mockResolvedValue(new Set<string>())
    dependencies.getWikiMetadata.mockReturnValue({ wikiTitle: 'American_Crow' })
    dependencies.hasObservationColumn.mockResolvedValue(false)
    dependencies.searchSpecies.mockReturnValue([{ common: 'American Crow' }])
  })

  it('distinguishes linked-provider session and database stages without raw errors', async () => {
    const privateSessionError = 'private session backend detail'
    dependencies.createAuth.mockReturnValueOnce({
      api: { getSession: vi.fn(async () => { throw new Error(privateSessionError) }) },
    })

    const sessionResponse = await readLinkedProviders(context(
      'https://wingdex.test/api/auth/linked-providers',
      { userId: null },
    ) as never) as Response

    expect(sessionResponse.status).toBe(500)
    expect(description(sessionResponse)).toBe('Linked provider lookup failed during authenticated session lookup')
    expect(description(sessionResponse)).not.toContain(privateSessionError)

    const privateDatabaseError = 'private account table detail'
    const db = {
      prepare: vi.fn(() => statement({
        all: vi.fn(async () => { throw new Error(privateDatabaseError) }),
      })),
    } as unknown as D1Database
    const databaseResponse = await readLinkedProviders(context(
      'https://wingdex.test/api/auth/linked-providers',
      { db, userId: null },
    ) as never) as Response

    expect(databaseResponse.status).toBe(500)
    expect(description(databaseResponse)).toBe('Linked provider lookup failed during linked provider database query')
    expect(description(databaseResponse)).not.toContain(privateDatabaseError)
  })

  it('names the concurrent account-data read stage without exposing database details', async () => {
    const privateDatabaseError = 'private outing query detail'
    const db = {
      prepare: vi.fn((sql: string) => statement({
        all: vi.fn(async () => {
          if (sql.includes('FROM outing')) throw new Error(privateDatabaseError)
          return { results: [] }
        }),
      })),
    } as unknown as D1Database

    const response = await readAllData(context('https://wingdex.test/api/data/all', { db }) as never) as Response

    expect(response.status).toBe(500)
    expect(description(response)).toBe('Account data read failed during concurrent outing, photo, observation, and dex reads')
    expect(description(response)).not.toContain(privateDatabaseError)
  })

  it('reports the photo batch stage using only an aggregate count', async () => {
    const privateOutingId = 'private-outing-id'
    const privatePhotoId = 'private-photo-id'
    const db = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes('SELECT id FROM outing')) {
          return statement({ all: vi.fn(async () => ({ results: [{ id: privateOutingId }] })) })
        }
        if (sql.includes('SELECT id, userId, outingId FROM photo')) {
          return statement({ all: vi.fn(async () => ({ results: [] })) })
        }
        return statement()
      }),
      batch: vi.fn(async () => { throw new Error('private batch error') }),
    } as unknown as D1Database

    const response = await persistPhotos(context('https://wingdex.test/api/data/photos', {
      db,
      method: 'POST',
      body: [{
        id: privatePhotoId,
        outingId: privateOutingId,
        fileHash: 'private-hash',
        fileName: 'private-name.jpg',
      }],
    }) as never) as Response

    expect(response.status).toBe(500)
    expect(description(response)).toBe('Photo persistence failed during photo database batch write for 1 record')
    expect(description(response)).not.toContain(privateOutingId)
    expect(description(response)).not.toContain(privatePhotoId)
  })

  it('states that an outing patch committed before readback failed', async () => {
    const privateOutingId = 'private-outing-id'
    const db = {
      prepare: vi.fn((sql: string) => sql.startsWith('UPDATE')
        ? statement({ run: vi.fn(async () => ({ meta: { changes: 1 } })) })
        : statement({ all: vi.fn(async () => { throw new Error('private readback error') }) })),
    } as unknown as D1Database

    const response = await patchOuting(context(`https://wingdex.test/api/data/outings/${privateOutingId}`, {
      db,
      method: 'PATCH',
      body: { notes: 'private notes' },
      params: { id: privateOutingId },
    }) as never) as Response

    expect(response.status).toBe(500)
    expect(description(response)).toBe('Outing patch committed, but failed during updated outing readback')
    expect(description(response)).not.toContain(privateOutingId)
    expect(description(response)).not.toContain('private notes')
  })

  it('uses Generated CSV wording and identifies dex serialization failures', async () => {
    dependencies.computeDex.mockResolvedValueOnce([{}])
    const success = await exportDex(context('https://wingdex.test/api/export/dex') as never) as Response

    expect(success.status).toBe(200)
    expect(description(success)).toBe('Generated dex CSV with 1 species')

    dependencies.exportDexToCSV.mockImplementationOnce(() => {
      throw new Error('private species serialization detail')
    })
    const failure = await exportDex(context('https://wingdex.test/api/export/dex') as never) as Response

    expect(failure.status).toBe(500)
    expect(description(failure)).toBe('Dex CSV generation failed during dex CSV serialization')
    expect(description(failure)).not.toContain('private species')
  })

  it('keeps species lookup descriptions free of caller-provided names', async () => {
    const privateSpeciesName = 'private caller species name'
    const searchResponse = await searchSpecies(context(
      `https://wingdex.test/api/species/search?q=${encodeURIComponent(privateSpeciesName)}`,
    ) as never) as Response
    const codeResponse = await readEbirdCode(context(
      `https://wingdex.test/api/species/ebird-code?name=${encodeURIComponent(privateSpeciesName)}`,
    ) as never) as Response
    const wikiResponse = await readWikiMetadata(context(
      `https://wingdex.test/api/species/wiki-title?name=${encodeURIComponent(privateSpeciesName)}`,
    ) as never) as Response

    expect(description(searchResponse)).toBe('Species search returned 1 match')
    expect(description(codeResponse)).toBe('eBird code lookup found a code')
    expect(description(wikiResponse)).toBe('Wikipedia metadata lookup found a title')
    expect(JSON.stringify([
      description(searchResponse),
      description(codeResponse),
      description(wikiResponse),
    ])).not.toContain(privateSpeciesName)
  })

  it('returns a fixed taxonomy stage when species search fails', async () => {
    const privateError = 'private taxonomy error with species content'
    dependencies.searchSpecies.mockImplementationOnce(() => { throw new Error(privateError) })

    const response = await searchSpecies(context(
      'https://wingdex.test/api/species/search?q=private-query',
    ) as never) as Response

    expect(response.status).toBe(500)
    expect(description(response)).toBe('Species search failed during taxonomy search')
    expect(description(response)).not.toContain(privateError)
    expect(description(response)).not.toContain('private-query')
  })
})