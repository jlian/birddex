import { describe, it, expect, vi, beforeEach } from 'vitest'

/** Queued Wikipedia responses (consumed FIFO). */
const wikiQueue: Array<{ ok: boolean; status?: number; json?: () => Promise<unknown> }> = []

/** Override the wiki-title API response for a specific test. */
let wikiTitleOverride: { wikiTitle: string | null; common: string | null; scientific: string | null } | null = null

const mockFetch = vi.fn((url: string) => {
  if (typeof url === 'string' && url.includes('/api/species/wiki-title')) {
    const body = wikiTitleOverride ?? { wikiTitle: null, common: null, scientific: null }
    return Promise.resolve({ ok: true, json: async () => body })
  }
  // Dequeue the next Wikipedia response
  const next = wikiQueue.shift()
  if (next) return Promise.resolve(next)
  return Promise.resolve({ ok: false, status: 404 })
})

vi.stubGlobal('fetch', mockFetch)

function createLocalStorageMock() {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value))
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
  }
}

const localStorageMock = createLocalStorageMock()
vi.stubGlobal('localStorage', localStorageMock)
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'localStorage', {
    value: localStorageMock,
    configurable: true,
  })
}

// Import after mocking
const { getWikimediaImage, getWikimediaSummary } = await import('@/lib/wikimedia')

function mockWikiResponse(data: Record<string, unknown> | null) {
  if (data === null) {
    wikiQueue.push({ ok: false, status: 404 })
  } else {
    wikiQueue.push({
      ok: true,
      json: async () => data,
    })
  }
}

function mockTransientError() {
  wikiQueue.push({ ok: false, status: 500 })
}

function wikiPageData(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Test Bird',
    extract: 'A small bird.',
    thumbnail: { source: 'https://upload.wikimedia.org/thumb/100px-bird.jpg' },
    originalimage: { source: 'https://upload.wikimedia.org/bird.jpg' },
    content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Test_Bird' } },
    ...overrides,
  }
}

// == getWikimediaImage ========================================

/** Return only the fetch calls to Wikipedia (not the wiki-title API). */
function wikiCalls() {
  return mockFetch.mock.calls.filter(
    ([url]: [string]) => !url.includes('/api/species/wiki-title')
  )
}

