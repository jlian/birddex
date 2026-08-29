/**
 * Fetch bird images and summaries from the Wikipedia REST API.
 * Uses species display names for lookup keys against the Wikipedia REST API.
 * No API key required.
 */
import { getDisplayName } from './utils'
import { fetchWithLocalAuthRetry } from './local-auth-fetch'

/**
 * Wikimedia's User-Agent policy wants a client name and a contact route, and
 * blocks non-descriptive agents. Browsers will not let JS set User-Agent, so
 * requests carry it as Api-User-Agent instead, which the policy provides for.
 */
export const WIKIMEDIA_USER_AGENT = 'WingDex/1.0 (https://wingdex.app)'

export interface WikiSummary {
  title: string
  extract: string
  imageUrl?: string
  pageUrl: string
}

/** Raw shape returned by the Wikipedia REST page/summary endpoint. */
type RestSummary = {
  title?: string
  extract?: string
  thumbnail?: { source: string }
  originalimage?: { source: string }
  content_urls?: { desktop?: { page?: string } }
}

type FetchResult =
  | { kind: 'hit'; data: RestSummary }
  | { kind: 'miss' }
  | { kind: 'error' }

type WikiLookupOptions = {
  wikiTitle?: string
}

/** Shared cache for the raw REST API response -- populated once, used by both image and summary lookups. */
const restCache = new Map<string, RestSummary | null>()
const restInFlight = new Map<string, Promise<RestSummary | undefined>>()

/** Cache for wiki-title API lookups. */
const wikiTitleCache = new Map<string, {
  wikiTitle: string | null
  common: string | null
  scientific: string | null
  thumbnailUrl?: string | null
}>()

// -- localStorage persistence for restCache ---------------------------
const STORAGE_KEY = 'wiki-rest-cache'
const MAX_CACHED_ENTRIES = 200

/** Hydrate restCache from localStorage on module load. */
function hydrateRestCache(): void {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const entries = JSON.parse(raw) as Array<[string, RestSummary | null]>
    for (const [key, value] of entries) restCache.set(key, value)
  } catch {
    // Corrupt or missing -- start fresh
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null

/** Debounce-write restCache to localStorage (100ms). */
function schedulePersist(): void {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    try {
      // Keep only the most recent MAX_CACHED_ENTRIES (by insertion order)
      const entries = Array.from(restCache.entries())
      const trimmed = entries.length > MAX_CACHED_ENTRIES
        ? entries.slice(entries.length - MAX_CACHED_ENTRIES)
        : entries
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
    } catch {
      // Quota exceeded or unavailable -- silently skip
    }
  }, 100)
}

// Run hydration immediately on module load
if (typeof window !== 'undefined') hydrateRestCache()

