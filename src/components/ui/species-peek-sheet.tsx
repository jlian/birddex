import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowSquareOut, CaretLeft, CaretRight, CheckCircle } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { RarityMark, RARITY_SENTENCES } from '@/components/ui/rarity-mark'
import { BirdLogo } from '@/components/ui/bird-logo'
import { birdObjectPosition } from '@/components/ui/wiki-bird-thumbnail'
import { getDisplayName } from '@/lib/utils'
import {
  fetchImageCredit,
  getWikimediaGallery,
  getWikimediaSummary,
  type GalleryImage,
  type ImageCredit,
} from '@/lib/wikimedia'
import { getEbirdSpeciesUrl, getBirdlifeFactsheetUrl, getWikiTitleForSpecies } from '@/lib/taxonomy-order'
import { formatConfidence } from '@/lib/bird-id-local-adapter'
import type { RarityState } from '@/lib/rarity'

/** One candidate as the peek sheet needs it, with its rarity already resolved. */
export interface PeekCandidate {
  species: string
  confidence: number
  plumage?: string
  rarity: RarityState
}

interface SpeciesLinks {
  wikipedia?: string
  ebird?: string
  birdlife?: string
}

interface SpeciesDetails {
  extract?: string
  /** Unsorted, as Commons returned them. Plumage ordering is applied per candidate
      at render, because two photos of the same species can carry different plumage. */
  images: GalleryImage[]
  links: SpeciesLinks
}

const EMPTY: SpeciesDetails = { images: [], links: {} }

/**
 * Whether an entry is worth keeping rather than refetching. The extract is the
 * part that fails on its own: the gallery and the links come from the bundled
 * taxonomy, so they survive a Wikipedia outage while the extract does not.
 */
function isComplete(detail: SpeciesDetails | undefined): boolean {
  return detail?.extract !== undefined
}

function confidenceClass(confidence: number): string {
  const pct = Math.round(confidence * 100)
  if (pct >= 80) return 'text-green-600 dark:text-green-400'
  if (pct >= 50) return 'text-amber-600 dark:text-amber-400'
  return 'text-red-500 dark:text-red-400'
}

/**
 * "Wait, hold on, is this the bird?" - a read-only look at a candidate without
 * leaving the identification.
 *
 * Pages across the whole candidate list, so comparing the top pick against the
 * runner-up is one gesture rather than two dismissals. The user's own photo is
 * pinned in the header because the comparison is the entire point of being here.
 *
 * Nothing here changes the record until Confirm is pressed, so a curious page
 * through the candidates cannot quietly refile the photo.
 */
