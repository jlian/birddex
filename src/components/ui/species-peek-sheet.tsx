import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowSquareOut, CaretLeft, CaretRight, CheckCircle } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { RarityMark, RARITY_SENTENCES } from '@/components/ui/rarity-mark'
import { BirdLogo } from '@/components/ui/bird-logo'
import { birdObjectPosition } from '@/components/ui/wiki-bird-thumbnail'
import { getDisplayName } from '@/lib/utils'
import { getWikimediaGallery, getWikimediaSummary, type GalleryImage } from '@/lib/wikimedia'
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
  images: GalleryImage[]
  links: SpeciesLinks
}

const EMPTY: SpeciesDetails = { images: [], links: {} }

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
  const [heroIndices, setHeroIndices] = useState<Record<string, number>>({})
  const [expanded, setExpanded] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [heroPortrait, setHeroPortrait] = useState(false)
  const extractRef = useRef<HTMLParagraphElement | null>(null)
  const touchStartX = useRef<number | null>(null)

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
        const [images, wikiTitle, ebird, birdlife] = await Promise.all([
          getWikimediaGallery(name),
          getWikiTitleForSpecies(name),
          getEbirdSpeciesUrl(name),
          getBirdlifeFactsheetUrl(name),
        ])
        const summary = await getWikimediaSummary(name, { wikiTitle })
        if (cancelled) return
        setDetails(prev => prev[name] ? prev : {
          ...prev,
          [name]: {
            extract: summary?.extract,
            images: sortByPlumage(images, candidate.plumage),
            links: {
              wikipedia: summary?.pageUrl
                ?? (wikiTitle ? `https://en.wikipedia.org/wiki/${encodeURIComponent(wikiTitle)}` : undefined),
              ebird,
              birdlife,
            },
          },
        })
      }
    })()

    return () => { cancelled = true }
  }, [open, species, index, candidates])

  const go = useCallback((delta: number) => {
    setIndex(i => Math.min(Math.max(i + delta, 0), candidates.length - 1))
  }, [candidates.length])

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return
    const dx = e.changedTouches[0].clientX - touchStartX.current
    touchStartX.current = null
    if (Math.abs(dx) < 40) return
    go(dx < 0 ? 1 : -1)
  }

  const detail = current ? details[current.species] ?? EMPTY : EMPTY

  // "More" only earns its place when the clamp is actually hiding something.
  // Layout effect so the button never flashes in for a short extract.
  useLayoutEffect(() => {
    const el = extractRef.current
    if (!el || expanded) return
    setTruncated(el.scrollHeight > el.clientHeight + 1)
  }, [detail.extract, expanded, index])

  if (!current) return null

  const heroIndex = Math.min(heroIndices[current.species] ?? 0, Math.max(detail.images.length - 1, 0))
  const hero = detail.images[heroIndex]
  const displayName = getDisplayName(current.species)
  const scientificMatch = current.species.match(/\(([^)]+)\)/)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[85vh] max-w-2xl gap-0 rounded-t-xl border-x p-0"
        onTouchStart={(e) => { touchStartX.current = e.touches[0].clientX }}
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
            {detail.images.length > 1 && (
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                {detail.images.slice(0, 4).map((image, i) => (
                  <button
                    key={image.url}
                    type="button"
                    onClick={() => setHeroIndices(prev => ({ ...prev, [current.species]: i }))}
                    className={`min-h-0 w-full flex-1 overflow-hidden rounded-md border-2 ${
                      i === heroIndex ? 'border-primary' : 'border-transparent'
                    }`}
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
              <RarityMark state={current.rarity} />
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
            {hero?.descriptionUrl && (
              <>
                Photo{hero.plumage ? ` (${hero.plumage})` : ''} on{' '}
                <a href={hero.descriptionUrl} target="_blank" rel="noopener noreferrer" className="underline">
                  Wikimedia Commons
                </a>
                {'. '}
              </>
            )}
            Text from Wikipedia under CC BY-SA 4.0.
          </p>
        </div>

        <div className="flex items-center gap-2 border-t p-4">
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