describe('getWikimediaImage', () => {
  beforeEach(() => {
    mockFetch.mockClear()
    wikiQueue.length = 0
    wikiTitleOverride = null
  })

  it('uses species display name for lookup (single fetch)', async () => {
    mockWikiResponse(wikiPageData({
      thumbnail: { source: 'https://upload.wikimedia.org/thumb/300px-hummingbird.jpg' },
    }))

    const result = await getWikimediaImage('Ruby-throated hummingbird (Archilochus colubris)')
    expect(result).toContain('hummingbird.jpg')
    expect(wikiCalls()).toHaveLength(1)
    expect(wikiCalls()[0][0]).toContain('Ruby-throated_hummingbird')
  })

  it('uses taxonomy wikiTitle for Chukar image lookup', async () => {
    wikiTitleOverride = { wikiTitle: 'Chukar partridge', common: 'Chukar', scientific: 'Alectoris chukar' }
    mockWikiResponse(wikiPageData({
      thumbnail: { source: 'https://upload.wikimedia.org/thumb/chukar.jpg' },
    }))

    const result = await getWikimediaImage('Chukar (Alectoris chukar)')
    expect(result).toContain('chukar.jpg')
    expect(wikiCalls()).toHaveLength(1)
    expect(wikiCalls()[0][0]).toContain('Chukar_partridge')
  })

  it('returns undefined when species page is missing', async () => {
    mockWikiResponse(null)

    const result = await getWikimediaImage('Unknown Bird X')
    expect(result).toBeUndefined()
    expect(wikiCalls().length).toBeGreaterThanOrEqual(1)
  })

  it('returns undefined when wiki page has no image', async () => {
    mockWikiResponse(wikiPageData({ thumbnail: undefined, originalimage: undefined }))

    const result = await getWikimediaImage('Unique Warbler B2')
    expect(result).toBeUndefined()
    expect(wikiCalls()).toHaveLength(1)
  })

  it('prefers thumbnail URL when available', async () => {
    mockWikiResponse(wikiPageData({
      thumbnail: { source: 'https://upload.wikimedia.org/thumb/100px-bird.jpg' },
      originalimage: { source: 'https://upload.wikimedia.org/original-bird.jpg' },
    }))

    const result = await getWikimediaImage('Unique Finch E')
    expect(result).toBe('https://upload.wikimedia.org/thumb/100px-bird.jpg')
  })

  it('does not upsize thumbnail URL to avoid 404 on small originals (iOS regression)', async () => {
    mockWikiResponse(wikiPageData({
      thumbnail: { source: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Bird.jpg/220px-Bird.jpg' },
    }))

    const result = await getWikimediaImage('Small Image Bird R')
    // Must use the URL exactly as returned by Wikipedia -- upsizing beyond the
    // original image dimensions causes a 404 on Wikimedia servers, which
    // breaks thumbnails on iOS Safari and other browsers.
    expect(result).toBe('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Bird.jpg/220px-Bird.jpg')
  })

  it('tries alternate titles when first hit has no image', async () => {
    wikiTitleOverride = { wikiTitle: 'Imageless Bird', common: 'Imageful Bird', scientific: null }
    mockWikiResponse(wikiPageData({
      title: 'Imageless Bird',
      thumbnail: undefined,
      originalimage: undefined,
    }))
    mockWikiResponse(wikiPageData({
      title: 'Imageful Bird',
      thumbnail: { source: 'https://upload.wikimedia.org/thumb/imageful.jpg' },
    }))

    const result = await getWikimediaImage('Imageful Bird (Testus imagus)')
    expect(result).toContain('imageful.jpg')
    expect(wikiCalls()).toHaveLength(2)
    expect(wikiCalls()[0][0]).toContain('Imageless_Bird')
    expect(wikiCalls()[1][0]).toContain('Imageful_Bird')
  })

  it('caches results for subsequent calls', async () => {
    mockWikiResponse(wikiPageData())

    const result1 = await getWikimediaImage('Unique Owl F')
    const result2 = await getWikimediaImage('Unique Owl F')

    expect(result1).toBe(result2)
    expect(wikiCalls()).toHaveLength(1)
  })

  it('does not cache transient errors so retries are possible', async () => {
    mockTransientError()

    const result1 = await getWikimediaImage('Retry Bird G')
    expect(result1).toBeUndefined()
    const firstWikiCallCount = wikiCalls().length

    // Second call should retry (not serve from cache)
    mockWikiResponse(wikiPageData({
      thumbnail: { source: 'https://upload.wikimedia.org/thumb/retry-bird.jpg' },
    }))
    const result2 = await getWikimediaImage('Retry Bird G')
    expect(result2).toContain('retry-bird.jpg')
    expect(wikiCalls().length).toBeGreaterThan(firstWikiCallCount)
  })
})

// == getWikimediaSummary ======================================

describe('getWikimediaSummary', () => {
  beforeEach(() => {
    mockFetch.mockClear()
    wikiQueue.length = 0
    wikiTitleOverride = null
  })

  it('uses species display name for summary lookup (single fetch)', async () => {
    wikiTitleOverride = { wikiTitle: 'Merlin (bird)', common: 'Merlin', scientific: 'Falco columbarius' }
    mockWikiResponse(wikiPageData({
      title: 'Merlin (bird)',
      extract: 'The merlin is a small species of falcon.',
    }))

    const result = await getWikimediaSummary('Merlin T2 (Falco columbarius)')
    expect(result).toBeDefined()
    expect(result!.title).toBe('Merlin (bird)')
    expect(result!.extract).toContain('falcon')
    expect(wikiCalls()).toHaveLength(1)
    expect(wikiCalls()[0][0]).toContain('Merlin_(bird)')
  })

  it('returns summary with title, extract, imageUrl, and pageUrl', async () => {
    mockWikiResponse(wikiPageData({
      title: 'Northern Cardinal',
      extract: 'The northern cardinal is a songbird.',
      originalimage: { source: 'https://upload.wikimedia.org/cardinal.jpg' },
      content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Northern_Cardinal' } },
    }))

    const result = await getWikimediaSummary('Unique Cardinal H')
    expect(result).toBeDefined()
    expect(result!.title).toBe('Northern Cardinal')
    expect(result!.extract).toContain('songbird')
    expect(result!.imageUrl).toContain('cardinal.jpg')
    expect(result!.pageUrl).toContain('Northern_Cardinal')
  })

  it('returns undefined when species summary page is missing', async () => {
    mockWikiResponse(null)

    const result = await getWikimediaSummary('Unknown Bird Y')
    expect(result).toBeUndefined()
    expect(wikiCalls().length).toBeGreaterThanOrEqual(1)
  })

  it('returns undefined when wiki page has no extract', async () => {
    mockWikiResponse(wikiPageData({ extract: undefined }))

    const result = await getWikimediaSummary('Unique Empty Z')
    expect(result).toBeUndefined()
    expect(wikiCalls()).toHaveLength(1)
  })

  it('uses first hit text with later hit image when first has no image', async () => {
    wikiTitleOverride = { wikiTitle: 'Textful Bird', common: 'Imageful Bird', scientific: null }
    mockWikiResponse(wikiPageData({
      title: 'Textful Bird',
      extract: 'Best summary text.',
      thumbnail: undefined,
      originalimage: undefined,
      content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Textful_Bird' } },
    }))
    mockWikiResponse(wikiPageData({
      title: 'Imageful Bird',
      extract: 'Other summary.',
      thumbnail: { source: 'https://upload.wikimedia.org/thumb/img.jpg' },
      originalimage: { source: 'https://upload.wikimedia.org/img-full.jpg' },
    }))

    const result = await getWikimediaSummary('Imageful Bird SUM (Testus textus)')
    expect(result).toBeDefined()
    // Text from first hit
    expect(result!.title).toBe('Textful Bird')
    expect(result!.extract).toBe('Best summary text.')
    expect(result!.pageUrl).toContain('Textful_Bird')
    // Image from second hit
    expect(result!.imageUrl).toContain('img-full.jpg')
  })

  it('caches results for subsequent calls', async () => {
    mockWikiResponse(wikiPageData({ extract: 'Cached bird.' }))

    const result1 = await getWikimediaSummary('Unique Wren K')
    const result2 = await getWikimediaSummary('Unique Wren K')

    expect(result1).toEqual(result2)
    expect(wikiCalls()).toHaveLength(1)
  })

  it('handles fetch errors gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'))

    const result = await getWikimediaSummary('Unique Dove L')
    expect(result).toBeUndefined()
  })
})