export function SpeciesPeekSheet({
  candidates,
  startIndex,
  userPhotoUrl,
  open,
  onOpenChange,
  onConfirm,
}: {
  candidates: PeekCandidate[]
  startIndex: number
  userPhotoUrl?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (candidate: PeekCandidate) => void
}) {
  const [index, setIndex] = useState(startIndex)
  const [details, setDetails] = useState<Record<string, SpeciesDetails>>({})
  // Read inside the loader without making it a dependency, which would restart
  // the fetch on every entry it stores.
  const detailsRef = useRef(details)
  detailsRef.current = details
  const [heroIndices, setHeroIndices] = useState<Record<string, number>>({})
  const [expanded, setExpanded] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [heroPortrait, setHeroPortrait] = useState(false)
  const [credit, setCredit] = useState<ImageCredit | undefined>(undefined)
  const extractRef = useRef<HTMLParagraphElement | null>(null)
  const touchStart = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => { if (open) setIndex(startIndex) }, [open, startIndex])
  useEffect(() => { setExpanded(false); setHeroPortrait(false) }, [index])

  const current = candidates[Math.min(Math.max(index, 0), candidates.length - 1)]
  const species = current?.species

  // Loads the visible candidate, then its neighbours, so a paged-to card is
  // already populated. getWikimediaGallery and getWikimediaSummary both cache.
  useEffect(() => {
    if (!open || !species) return
    let cancelled = false
    const wanted = [index, index - 1, index + 1]
      .filter(i => i >= 0 && i < candidates.length)
      .map(i => candidates[i])

    void (async () => {
      for (const candidate of wanted) {
        if (cancelled) return
        const name = candidate.species
        // Only a complete entry is worth keeping. A previous attempt that failed
        // left one behind with no extract, and skipping on mere presence made
        // that first failure permanent for the life of the flow.
        if (isComplete(detailsRef.current[name])) continue
        const [images, wikiTitle, ebird, birdlife] = await Promise.all([
          getWikimediaGallery(name),
          getWikiTitleForSpecies(name),
          getEbirdSpeciesUrl(name),
          getBirdlifeFactsheetUrl(name),
        ])
        const summary = await getWikimediaSummary(name, { wikiTitle })
        if (cancelled) return
        const next: SpeciesDetails = {
          extract: summary?.extract,
          images,
          links: {
            wikipedia: summary?.pageUrl
              ?? (wikiTitle ? `https://en.wikipedia.org/wiki/${encodeURIComponent(wikiTitle)}` : undefined),
            ebird,
            birdlife,
          },
        }
        // A retry that came back empty must not blank an entry that already has
        // something, so the better of the two wins.
        setDetails(prev => isComplete(prev[name]) ? prev : { ...prev, [name]: next })
      }
    })()

    return () => { cancelled = true }
  }, [open, species, index, candidates])

  const go = useCallback((delta: number) => {
    setIndex(i => Math.min(Math.max(i + delta, 0), candidates.length - 1))
  }, [candidates.length])

  // A page turn has to out-argue the sheet's own vertical scroll, so horizontal
  // travel must clear the threshold AND beat the vertical travel. Otherwise a
  // diagonal flick while reading the extract silently swaps the bird.
  const handleTouchEnd = (e: React.TouchEvent) => {
    const start = touchStart.current
    touchStart.current = null
    if (!start) return
    const dx = e.changedTouches[0].clientX - start.x
    const dy = e.changedTouches[0].clientY - start.y
    if (Math.abs(dx) < 40 || Math.abs(dx) <= Math.abs(dy)) return
    go(dx < 0 ? 1 : -1)
  }

  const detail = current ? details[current.species] ?? EMPTY : EMPTY

  // Sorted here rather than at fetch time: the cache is per species, but the
  // plumage that should lead belongs to the candidate being looked at.
  const images = useMemo(
    () => sortByPlumage(detail.images, current?.plumage),
    [detail.images, current?.plumage],
  )

  // "More" only earns its place when the clamp is actually hiding something.
  // Layout effect so the button never flashes in for a short extract.
  //
  // Also remeasured on resize: wrapping changes with the sheet's width, so a
  // rotation could otherwise leave the flag stale and clamp text with no way to
  // expand it, or offer "More" when nothing is hidden.
  useLayoutEffect(() => {
    const el = extractRef.current
    if (!el || expanded) return
    const measure = () => setTruncated(el.scrollHeight > el.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [detail.extract, expanded, index])

  // Keyed by plumage as well, because the same species under a different plumage
  // is a differently ordered strip and index 2 is then a different photo.
  const heroKey = current ? `${current.species}|${current.plumage ?? ''}` : ''
  const heroIndex = Math.min(heroIndices[heroKey] ?? 0, Math.max(images.length - 1, 0))
  const hero = images[heroIndex]

  // Attribution names the creator and licence, the same two lines as the species
  // detail page, rather than a bare link to the file page.
  const heroUrl = hero?.url
  useEffect(() => {
    let active = true
    setCredit(undefined)
    void fetchImageCredit(heroUrl).then(found => { if (active) setCredit(found) })
    return () => { active = false }
  }, [heroUrl])

  if (!current) return null

  const displayName = getDisplayName(current.species)
  const scientificMatch = current.species.match(/\(([^)]+)\)/)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[85vh] max-w-2xl gap-0 rounded-t-xl border-x p-0"
        onTouchStart={(e) => { touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY } }}
        onTouchEnd={handleTouchEnd}
      >
        <SheetTitle className="sr-only">{displayName}</SheetTitle>
        <SheetDescription className="sr-only">
          Reference photos, description and external links for {displayName}.
        </SheetDescription>

        {/* Your photo stays pinned: the comparison is why this sheet exists. */}
        <div className="flex items-center gap-3 border-b px-4 py-2.5">
          {userPhotoUrl && (
            <img src={userPhotoUrl} alt="Your photo" className="size-11 rounded-lg object-cover" />
          )}
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">Your photo</p>
            {candidates.length > 1 && (
              <p className="text-[11px] text-muted-foreground/70">
                Candidate {index + 1} of {candidates.length}
              </p>
            )}
          </div>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="font-serif text-xl font-semibold text-foreground">{displayName}</h3>
              {scientificMatch && (
                <p className="text-sm italic text-muted-foreground">{scientificMatch[1]}</p>
              )}
            </div>
            <span className={`font-serif text-3xl font-semibold leading-none tabular-nums ${confidenceClass(current.confidence)}`}>
              {formatConfidence(current.confidence)}
            </span>
          </div>

          {/* A square hero with the rest of the gallery stacked down its right edge.
              Deliberately not a second horizontal pager: the sheet itself already
              pages between birds, and vertical keeps the alternates one click away
              without spending a row of height.

              The hero takes a fixed 80% share so its width never depends on the
              strip's. The strip is then stretched to the hero's height by the row,
              and its four children split that height with flex-1, so the columns
              line up exactly rather than approximately. */}
          <div className="mx-auto flex w-full max-w-[20rem] gap-2">
            <div className="relative aspect-square w-[calc(80%-1.6px)] shrink-0 overflow-hidden rounded-xl bg-muted">
              {hero ? (
                <img
                  src={hero.url}
                  alt={`${displayName} reference`}
                  onLoad={e => setHeroPortrait(e.currentTarget.naturalHeight > e.currentTarget.naturalWidth)}
                  style={{ objectPosition: birdObjectPosition(heroPortrait) }}
                  className="absolute inset-0 size-full object-cover"
                />
              ) : (
                <div className="flex size-full items-center justify-center">
                  <BirdLogo size={40} className="text-muted-foreground/40" />
                </div>
              )}
            </div>
            {images.length > 1 && (
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                {images.slice(0, 4).map((image, i) => (
                  <button
                    key={image.url}
                    type="button"
                    onClick={() => setHeroIndices(prev => ({ ...prev, [heroKey]: i }))}
                    className={`min-h-0 w-full flex-1 overflow-hidden rounded-md border-2 ${
                      i === heroIndex ? 'border-primary' : 'border-transparent'
                    }`}
                    // Border colour is the only visual cue for which photo is the hero,
                    // and the one the footer credits, so it has to be spoken too.
                    aria-pressed={i === heroIndex}
                    aria-label={`Reference photo ${i + 1}`}
                  >
                    <img src={image.url} alt="" className="size-full object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>

          {current.rarity !== 'none' && (
            <p className="flex items-baseline gap-2 text-sm text-muted-foreground">
              {/* The sentence is right there in the text, so the glyph is decorative
                  here and would otherwise be read out a second time. */}
              <RarityMark state={current.rarity} decorative />
              {RARITY_SENTENCES[current.rarity]}
            </p>
          )}

          {detail.extract && (
            <div className="space-y-1">
              <p
                ref={extractRef}
                className={`text-sm leading-relaxed text-foreground/80 ${expanded ? '' : 'line-clamp-4'}`}
              >
                {detail.extract}
              </p>
              {(truncated || expanded) && (
                <button
                  type="button"
                  className="text-xs font-medium text-primary"
                  onClick={() => setExpanded(v => !v)}
                >
                  {expanded ? 'Less' : 'More'}
                </button>
              )}
            </div>
          )}

          {/* A missing link is omitted rather than disabled: not every species has a
              BirdLife factsheet, and a dead control invites a click that does nothing. */}
          <div className="flex flex-wrap gap-2">
            {detail.links.wikipedia && <LinkChip href={detail.links.wikipedia} label="Wikipedia" />}
            {detail.links.ebird && <LinkChip href={detail.links.ebird} label="eBird" />}
            {detail.links.birdlife && <LinkChip href={detail.links.birdlife} label="BirdLife" />}
          </div>

          {/* One line at the foot of the page rather than a caption under the photo:
              attribution has to be present, but it does not have to sit in the middle
              of the comparison. The Commons file page is what CC 4.0 3(a)(2) accepts
              in place of an inline creator/license line. */}
          <p className="text-[10px] text-muted-foreground">
            {(credit?.pageUrl ?? hero?.descriptionUrl) && (
              <>
                Photo{hero?.plumage ? ` (${hero.plumage})` : ''}{' '}
                <a
                  href={credit?.pageUrl ?? hero?.descriptionUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  {[credit?.artist, credit?.license].filter(Boolean).join(' / ') || 'on Wikimedia Commons'}
                </a>
                {'. '}
              </>
            )}
            Text from Wikipedia under CC BY-SA 4.0.
          </p>
        </div>

        {/* Page dots: how many birds are back here, and where you are among them.
            The counter in the header gives the same fact in words, so each dot only
            has to name its own candidate and say whether it is the current one.
            Not a tablist: there are no tabpanels, the pages are the sheet itself.

            The dot is 6px but the button is 24px: a 6px touch target is unusable
            with a thumb, and worse with a motor impairment. The padding does the
            work so the row still reads as dots. */}
        {candidates.length > 1 && (
          <div className="flex justify-center border-t pt-1.5" aria-label="Candidates">
            {candidates.map((candidate, i) => (
              <button
                key={candidate.species}
                type="button"
                aria-current={i === index ? 'true' : undefined}
                aria-label={`Candidate ${i + 1} of ${candidates.length}, ${getDisplayName(candidate.species)}`}
                onClick={() => setIndex(i)}
                className="flex size-6 items-center justify-center"
              >
                <span
                  className={`size-1.5 rounded-full transition-colors ${
                    i === index ? 'bg-primary' : 'bg-muted-foreground/30'
                  }`}
                />
              </button>
            ))}
          </div>
        )}

        <div className={`flex items-center gap-2 p-4 ${candidates.length > 1 ? 'pt-1.5' : 'border-t'}`}>
          {candidates.length > 1 && (
            <Button
              variant="outline"
              size="icon"
              onClick={() => go(-1)}
              disabled={index === 0}
              aria-label="Previous candidate"
            >
              <CaretLeft size={16} />
            </Button>
          )}
          {/* The wizard's confirm action, brought down to where the decision is
              actually made. Picking a candidate and then hunting for the Confirm
              button up on the card is two steps for one thought. */}
          <Button className="flex-1" onClick={() => { onConfirm(current); onOpenChange(false) }}>
            <CheckCircle size={16} className="mr-1" weight="bold" />
            Confirm
          </Button>
          {candidates.length > 1 && (
            <Button
              variant="outline"
              size="icon"
              onClick={() => go(1)}
              disabled={index === candidates.length - 1}
              aria-label="Next candidate"
            >
              <CaretRight size={16} />
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function LinkChip({ href, label }: { href: string; label: string }) {
  return (
    <Button variant="outline" size="sm" asChild>
      <a href={href} target="_blank" rel="noopener noreferrer">
        <ArrowSquareOut size={14} className="mr-1.5" />
        {label}
      </a>
    </Button>
  )
}

/** Promote images tagged with the plumage the identification detected. */
function sortByPlumage(images: GalleryImage[], plumage?: string): GalleryImage[] {
  if (!plumage) return images
  const detected = plumage.toLowerCase().split(/,\s*/)
  const matches = (image: GalleryImage) => {
    const tags = image.plumage?.toLowerCase().split(/,\s*/) ?? []
    return detected.some(d => tags.includes(d))
  }
  return [...images.filter(matches), ...images.filter(i => !matches(i))]
}