/** Fetch a Wikipedia page summary via the REST API. */
async function fetchSummary(title: string): Promise<FetchResult> {
  try {
    const encoded = encodeURIComponent(title.replace(/ /g, '_'))
    const res = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`,
      { headers: { 'Api-User-Agent': WIKIMEDIA_USER_AGENT } }
    )
    if (!res.ok) return res.status === 404 ? { kind: 'miss' } : { kind: 'error' }
    const data = (await res.json()) as RestSummary
    if (!data.extract) return { kind: 'miss' }
    return { kind: 'hit', data }
  } catch {
    return { kind: 'error' }
  }
}

/** Extract thumbnail image URL (for list views). */
function extractThumbnailUrl(data: RestSummary): string | undefined {
  return data.thumbnail?.source ?? data.originalimage?.source
}

/** Extract full-resolution image URL (for detail views). */
function extractFullImageUrl(data: RestSummary): string | undefined {
  return data.originalimage?.source ?? data.thumbnail?.source
}

/**
 * Width Wikimedia renders hero thumbnails at. Only the widths in `$wgThumbnailSteps` are
 * served; direct requests for any other width are rejected.
 * https://www.mediawiki.org/wiki/Common_thumbnail_sizes
 */
const HERO_THUMBNAIL_STEP = 960

/**
 * Derive a hero-sized image URL from a dex thumbnail URL.
 *
 * The rendered width lives in the last path segment (`.../330px-Foo.jpg`, or
 * `.../lossy-page1-330px-Foo.tif.jpg` for multi-page sources), so the hero URL is known
 * synchronously with no Wikipedia round trip. Wikimedia upscales past the original width
 * rather than failing, so every step resolves for every file.
 *
 * Returns undefined for originals served without a `/thumb/` segment, which have no
 * rendered variants and are already full size.
 */
export function getHeroImageUrl(thumbnailUrl: string | undefined): string | undefined {
  if (!thumbnailUrl?.includes('/thumb/')) return undefined
  const slash = thumbnailUrl.lastIndexOf('/')
  const filename = thumbnailUrl.slice(slash + 1)
  if (!/\d+px-/.test(filename)) return undefined
  return thumbnailUrl.slice(0, slash + 1) + filename.replace(/\d+px-/, `${HERO_THUMBNAIL_STEP}px-`)
}

/**
 * Derive the file page URL from any upload.wikimedia.org image URL.
 *
 * The file name is the segment before the rendered width for thumbnails
 * (`.../thumb/a/ab/Foo.jpg/330px-Foo.jpg`) and the last segment for originals
 * (`.../a/ab/Foo.jpg`). Most Commons photos are CC BY or CC BY-SA, and the file
 * page is where their credit and license notice live.
 *
 * A few files are hosted on English Wikipedia rather than Commons, so the host
 * comes from the URL rather than being assumed.
 */
export function getFilePageUrl(imageUrl: string | undefined): string | undefined {
  if (!imageUrl) return undefined
  const segments = imageUrl.split('/').filter(Boolean)
  const name = imageUrl.includes('/thumb/') ? segments.at(-2) : segments.at(-1)
  if (!name || !name.includes('.')) return undefined
  const host = imageUrl.includes('/wikipedia/commons/')
    ? 'https://commons.wikimedia.org'
    : imageUrl.includes('/wikipedia/en/')
      ? 'https://en.wikipedia.org'
      : undefined
  return host ? `${host}/wiki/File:${name}` : undefined
}

export type ImageCredit = { artist?: string; license?: string; pageUrl: string }

const creditCache = new Map<string, ImageCredit>()

/**
 * Fetch the creator and license for a displayed image, keyed by its file page.
 * Cheap enough to call per species view: one request, cached for the session.
 */
export async function fetchImageCredit(imageUrl: string | undefined): Promise<ImageCredit | undefined> {
  const pageUrl = getFilePageUrl(imageUrl)
  if (!pageUrl) return undefined
  const cached = creditCache.get(pageUrl)
  if (cached) return cached

  const [origin, file] = pageUrl.split('/wiki/')
  try {
    const res = await fetch(
      // `file` came out of a URL path, so it is already percent-encoded. Encoding it
      // again turns %28 into %2528 and the API rejects the title.
      `${origin}/w/api.php?action=query&titles=${file}` +
        '&prop=imageinfo&iiprop=extmetadata&format=json&origin=*',
      { headers: { 'Api-User-Agent': WIKIMEDIA_USER_AGENT } },
    )
    if (!res.ok) return undefined
    const data = (await res.json()) as {
      query?: { pages?: Record<string, { imageinfo?: Array<{ extmetadata?: {
        Artist?: { value?: string }
        LicenseShortName?: { value?: string }
      } }> }> }
    }
    const meta = Object.values(data.query?.pages ?? {})[0]?.imageinfo?.[0]?.extmetadata
    const credit: ImageCredit = {
      pageUrl,
      artist: stripHtml(meta?.Artist?.value) || undefined,
      license: stripHtml(meta?.LicenseShortName?.value) || undefined,
    }
    creditCache.set(pageUrl, credit)
    return credit
  } catch {
    return undefined
  }
}

/** Extract the common name from a species string like "Northern Cardinal (Cardinalis cardinalis)" */
function getCommonName(speciesName: string): string {
  return getDisplayName(speciesName)
}

function getLookupTitles(speciesName: string, preferredTitle?: string): string[] {
  const common = getCommonName(speciesName)
  const cacheKey = common.toLowerCase()
  const cached = wikiTitleCache.get(cacheKey)

  const candidates = [preferredTitle]
  if (cached) {
    candidates.push(cached.wikiTitle ?? undefined, cached.common ?? undefined, cached.scientific ?? undefined)
  }
  candidates.push(common)

  const unique: string[] = []
  const seen = new Set<string>()
  for (const title of candidates) {
    if (!title?.trim()) continue
    const key = title.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(title)
  }

  return unique
}

/** Fetch and cache taxonomy match from the server wiki-title API. */
async function ensureWikiTitleCached(speciesName: string): Promise<void> {
  const common = getCommonName(speciesName)
  const cacheKey = common.toLowerCase()
  if (wikiTitleCache.has(cacheKey)) return

  try {
    const res = await fetchWithLocalAuthRetry(`/api/species/wiki-title?name=${encodeURIComponent(speciesName)}`, { credentials: 'include' })
    if (res.ok) {
      const data = await res.json() as { wikiTitle: string | null; common: string | null; scientific: string | null }
      wikiTitleCache.set(cacheKey, data)
    } else {
      // Cache negative result to avoid refetching on every render
      wikiTitleCache.set(cacheKey, { wikiTitle: null, common: null, scientific: null })
    }
  } catch {
    // Cache negative result to avoid repeated fetches during transient failures
    wikiTitleCache.set(cacheKey, { wikiTitle: null, common: null, scientific: null })
  }
}

/**
 * Resolve the raw REST summary for a species, fetching at most once.
 * Both getWikimediaImage and getWikimediaSummary go through this so the
 * Wikipedia API is only called once per species.
 */
async function resolveRestSummary(speciesName: string, options?: WikiLookupOptions): Promise<RestSummary | undefined> {
  const common = getCommonName(speciesName)
  const cacheKey = common.toLowerCase()

  if (!options?.wikiTitle) {
    await ensureWikiTitleCached(speciesName)
  }

  if (restCache.has(cacheKey)) {
    return restCache.get(cacheKey) ?? undefined
  }

  const inFlight = restInFlight.get(cacheKey)
  if (inFlight) return inFlight

  const lookupPromise = (async (): Promise<RestSummary | undefined> => {
    const titles = getLookupTitles(speciesName, options?.wikiTitle)
    let sawError = false
    let bestSummary: RestSummary | undefined

    for (const title of titles) {
      const result = await fetchSummary(title)
      if (result.kind === 'hit') {
        if (!bestSummary) bestSummary = result.data
        if (extractThumbnailUrl(result.data)) {
          // Merge first hit's text/page with this hit's image
          const merged = bestSummary === result.data
            ? result.data
            : { ...bestSummary, thumbnail: result.data.thumbnail, originalimage: result.data.originalimage }
          restCache.set(cacheKey, merged)
          schedulePersist()
          return merged
        }
        continue
      }
      if (result.kind === 'error') {
        sawError = true
      }
    }

    if (bestSummary) {
      restCache.set(cacheKey, bestSummary)
      schedulePersist()
      return bestSummary
    }

    if (!sawError) {
      restCache.set(cacheKey, null)
      schedulePersist()
    }
    return undefined
  })()

  restInFlight.set(cacheKey, lookupPromise)
  try {
    return await lookupPromise
  } finally {
    restInFlight.delete(cacheKey)
  }
}

/**
 * Get a Wikimedia Commons thumbnail URL for a bird species.
 */
export async function getWikimediaImage(
  speciesName: string,
): Promise<string | undefined> {
  const data = await resolveRestSummary(speciesName)
  return data ? extractThumbnailUrl(data) : undefined
}

/**
 * Get Wikipedia summary text + image for a bird species.
 */
export async function getWikimediaSummary(
  speciesName: string,
  options?: WikiLookupOptions,
): Promise<WikiSummary | undefined> {
  const data = await resolveRestSummary(speciesName, options)
  if (!data?.extract) return undefined

  const common = getCommonName(speciesName)
  return {
    title: data.title || common,
    extract: data.extract,
    imageUrl: extractFullImageUrl(data),
    pageUrl: data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent((data.title || common).replace(/ /g, '_'))}`,
  }
}

