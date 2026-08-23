import { useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  MagnifyingGlass, CalendarBlank, ArrowLeft, ArrowSquareOut,
  ArrowUp, ArrowDown, Camera, Hash, TextAa, Leaf
} from '@phosphor-icons/react'
import { BirdLogo } from '@/components/ui/bird-logo'
import { birdObjectPosition } from '@/components/ui/wiki-bird-thumbnail'
import { useBirdSummary } from '@/hooks/use-bird-image'
import { getHeroImageUrl, fetchImageCredit, type ImageCredit } from '@/lib/wikimedia'
import { BirdRow } from '@/components/ui/bird-row'
import { ListRow } from '@/components/ui/list-row'
import { EmptyState } from '@/components/ui/empty-state'
import { getDisplayName, getScientificName } from '@/lib/utils'
import { fetchWithLocalAuthRetry } from '@/lib/local-auth-fetch'
import { formatStoredDate } from '@/lib/timezone'
import { buildSyncOrderLookup, getBirdlifeFactsheetUrl } from '@/lib/taxonomy-order'
import type { WingDexDataStore } from '@/hooks/use-wingdex-data'
import type { DexEntry, Observation } from '@/lib/types'

export type SortField = 'date' | 'count' | 'name' | 'family'
export type SortDir = 'asc' | 'desc'

const INITIAL_VISIBLE_ITEMS = 40
const LOAD_MORE_STEP = 40