// == Shared cache =============================================

describe('shared cache between image and summary', () => {
  beforeEach(() => {
    mockFetch.mockClear()
    wikiQueue.length = 0
    wikiTitleOverride = null
  })

  it('getWikimediaSummary reuses the fetch from getWikimediaImage (no duplicate API call)', async () => {
    mockWikiResponse(wikiPageData({
      title: 'Peregrine Falcon',
      extract: 'The peregrine falcon is the fastest bird.',
      thumbnail: { source: 'https://upload.wikimedia.org/thumb/peregrine.jpg' },
      originalimage: { source: 'https://upload.wikimedia.org/peregrine-full.jpg' },
      content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Peregrine_Falcon' } },
    }))

    // First: image fetch (like list view BirdRow)
    const imageUrl = await getWikimediaImage('Unique Peregrine SC1')
    expect(imageUrl).toContain('peregrine.jpg')
    const callsAfterImage = wikiCalls().length

    // Second: summary fetch (like detail view) -- should NOT make another Wikipedia call
    const summary = await getWikimediaSummary('Unique Peregrine SC1')
    expect(summary).toBeDefined()
    expect(summary!.extract).toContain('fastest bird')
    expect(summary!.imageUrl).toBe('https://upload.wikimedia.org/peregrine-full.jpg')
    expect(wikiCalls()).toHaveLength(callsAfterImage) // no new Wikipedia calls
  })

  it('getWikimediaImage reuses the fetch from getWikimediaSummary', async () => {
    mockWikiResponse(wikiPageData({
      thumbnail: { source: 'https://upload.wikimedia.org/thumb/osprey.jpg' },
      originalimage: { source: 'https://upload.wikimedia.org/osprey-full.jpg' },
    }))

    const summary = await getWikimediaSummary('Unique Osprey SC2')
    expect(summary).toBeDefined()
    const callsAfterSummary = wikiCalls().length

    const imageUrl = await getWikimediaImage('Unique Osprey SC2')
    expect(imageUrl).toContain('osprey.jpg')
    expect(wikiCalls()).toHaveLength(callsAfterSummary) // no new Wikipedia calls
  })
})