// -- Gallery: multiple reference images from Wikimedia Commons -----------

/** A gallery image with URL, optional caption, and filename for plumage parsing. */
export type GalleryImage = {
  url: string
  caption?: string
  title?: string
  /** Parsed plumage tag from caption/filename (e.g. "male", "female", "juvenile") */
  plumage?: string
  /** Commons file page, which carries the full credit and license notice. */
  descriptionUrl?: string
}

/** Patterns in filenames that indicate non-bird-photo imagery. */
const GALLERY_EXCLUDE_RE =
  /\.(svg|gif)$|Status_|IUCN|range_map|distribution|map_of|map\.png|stamp_of|MHNT|MWNH|_egg|_nest|museum|specimen|skeleton|taxiderm|wikimedia-logo|commons-logo|wikidata-logo|cscr-|question_book|edit-clear|crystal_clear|ambox|folder_hexagonal/i

const galleryCache = new Map<string, GalleryImage[]>()
const galleryInFlight = new Map<string, Promise<GalleryImage[]>>()

function trimGalleryCache(): void {
  if (galleryCache.size <= MAX_CACHED_ENTRIES) return
  const keys = Array.from(galleryCache.keys())
  for (let i = 0; i < keys.length - MAX_CACHED_ENTRIES; i++) galleryCache.delete(keys[i])
}