function getEbirdUrl(commonName: string): string {
  const words = commonName.replace(/'/g, '').split(/[\s-]+/).filter(Boolean)
  if (words.length === 0) return 'https://ebird.org/species'

  let code = ''
  if (words.length === 1) {
    code = words[0].slice(0, 6)
  } else if (words.length === 2) {
    code = words[0].slice(0, 3) + words[1].slice(0, 3)
  } else if (words.length === 3) {
    code = words[0].slice(0, 2) + words[1].slice(0, 1) + words[2].slice(0, 3)
  } else {
    const charsFromLast = Math.max(1, 7 - words.length)
    const prefixChars = 6 - charsFromLast
    code = words.slice(0, words.length - 1).map(word => word[0]).join('').slice(0, prefixChars)
      + words[words.length - 1].slice(0, charsFromLast)
  }

  return `https://ebird.org/species/${code.toLowerCase()}`
}

async function fetchEbirdUrl(speciesName: string): Promise<string> {
  const response = await fetchWithLocalAuthRetry(`/api/species/ebird-code?name=${encodeURIComponent(speciesName)}`, {
    credentials: 'include',
  })
  if (!response.ok) {
    return getEbirdUrl(getDisplayName(speciesName))
  }

  const payload = await response.json() as { ebirdCode?: string | null }
  const code = payload.ebirdCode?.trim()
  if (!code) {
    return getEbirdUrl(getDisplayName(speciesName))
  }

  return `https://ebird.org/species/${code.toLowerCase()}`
}

interface WingDexPageProps {
  data: WingDexDataStore
  selectedSpecies: string | null
  onSelectSpecies: (name: string | null) => void
  onSelectOuting: (id: string) => void
  onAddPhotos?: () => void
  onAddPhotosIntent?: () => void
  searchQuery?: string
  onSearchQueryChange?: (value: string) => void
  sortField?: SortField
  sortDir?: SortDir
  onToggleSort?: (field: SortField) => void
}

export default function WingDexPage({
  data,
  selectedSpecies,
  onSelectSpecies,
  onSelectOuting,
  onAddPhotos,
  onAddPhotosIntent,
  searchQuery,
  onSearchQueryChange,
  sortField,
  sortDir,
  onToggleSort,
}: WingDexPageProps) {
  const { dex } = data
  const [internalSearchQuery, setInternalSearchQuery] = useState('')
  const [internalSortField, setInternalSortField] = useState<SortField>('date')
  const [internalSortDir, setInternalSortDir] = useState<SortDir>('desc')
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_ITEMS)
  const loadMoreRef = useRef<HTMLDivElement | null>(null)
  const visibleCountRef = useRef(visibleCount)
  const [familyOrderLookup, setFamilyOrderLookup] = useState<((name: string) => number) | null>(null)

  useEffect(() => {
    visibleCountRef.current = visibleCount
  }, [visibleCount])

  const effectiveSearchQuery = searchQuery ?? internalSearchQuery
  const effectiveSortField = sortField ?? internalSortField
  const effectiveSortDir = sortDir ?? internalSortDir

  // Load taxonomic order data lazily when family sort is selected
  useEffect(() => {
    if (effectiveSortField !== 'family') return
    const names = dex.map(e => e.speciesName)
    void buildSyncOrderLookup(names).then(lookup => {
      setFamilyOrderLookup(() => lookup)
    })
  }, [effectiveSortField, dex])

  const handleSearchQueryChange = (value: string) => {
    if (onSearchQueryChange) {
      onSearchQueryChange(value)
      return
    }
    setInternalSearchQuery(value)
  }

  const handleToggleSort = (field: SortField) => {
    if (onToggleSort) {
      onToggleSort(field)
      return
    }

    if (effectiveSortField === field) {
      setInternalSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'))
      return
    }

    setInternalSortField(field)
    setInternalSortDir(field === 'name' || field === 'family' ? 'asc' : 'desc')
  }

  const sortedList = useMemo(() => {
    return [...dex].sort((a, b) => {
      const dir = effectiveSortDir === 'asc' ? 1 : -1
      if (effectiveSortField === 'name') return dir * a.speciesName.localeCompare(b.speciesName)
      if (effectiveSortField === 'count') return dir * (a.totalCount - b.totalCount)
      if (effectiveSortField === 'family') {
        if (!familyOrderLookup) return a.speciesName.localeCompare(b.speciesName)
        const orderDiff = familyOrderLookup(a.speciesName) - familyOrderLookup(b.speciesName)
        if (orderDiff !== 0) return dir * orderDiff
        return a.speciesName.localeCompare(b.speciesName)
      }
      return dir * (new Date(a.firstSeenDate).getTime() - new Date(b.firstSeenDate).getTime())
    })
  }, [dex, effectiveSortDir, effectiveSortField, familyOrderLookup])

  const filteredList = useMemo(() => {
    const query = effectiveSearchQuery.toLowerCase()
    return sortedList.filter(entry => entry.speciesName.toLowerCase().includes(query))
  }, [sortedList, effectiveSearchQuery])

  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_ITEMS)
  }, [effectiveSearchQuery, effectiveSortField, effectiveSortDir])

  const visibleList = useMemo(
    () => filteredList.slice(0, visibleCount),
    [filteredList, visibleCount]
  )
  const hasMore = visibleCount < filteredList.length

  useEffect(() => {
    const node = loadMoreRef.current
    if (!node || !hasMore) return

    const maybeLoadMore = () => {
      if (node.getBoundingClientRect().top > window.innerHeight + 240) return
      if (visibleCountRef.current >= filteredList.length) return
      setVisibleCount((count) => {
        const nextCount = Math.min(count + LOAD_MORE_STEP, filteredList.length)
        visibleCountRef.current = nextCount
        return nextCount
      })
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        maybeLoadMore()
      },
      { rootMargin: '240px 0px' }
    )

    observer.observe(node)
    const rafId = requestAnimationFrame(maybeLoadMore)
    window.addEventListener('scroll', maybeLoadMore, { passive: true })
    window.addEventListener('resize', maybeLoadMore, { passive: true })

    return () => {
      observer.disconnect()
      cancelAnimationFrame(rafId)
      window.removeEventListener('scroll', maybeLoadMore)
      window.removeEventListener('resize', maybeLoadMore)
    }
  }, [filteredList.length, hasMore])

  if (dex.length === 0) {
    return (
      <EmptyState
        icon={BirdLogo}
        title="Your WingDex is empty"
        description="Upload photos and confirm species to start building your WingDex"
      >
        {onAddPhotos && (
          <Button
            size="lg"
            onClick={onAddPhotos}
            onPointerDown={onAddPhotosIntent}
            onMouseEnter={onAddPhotosIntent}
            onFocus={onAddPhotosIntent}
            onTouchStart={onAddPhotosIntent}
            className="bg-primary text-primary-foreground hover:bg-primary/90 shadow-md mt-2"
          >
            <Camera size={20} className="mr-2" weight="bold" />
            Upload & Identify
          </Button>
        )}
      </EmptyState>
    )
  }

  if (selectedSpecies) {
    const entry = dex.find(e => e.speciesName === selectedSpecies)
    if (!entry) {
      // Don't call onSelectSpecies during render -- return null gracefully
      return null
    }
    return (
      <SpeciesDetail
        entry={entry}
        data={data}
        onBack={() => window.history.back()}
        onSelectOuting={onSelectOuting}
      />
    )
  }

  const sortOptions: { key: SortField; icon: React.ElementType; label: string }[] = [
    { key: 'date', icon: CalendarBlank, label: 'Sort by date' },
    { key: 'count', icon: Hash, label: 'Sort by count' },
    { key: 'name', icon: TextAa, label: 'Sort A-Z' },
    { key: 'family', icon: Leaf, label: 'Sort by family' },
  ]

  return (
    <div className="px-4 sm:px-6 py-6 space-y-4 max-w-3xl mx-auto">
      <div className="space-y-1">
        <h2 className="font-serif text-2xl font-semibold text-foreground">
          WingDex
        </h2>
        <p className="text-sm text-muted-foreground">
          {dex.length} species observed
        </p>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <MagnifyingGlass
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            placeholder="Search species..."
            value={effectiveSearchQuery}
            onChange={e => handleSearchQueryChange(e.target.value)}
            className="pl-9 h-9 text-sm"
          />
        </div>
        <div className="flex items-center gap-1">
          <ToggleGroup
            type="single"
            value={effectiveSortField}
            variant="outline"
          >
            {sortOptions.map(opt => (
              <ToggleGroupItem
                key={opt.key}
                value={opt.key}
                aria-label={opt.label}
                title={opt.label}
                className="press-feel-light"
                onClick={() => handleToggleSort(opt.key)}
              >
                <opt.icon />
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => handleToggleSort(effectiveSortField)}
            aria-label={effectiveSortDir === 'asc' ? 'Sort descending' : 'Sort ascending'}
            title={effectiveSortDir === 'asc' ? 'Sort descending' : 'Sort ascending'}
          >
            {effectiveSortDir === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
          </Button>
        </div>
      </div>

      <div>
        {visibleList.map((entry) => {
          return (
            <BirdRow
              key={entry.speciesName}
              speciesName={entry.speciesName}
              imageUrl={entry.thumbnailUrl}
              subtitle={`${entry.totalOutings} ${entry.totalOutings === 1 ? 'outing' : 'outings'} · ${entry.totalCount} seen · ${formatStoredDate(entry.firstSeenDate)}`}
              onClick={() => onSelectSpecies(entry.speciesName)}
            />
          )
        })}
      </div>

      {hasMore && (
        <div className="py-2">
          <div ref={loadMoreRef} className="h-1" />
          <p className="text-center text-xs text-muted-foreground">
            Loading more… ({filteredList.length - visibleList.length} remaining)
          </p>
        </div>
      )}

      {filteredList.length === 0 && effectiveSearchQuery && (
        <div className="text-center py-8 text-muted-foreground">
          No species found matching "{effectiveSearchQuery}"
        </div>
      )}
    </div>
  )
}

// -- Species Detail View ------------------------------------

function SpeciesDetail({
  entry,
  data,
  onBack,
  onSelectOuting,
}: {
  entry: DexEntry
  data: WingDexDataStore
  onBack: () => void
  onSelectOuting: (id: string) => void
}) {
  const displayName = getDisplayName(entry.speciesName)
  const scientificName = getScientificName(entry.speciesName)
  const { summary } = useBirdSummary(entry.speciesName, { wikiTitle: entry.wikiTitle })
  const [ebirdUrl, setEbirdUrl] = useState(() => getEbirdUrl(displayName))
  const [birdlifeUrl, setBirdlifeUrl] = useState<string | undefined>(undefined)

  useEffect(() => {
    let active = true
    void fetchEbirdUrl(entry.speciesName)
      .then(url => {
        if (active) {
          setEbirdUrl(url)
        }
      })
      .catch(() => {
        if (active) {
          setEbirdUrl(getEbirdUrl(displayName))
        }
      })

    void getBirdlifeFactsheetUrl(entry.speciesName)
      .then(url => {
        if (active) setBirdlifeUrl(url)
      })
      .catch(() => {
        if (active) setBirdlifeUrl(undefined)
      })

    return () => {
      active = false
    }
  }, [entry.speciesName, displayName])

  // Find all sightings of this species across outings
  const sightings: Array<{ observation: Observation; outing: { id: string; locationName: string; startTime: string } }> = []
  for (const outing of data.outings) {
    const obs = data.getOutingObservations(outing.id)
    for (const o of obs) {
      if (o.speciesName === entry.speciesName && o.certainty !== 'rejected') {
        sightings.push({ observation: o, outing: { id: outing.id, locationName: outing.locationName, startTime: outing.startTime } })
      }
    }
  }

  // Several photos of the same bird on one outing are stored as separate observations, so
  // the list shows one row per outing and certainty with the counts added up.
  const sightingsByOuting = new Map<string, (typeof sightings)[number]>()
  for (const sighting of sightings) {
    const key = `${sighting.outing.id}|${sighting.observation.certainty}`
    const existing = sightingsByOuting.get(key)
    if (existing) {
      existing.observation = {
        ...existing.observation,
        count: existing.observation.count + sighting.observation.count,
      }
    } else {
      sightingsByOuting.set(key, sighting)
    }
  }
  const mergedSightings = Array.from(sightingsByOuting.values())

  const thumbnailUrl = entry.thumbnailUrl
  // Derived from the thumbnail so the hero has its final URL on first render instead of
  // waiting on the Wikipedia summary, which returns an unbounded original.
  const fullResUrl = getHeroImageUrl(thumbnailUrl) ?? summary?.imageUrl
  const baseImageUrl = thumbnailUrl || fullResUrl
  const [fullResLoaded, setFullResLoaded] = useState(false)
  // Both layers render the same file, so the base layer settles the crop anchor for both.
  const [heroPortrait, setHeroPortrait] = useState(false)
  const hasDistinctFullRes = !!(fullResUrl && thumbnailUrl && fullResUrl !== thumbnailUrl)
  const canShowOverlay = hasDistinctFullRes
  const fullResRevealToken = useRef(0)

  const revealFullRes = () => {
    const token = fullResRevealToken.current
    if (typeof window === 'undefined') {
      if (token === fullResRevealToken.current) setFullResLoaded(true)
      return
    }
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (token === fullResRevealToken.current) setFullResLoaded(true)
      })
    })
  }

  // Reset loaded state when species changes
  useEffect(() => {
    fullResRevealToken.current += 1
    setFullResLoaded(false)
    setHeroPortrait(false)
  }, [entry.speciesName])

  // The hero is an individually licensed Commons photo, so it needs its own credit.
  const [imageCredit, setImageCredit] = useState<ImageCredit | undefined>(undefined)
  useEffect(() => {
    let active = true
    setImageCredit(undefined)
    void fetchImageCredit(baseImageUrl).then(credit => {
      if (active) setImageCredit(credit)
    })
    return () => { active = false }
  }, [baseImageUrl])

  return (
    <div className="max-w-3xl mx-auto pb-8">
      {/* Back button */}
      <div className="px-4 sm:px-6 pt-6 pb-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2">
          <ArrowLeft size={20} />
          Back
        </Button>
      </div>

      <div className="px-4 sm:px-6 space-y-6">
        {/* Hero: full-width image with overlaid name + stats */}
        <div className="w-full aspect-[4/3] rounded-xl bg-muted overflow-hidden shadow-sm relative">
          {/* Base image layer always stays visible to avoid blank flashes */}
          {baseImageUrl && (
            <img
              src={baseImageUrl}
              alt={canShowOverlay ? '' : displayName}
              aria-hidden={canShowOverlay}
              onLoad={e => setHeroPortrait(e.currentTarget.naturalHeight > e.currentTarget.naturalWidth)}
              style={{ objectPosition: birdObjectPosition(heroPortrait) }}
              className={`absolute inset-0 w-full h-full object-cover ${canShowOverlay ? 'blur-md scale-105' : ''}`}
            />
          )}
          {/* Full-res overlay fades in over the base layer */}
          {canShowOverlay && (
            <img
              src={fullResUrl}
              alt={displayName}
              onLoad={revealFullRes}
              style={{ objectPosition: birdObjectPosition(heroPortrait) }}
              className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-600 ease-in-out ${fullResLoaded ? 'opacity-100' : 'opacity-0'}`}
            />
          )}
          {!baseImageUrl && (
            <div className="absolute inset-0 flex items-center justify-center">
              <BirdLogo size={48} className="text-muted-foreground/40" />
            </div>
          )}

          {/* Gradient overlay + text at bottom */}
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent pt-16 pb-4 px-4 sm:px-5">
            <h2 className="font-serif text-2xl sm:text-3xl font-semibold text-white/90 leading-tight drop-shadow-md">
              {displayName}
            </h2>
            {scientificName && (
              <p className="text-sm text-white/75 italic mt-0.5 drop-shadow-sm">{scientificName}</p>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-sm text-white/70">
              <span><span className="font-semibold text-white/90">{entry.totalCount}</span> seen</span>
              <span className="text-white/40">·</span>
              <span><span className="font-semibold text-white/90">{entry.totalOutings}</span> {entry.totalOutings === 1 ? 'outing' : 'outings'}</span>
              <span className="text-white/40">·</span>
              <span>First <span className="font-semibold text-white/90">{formatStoredDate(entry.firstSeenDate, { month: 'short', day: 'numeric', year: 'numeric' })}</span></span>
            </div>
          </div>
        </div>

        {/* About -- fade in when loaded */}
        {summary?.extract && (
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground leading-relaxed">
              {summary.extract}
            </p>
            <p className="text-xs text-muted-foreground/60">
              Text from <a href={summary.pageUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-muted-foreground">Wikipedia</a> under <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer" className="underline hover:text-muted-foreground">CC BY-SA 4.0</a>.
              {imageCredit && (
                <>
                  {' Photo '}
                  <a href={imageCredit.pageUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-muted-foreground">
                    {[imageCredit.artist, imageCredit.license].filter(Boolean).join(' / ') || 'on Wikimedia Commons'}
                  </a>
                  .
                </>
              )}
            </p>
          </div>
        )}

        {/* External links */}
        <div className="flex flex-wrap gap-2">
          {summary?.pageUrl && (
            <Button variant="outline" size="sm" asChild>
              <a href={summary.pageUrl} target="_blank" rel="noopener noreferrer">
                <ArrowSquareOut size={14} className="mr-1.5" />
                Wikipedia
              </a>
            </Button>
          )}
          <Button variant="outline" size="sm" asChild>
            <a href={ebirdUrl} target="_blank" rel="noopener noreferrer">
              <ArrowSquareOut size={14} className="mr-1.5" />
              eBird
            </a>
          </Button>
          {birdlifeUrl && (
            <Button variant="outline" size="sm" asChild>
              <a href={birdlifeUrl} target="_blank" rel="noopener noreferrer">
                <ArrowSquareOut size={14} className="mr-1.5" />
                BirdLife
              </a>
            </Button>
          )}
        </div>

        {/* Sighting history */}
        {sightings.length > 0 && (
          <div className="space-y-2">
            <h3 className="font-semibold text-foreground">
              Sightings ({sightings.length})
            </h3>
            <div>
              {mergedSightings.map(({ observation, outing }) => (
                <ListRow
                  key={observation.id}
                  icon={<CalendarBlank size={16} className="text-muted-foreground/60" />}
                  onClick={() => onSelectOuting(outing.id)}
                >
                  <p className="text-sm font-medium text-foreground truncate">
                    {outing.locationName || 'Unknown location'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatStoredDate(outing.startTime, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                    {observation.count > 1 && ` · x${observation.count}`}
                    {' · '}
                    {observation.certainty.charAt(0).toUpperCase() + observation.certainty.slice(1)}
                  </p>
                </ListRow>
              ))}
            </div>
          </div>
        )}

        {/* Notes */}
        {entry.notes && (
          <div className="space-y-1.5">
            <h3 className="font-semibold text-foreground">Notes</h3>
            <p className="text-sm text-muted-foreground italic">{entry.notes}</p>
          </div>
        )}
      </div>
    </div>
  )
}