describe('localStorage cache persistence', () => {
  beforeEach(() => {
    mockFetch.mockClear()
    wikiQueue.length = 0
    wikiTitleOverride = null
    localStorage.clear()
  })

  it('writes restCache to localStorage after a fetch', async () => {
    mockWikiResponse(wikiPageData({
      title: 'Persist Bird',
      thumbnail: { source: 'https://upload.wikimedia.org/thumb/persist-bird.jpg' },
    }))

    const imageUrl = await getWikimediaImage('Persist Bird LS1')
    expect(imageUrl).toContain('persist-bird.jpg')

    await new Promise(resolve => setTimeout(resolve, 150))

    const stored = localStorage.getItem('wiki-rest-cache')
    expect(stored).toBeTruthy()
    const entries = JSON.parse(stored as string) as Array<[string, unknown]>
    expect(entries.some(([key]) => key === 'persist bird ls1')).toBe(true)
  })

  it('hydrates from localStorage on module re-import and avoids new Wikipedia fetch', async () => {
    const seeded = wikiPageData({
      title: 'Hydrate Bird',
      thumbnail: { source: 'https://upload.wikimedia.org/thumb/hydrate-bird.jpg' },
    })
    localStorage.setItem('wiki-rest-cache', JSON.stringify([
      ['hydrate bird', seeded],
    ]))

    vi.resetModules()
    vi.stubGlobal('fetch', mockFetch)
    const { getWikimediaImage: freshGetWikimediaImage } = await import('@/lib/wikimedia')

    const callsBefore = wikiCalls().length
    const imageUrl = await freshGetWikimediaImage('Hydrate Bird (Hydratus birdus)')

    expect(imageUrl).toContain('hydrate-bird.jpg')
    expect(wikiCalls()).toHaveLength(callsBefore)
  })
})

// == getWikimediaGallery (Commons search) =====================

const { getWikimediaGallery } = await import('@/lib/wikimedia')

/** Helper: build a mock Commons API response with the given pages. */
function commonsResponse(pages: Record<string, {
  title?: string
  index?: number
  thumburl?: string
  descriptionurl?: string
  mime?: string
  description?: string
  assessments?: string
}>) {
  const pagesObj: Record<string, unknown> = {}
  for (const [id, p] of Object.entries(pages)) {
    pagesObj[id] = {
      title: p.title ?? `File:bird-${id}.jpg`,
      index: p.index ?? Number(id),
      imageinfo: [{
        thumburl: p.thumburl ?? `https://upload.wikimedia.org/thumb/${id}.jpg`,
        descriptionurl: p.descriptionurl,
        mime: p.mime ?? 'image/jpeg',
        extmetadata: {
          ImageDescription: { value: p.description ?? '' },
          Assessments: { value: p.assessments ?? '' },
        },
      }],
    }
  }
  return { ok: true, json: async () => ({ query: { pages: pagesObj } }) }
}