/**
 * Get reference images for a species from Wikimedia Commons.
 * Searches Commons for photos matching the species name, scored by quality assessment.
 * Returns up to `limit` images with URLs, captions, and parsed plumage tags.
 */
export async function getWikimediaGallery(
  speciesName: string,
  options?: WikiLookupOptions & { limit?: number },
): Promise<GalleryImage[]> {
  const limit = options?.limit ?? 6

  const common = getCommonName(speciesName)
  const cacheKey = common.toLowerCase()
  const cached = galleryCache.get(cacheKey)
  if (cached) return cached.slice(0, limit)

  const existing = galleryInFlight.get(cacheKey)
  if (existing) return existing.then(imgs => imgs.slice(0, limit))

  const promise = (async (): Promise<GalleryImage[]> => {
    const [images, leadUrl] = await Promise.all([
      fetchCommonsGallery(common, limit),
      getWikimediaImage(speciesName),
    ])
    const withLead = promoteLeadImage(leadUrl, images)
    galleryCache.set(cacheKey, withLead)
    trimGalleryCache()
    return withLead
  })()

  galleryInFlight.set(cacheKey, promise)
  try { return await promise } finally { galleryInFlight.delete(cacheKey) }
}

/** Commons file name from an upload URL or a file page URL, normalised for comparison. */
function commonsFileKey(url: string | undefined): string | undefined {
  if (!url) return undefined
  const decoded = decodeURIComponent(url)
  const filePage = decoded.split('/wiki/File:')[1]
  const name = filePage
    ?? (decoded.includes('/thumb/')
      ? decoded.split('/').filter(Boolean).at(-2)
      : decoded.split('/').filter(Boolean).at(-1))
  return name?.replace(/_/g, ' ').toLowerCase()
}

/**
 * Put the Wikipedia lead image first, absorbing the Commons copy of the same file when the
 * search already returned it. Commons relevance ordering routinely opens on a nest or a
 * female, while the lead image is the shot the species page already shows.
 */
function promoteLeadImage(leadUrl: string | undefined, images: GalleryImage[]): GalleryImage[] {
  const leadKey = commonsFileKey(leadUrl)
  if (!leadUrl || !leadKey) return images
  const duplicate = images.find(image => commonsFileKey(image.descriptionUrl) === leadKey)
  const rest = images.filter(image => commonsFileKey(image.descriptionUrl) !== leadKey)
  return [
    {
      url: leadUrl,
      caption: duplicate?.caption,
      title: duplicate?.title,
      plumage: duplicate?.plumage,
      descriptionUrl: duplicate?.descriptionUrl ?? getFilePageUrl(leadUrl),
    },
    ...rest,
  ]
}

/** Parse plumage from caption + filename text. */
function parsePlumage(text: string): string | undefined {
  const lower = text.toLowerCase().replace(/[_-]/g, ' ')
  const tags: string[] = []
  if (/\bdrake\b/.test(lower)) tags.push('male')
  else if (/\bmale\b/.test(lower) && !/\bfemale\b/.test(lower)) tags.push('male')
  if (/\bfemale\b/.test(lower) || /\bhen\b/.test(lower)) tags.push('female')
  if (/\bjuvenile\b|\bchick\b|\bduckling\b|\bimmature\b/.test(lower)) tags.push('juvenile')
  return tags.length > 0 ? tags.join(', ') : undefined
}

/** Commons returns Artist and license fields as HTML fragments. */
function stripHtml(value?: string): string {
  return (value ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}

/** Search Wikimedia Commons for bird photos. Returns images with 500px thumbnails and descriptions. */
async function fetchCommonsGallery(speciesName: string, limit: number): Promise<GalleryImage[]> {
  try {
    const query = encodeURIComponent(`"${speciesName}"`)
    const res = await fetch(
      `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${query}&gsrnamespace=6&gsrlimit=${limit + 6}&prop=imageinfo&iiprop=extmetadata|url|mime&iiurlwidth=500&format=json&origin=*`,
      { headers: { 'Api-User-Agent': WIKIMEDIA_USER_AGENT } },
    )
    if (!res.ok) return []
    const data = (await res.json()) as {
      query?: { pages?: Record<string, {
        title?: string
        index?: number
        imageinfo?: Array<{
          thumburl?: string
          descriptionurl?: string
          mime?: string
          extmetadata?: {
            ImageDescription?: { value?: string }
            Assessments?: { value?: string }
          }
        }>
      }> }
    }
    if (!data.query?.pages) return []

    const pages = Object.values(data.query.pages)

    // Score each image: featured/quality images get priority, then search relevance
    const scored = pages.map(page => {
      const ii = page.imageinfo?.[0]
      const assessed = ii?.extmetadata?.Assessments?.value ?? ''
      const isFeatured = assessed.includes('featured')
      const isQuality = assessed.includes('quality')
      // Lower score = better. Featured first, then quality, then by search index.
      const qualityScore = isFeatured ? 0 : isQuality ? 1 : 2
      return { page, qualityScore, relevance: page.index ?? 999 }
    }).sort((a, b) => a.qualityScore - b.qualityScore || a.relevance - b.relevance)

    const results: GalleryImage[] = []
    for (const { page } of scored) {
      const title = page.title ?? ''
      if (GALLERY_EXCLUDE_RE.test(title)) continue
      const ii = page.imageinfo?.[0]
      // Commons bird photos are JPEG; the PNG and SVG hits are icons and diagrams.
      if (ii?.mime !== 'image/jpeg') continue
      const url = ii?.thumburl
      if (!url) continue
      const rawDesc = ii?.extmetadata?.ImageDescription?.value ?? ''
      const caption = rawDesc.replace(/<[^>]*>/g, '')
      // Skip non-photo content. Spanish terms too: Commons captions the nest and chick shots
      // that outrank the bird itself for several New World species.
      const subject = `${caption} ${title}`.replace(/[_-]/g, ' ')
      if (/\beggs?\b|\bnests?\b|\bskeleton\b|\bspecimen\b|\btaxiderm|\bnido\b|\bnidada\b|\bpolluelos?\b|\bhuevos?\b/i.test(subject)) continue
      const plumage = parsePlumage([caption, title].join(' '))
      results.push({
        url,
        caption: caption || undefined,
        title,
        plumage,
        descriptionUrl: ii?.descriptionurl,
      })
      if (results.length >= limit) break
    }
    return results
  } catch {
    return []
  }
}