describe('getWikimediaGallery', () => {
  beforeEach(() => {
    mockFetch.mockClear()
    wikiQueue.length = 0
    wikiTitleOverride = null
  })

  it('returns gallery images from Commons search', async () => {
    mockFetch.mockImplementationOnce(() => Promise.resolve(commonsResponse({
      '1': { title: 'File:Lesser Scaup male.jpg', index: 1, description: 'A male lesser scaup' },
      '2': { title: 'File:Lesser Scaup female.jpg', index: 2, description: 'A female lesser scaup' },
    })))

    const result = await getWikimediaGallery('Lesser Scaup Gallery1')
    expect(result).toHaveLength(2)
    expect(result[0].url).toContain('1.jpg')
    expect(result[1].url).toContain('2.jpg')
  })

  it('filters out SVGs, range maps, and other non-photo files', async () => {
    mockFetch.mockImplementationOnce(() => Promise.resolve(commonsResponse({
      '1': { title: 'File:Bird photo.jpg', index: 1 },
      '2': { title: 'File:Bird_range_map.png', index: 2 },
      '3': { title: 'File:IUCN_status.svg', index: 3 },
      '4': { title: 'File:Bird_distribution.gif', index: 4 },
      '5': { title: 'File:Bird_skeleton_museum.jpg', index: 5 },
    })))

    const result = await getWikimediaGallery('Filter Bird Gallery2')
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('File:Bird photo.jpg')
  })

  it('filters out images with egg/nest/specimen captions', async () => {
    mockFetch.mockImplementationOnce(() => Promise.resolve(commonsResponse({
      '1': { title: 'File:Good photo.jpg', index: 1, description: 'A beautiful bird' },
      '2': { title: 'File:Nest photo.jpg', index: 2, description: 'Bird nest with eggs' },
      '3': { title: 'File:Specimen.jpg', index: 3, description: 'Taxiderm specimen in museum' },
    })))

    const result = await getWikimediaGallery('Caption Bird Gallery3')
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('File:Good photo.jpg')
  })

  it('scores featured images above quality above regular', async () => {
    mockFetch.mockImplementationOnce(() => Promise.resolve(commonsResponse({
      '1': { title: 'File:Regular.jpg', index: 1, assessments: '' },
      '2': { title: 'File:Featured.jpg', index: 2, assessments: 'featured' },
      '3': { title: 'File:Quality.jpg', index: 3, assessments: 'quality' },
    })))

    const result = await getWikimediaGallery('Scored Bird Gallery4')
    expect(result).toHaveLength(3)
    expect(result[0].title).toBe('File:Featured.jpg')
    expect(result[1].title).toBe('File:Quality.jpg')
    expect(result[2].title).toBe('File:Regular.jpg')
  })

  it('parses plumage from captions and titles', async () => {
    mockFetch.mockImplementationOnce(() => Promise.resolve(commonsResponse({
      '1': { title: 'File:Drake Lesser Scaup.jpg', index: 1, description: 'A drake on water' },
      '2': { title: 'File:Lesser Scaup hen.jpg', index: 2, description: 'Female resting' },
      '3': { title: 'File:Juvenile bird.jpg', index: 3, description: 'An immature bird' },
      '4': { title: 'File:Adult bird.jpg', index: 4, description: 'No plumage info' },
    })))

    const result = await getWikimediaGallery('Plumage Bird Gallery5')
    expect(result[0].plumage).toBe('male')
    expect(result[1].plumage).toBe('female')
    expect(result[2].plumage).toBe('juvenile')
    expect(result[3].plumage).toBeUndefined()
  })

  it('does not match "female" as "male"', async () => {
    mockFetch.mockImplementationOnce(() => Promise.resolve(commonsResponse({
      '1': { title: 'File:Female bird.jpg', index: 1, description: 'A female bird' },
    })))

    const result = await getWikimediaGallery('Female Only Gallery6')
    expect(result[0].plumage).toBe('female')
    expect(result[0].plumage).not.toContain('male,')
  })

  it('respects limit parameter', async () => {
    mockFetch.mockImplementationOnce(() => Promise.resolve(commonsResponse({
      '1': { title: 'File:A.jpg', index: 1 },
      '2': { title: 'File:B.jpg', index: 2 },
      '3': { title: 'File:C.jpg', index: 3 },
      '4': { title: 'File:D.jpg', index: 4 },
    })))

    const result = await getWikimediaGallery('Limit Bird Gallery7', { limit: 2 })
    expect(result).toHaveLength(2)
  })

  it('caches results for subsequent calls', async () => {
    mockFetch.mockImplementationOnce(() => Promise.resolve(commonsResponse({
      '1': { title: 'File:Cached.jpg', index: 1 },
    })))

    const result1 = await getWikimediaGallery('Cached Bird Gallery8')
    const result2 = await getWikimediaGallery('Cached Bird Gallery8')
    expect(result1).toEqual(result2)
    const commonsCalls = mockFetch.mock.calls.filter(([url]: [string]) => url.includes('commons.wikimedia.org'))
    expect(commonsCalls).toHaveLength(1)
  })

  it('returns empty array on fetch error', async () => {
    mockFetch.mockImplementationOnce(() => Promise.reject(new Error('Network error')))

    const result = await getWikimediaGallery('Error Bird Gallery9')
    expect(result).toEqual([])
  })

  it('returns empty array when API returns no pages', async () => {
    mockFetch.mockImplementationOnce(() => Promise.resolve({
      ok: true, json: async () => ({ query: {} }),
    }))

    const result = await getWikimediaGallery('Empty Bird Gallery10')
    expect(result).toEqual([])
  })

  it('strips HTML from captions', async () => {
    mockFetch.mockImplementationOnce(() => Promise.resolve(commonsResponse({
      '1': { title: 'File:Bird.jpg', index: 1, description: '<b>A <i>beautiful</i> bird</b> in flight' },
    })))

    const result = await getWikimediaGallery('HTML Bird Gallery11')
    expect(result[0].caption).toBe('A beautiful bird in flight')
  })

  it('drops results that are not JPEG photos', async () => {
    mockFetch.mockImplementationOnce(() => Promise.resolve(commonsResponse({
      '1': { title: 'File:Chick.png', index: 1, mime: 'image/png' },
      '2': { title: 'File:Speaker icon.jpg', index: 2, mime: 'image/svg+xml' },
      '3': { title: 'File:Real photo.jpg', index: 3 },
    })))

    const result = await getWikimediaGallery('Mime Bird Gallery12')
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('File:Real photo.jpg')
  })

  it('filters Spanish nest and chick titles', async () => {
    mockFetch.mockImplementationOnce(() => Promise.resolve(commonsResponse({
      '1': { title: 'File:Quiscalus mexicanus, nido urbano 02.jpg', index: 1 },
      '2': { title: 'File:Polluelo de zanate.jpg', index: 2 },
      '3': { title: 'File:Zanate mexicano en zona urbana.jpg', index: 3 },
    })))

    const result = await getWikimediaGallery('Spanish Bird Gallery13')
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('File:Zanate mexicano en zona urbana.jpg')
  })

  it('puts the Wikipedia lead image first', async () => {
    mockFetch.mockImplementationOnce(() => Promise.resolve(commonsResponse({
      '1': { title: 'File:Commons first.jpg', index: 1 },
    })))
    mockWikiResponse(wikiPageData({
      thumbnail: { source: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Lead_bird.jpg/320px-Lead_bird.jpg' },
    }))

    const result = await getWikimediaGallery('Lead Bird Gallery14')
    expect(result).toHaveLength(2)
    expect(result[0].url).toContain('Lead_bird.jpg')
    expect(result[0].descriptionUrl).toBe('https://commons.wikimedia.org/wiki/File:Lead_bird.jpg')
    expect(result[1].title).toBe('File:Commons first.jpg')
  })

  it('absorbs the Commons copy of the lead image instead of duplicating it', async () => {
    mockFetch.mockImplementationOnce(() => Promise.resolve(commonsResponse({
      '1': { title: 'File:Other bird.jpg', index: 1 },
      '2': {
        title: 'File:Lead bird.jpg',
        index: 2,
        description: 'A male lead bird',
        descriptionurl: 'https://commons.wikimedia.org/wiki/File:Lead_bird.jpg',
      },
    })))
    mockWikiResponse(wikiPageData({
      thumbnail: { source: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Lead_bird.jpg/320px-Lead_bird.jpg' },
    }))

    const result = await getWikimediaGallery('Dedupe Bird Gallery15')
    expect(result).toHaveLength(2)
    expect(result[0].url).toContain('Lead_bird.jpg')
    expect(result[0].plumage).toBe('male')
    expect(result[1].title).toBe('File:Other bird.jpg')
  })
})
