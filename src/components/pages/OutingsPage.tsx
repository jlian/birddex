import { useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ListRow } from '@/components/ui/list-row'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { SpeciesAutocomplete } from '@/components/ui/species-autocomplete'
import { OutingNameAutocomplete } from '@/components/ui/outing-name-autocomplete'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  MapPin, CalendarBlank, ArrowLeft, Download,
  Trash, PencilSimple, Check, Plus, X, Clock, MagnifyingGlass,
  ArrowUp, ArrowDown, Hash, TextAa
} from '@phosphor-icons/react'
import { BirdLogo } from '@/components/ui/bird-logo'
import { EmptyState } from '@/components/ui/empty-state'
import { BirdRow } from '@/components/ui/bird-row'
import { StatCard } from '@/components/ui/stat-card'
import { getDisplayName } from '@/lib/utils'
import { formatStoredDate, formatStoredTimeWithTZ } from '@/lib/timezone'
import { fetchWithLocalAuthRetry } from '@/lib/local-auth-fetch'
import { assertWingDexApiResponse, getWingDexApiErrorMessage } from '@/lib/api-error'
import { logClientFailure } from '@/lib/client-log'
import { toast } from 'sonner'
import type { WingDexDataStore } from '@/hooks/use-wingdex-data'
import type { Outing, Observation } from '@/lib/types'
import type { TaxonEntry } from '@/components/ui/species-autocomplete'

interface OutingsPageProps {
  data: WingDexDataStore
  selectedOutingId: string | null
  onSelectOuting: (id: string | null) => void
  onSelectSpecies: (name: string) => void
  searchQuery?: string
  onSearchQueryChange?: (value: string) => void
  sortField?: OutingSortField
  sortDir?: SortDir
  onToggleSort?: (field: OutingSortField) => void
}

export type OutingSortField = 'date' | 'species' | 'name'
export type SortDir = 'asc' | 'desc'

const INITIAL_VISIBLE_ITEMS = 40
const LOAD_MORE_STEP = 40

const outingSortOptions: { key: OutingSortField; icon: React.ElementType; label: string }[] = [
  { key: 'date', icon: CalendarBlank, label: 'Sort by date' },
  { key: 'species', icon: BirdLogo, label: 'Sort by species count' },
  { key: 'name', icon: TextAa, label: 'Sort A-Z' },
]

export default function OutingsPage({
  data,
  selectedOutingId,
  onSelectOuting,
  onSelectSpecies,
  searchQuery,
  onSearchQueryChange,
  sortField,
  sortDir,
  onToggleSort,
}: OutingsPageProps) {
  const { outings } = data
  const [internalSearchQuery, setInternalSearchQuery] = useState('')
  const [internalSortField, setInternalSortField] = useState<OutingSortField>('date')
  const [internalSortDir, setInternalSortDir] = useState<SortDir>('desc')
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_ITEMS)
  const loadMoreRef = useRef<HTMLDivElement | null>(null)
  const visibleCountRef = useRef(visibleCount)

  useEffect(() => {
    visibleCountRef.current = visibleCount
  }, [visibleCount])

  const effectiveSearchQuery = searchQuery ?? internalSearchQuery
  const effectiveSortField = sortField ?? internalSortField
  const effectiveSortDir = sortDir ?? internalSortDir

  const handleSearchQueryChange = (value: string) => {
    if (onSearchQueryChange) {
      onSearchQueryChange(value)
      return
    }
    setInternalSearchQuery(value)
  }

  const handleToggleSort = (field: OutingSortField) => {
    if (onToggleSort) {
      onToggleSort(field)
      return
    }

    if (effectiveSortField === field) {
      setInternalSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'))
      return
    }

    setInternalSortField(field)
    setInternalSortDir(field === 'name' ? 'asc' : 'desc')
  }

  const sortedOutings = useMemo(() => {
    const dir = effectiveSortDir === 'asc' ? 1 : -1
    if (effectiveSortField === 'species') {
      const countMap = new Map<string, number>()
      for (const o of outings) {
        countMap.set(o.id, data.getOutingObservations(o.id).filter(obs => obs.certainty === 'confirmed').length)
      }
      return [...outings].sort((a, b) => dir * ((countMap.get(a.id) ?? 0) - (countMap.get(b.id) ?? 0)))
    }
    if (effectiveSortField === 'name') {
      return [...outings].sort((a, b) => {
        const an = (a.locationName || '').toLowerCase()
        const bn = (b.locationName || '').toLowerCase()
        return dir * an.localeCompare(bn)
      })
    }
    // date (default)
    return [...outings].sort((a, b) =>
      dir * (new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
    )
  }, [outings, effectiveSortField, effectiveSortDir, data])

  const filteredOutings = sortedOutings.filter(outing =>
    (outing.locationName || '').toLowerCase().includes(effectiveSearchQuery.toLowerCase())
  )

  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_ITEMS)
  }, [effectiveSearchQuery, effectiveSortField, effectiveSortDir])

  const visibleOutings = useMemo(
    () => filteredOutings.slice(0, visibleCount),
    [filteredOutings, visibleCount]
  )
  const hasMore = visibleCount < filteredOutings.length

  useEffect(() => {
    const node = loadMoreRef.current
    if (!node || !hasMore) return

    const maybeLoadMore = () => {
      if (node.getBoundingClientRect().top > window.innerHeight + 240) return
      if (visibleCountRef.current >= filteredOutings.length) return
      setVisibleCount((count) => {
        const nextCount = Math.min(count + LOAD_MORE_STEP, filteredOutings.length)
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
  }, [filteredOutings.length, hasMore])

  if (outings.length === 0) {
    return (
      <EmptyState
        icon={BirdLogo}
        title="No outings yet"
        description="Upload photos to create your first outing"
      />
    )
  }

  if (selectedOutingId) {
    const outing = outings.find(o => o.id === selectedOutingId)
    if (!outing) {
      // Don't call onSelectOuting during render, use effect or return null gracefully
      return null
    }
    return (
      <OutingDetail
        outing={outing}
        data={data}
        onBack={() => window.history.back()}
        onSelectSpecies={onSelectSpecies}
      />
    )
  }

  return (
    <div className="px-4 sm:px-6 py-6 space-y-4 max-w-3xl mx-auto">
      <div className="space-y-1">
        <h2 className="font-serif text-2xl font-semibold text-foreground">
          Your Outings
        </h2>
        <p className="text-sm text-muted-foreground">
          {outings.length} {outings.length === 1 ? 'outing' : 'outings'} recorded
        </p>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <MagnifyingGlass
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            placeholder="Search outings..."
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
            {outingSortOptions.map(opt => (
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
        {visibleOutings.map((outing) => {
          const observations = data.getOutingObservations(outing.id)
          const confirmed = observations.filter(obs => obs.certainty === 'confirmed')

          return (
            <OutingRow
              key={outing.id}
              outing={outing}
              confirmed={confirmed}
              onClick={() => onSelectOuting(outing.id)}
            />
          )
        })}
      </div>

      {hasMore && (
        <div className="py-2">
          <div ref={loadMoreRef} className="h-1" />
          <p className="text-center text-xs text-muted-foreground">
            Loading more… ({filteredOutings.length - visibleOutings.length} remaining)
          </p>
        </div>
      )}

      {filteredOutings.length === 0 && effectiveSearchQuery && (
        <div className="text-center py-8 text-muted-foreground">
          No outings found matching "{effectiveSearchQuery}"
        </div>
      )}
    </div>
  )
}

// ─── Outing Row (compact list item) ───────────────────────

function OutingRow({
  outing,
  confirmed,
  onClick,
}: {
  outing: Outing
  confirmed: Observation[]
  onClick: () => void
}) {
  return (
    <ListRow
      icon={<MapPin size={16} className="text-muted-foreground/50" />}
      onClick={onClick}
    >
      <p className="font-serif font-semibold text-sm text-foreground truncate">
        {outing.locationName || 'Outing'}
      </p>
      <p className="text-xs text-muted-foreground">
        {formatStoredDate(outing.startTime)} · {confirmed.length} species
      </p>
      {confirmed.length > 0 && (
        <p className="text-xs text-muted-foreground truncate mt-0.5">
          {confirmed.slice(0, 4).map(obs => getDisplayName(obs.speciesName)).join(', ')}
          {confirmed.length > 4 && ` +${confirmed.length - 4} more`}
        </p>
      )}
    </ListRow>
  )
}

// ─── Outing Detail View ───────────────────────────────────

function OutingDetail({
  outing,
  data,
  onBack,
  onSelectSpecies,
}: {
  outing: Outing
  data: WingDexDataStore
  onBack: () => void
  onSelectSpecies: (name: string) => void
}) {
  const observations = data.getOutingObservations(outing.id)
  const confirmed = observations.filter(obs => obs.certainty === 'confirmed')
  const possible = observations.filter(obs => obs.certainty === 'possible')

  // Group observations by species to deduplicate
  const groupedConfirmed = useMemo(() => {
    const map = new Map<string, { speciesName: string; totalCount: number; obsIds: string[] }>()
    for (const obs of confirmed) {
      const existing = map.get(obs.speciesName)
      if (existing) {
        existing.totalCount += obs.count
        existing.obsIds.push(obs.id)
      } else {
        map.set(obs.speciesName, { speciesName: obs.speciesName, totalCount: obs.count, obsIds: [obs.id] })
      }
    }
    return Array.from(map.values())
  }, [confirmed])

  const groupedPossible = useMemo(() => {
    const map = new Map<string, { speciesName: string; totalCount: number; obsIds: string[] }>()
    for (const obs of possible) {
      const existing = map.get(obs.speciesName)
      if (existing) {
        existing.totalCount += obs.count
        existing.obsIds.push(obs.id)
      } else {
        map.set(obs.speciesName, { speciesName: obs.speciesName, totalCount: obs.count, obsIds: [obs.id] })
      }
    }
    return Array.from(map.values())
  }, [possible])

  const [editingNotes, setEditingNotes] = useState(false)
  const [notes, setNotes] = useState(outing.notes || '')
  const [editingLocationName, setEditingLocationName] = useState(false)
  const [locationName, setLocationName] = useState(outing.locationName || '')
  const [addingSpecies, setAddingSpecies] = useState(false)
  const [isAddingSpecies, setIsAddingSpecies] = useState(false)
  const [newSpeciesName, setNewSpeciesName] = useState('')
  const [selectedSpeciesEntry, setSelectedSpeciesEntry] = useState<TaxonEntry | null>(null)
  const [deleteOutingOpen, setDeleteOutingOpen] = useState(false)
  const [pendingDeleteObservation, setPendingDeleteObservation] = useState<{
    ids: string[]
    speciesName: string
  } | null>(null)

  const handleExport = async () => {
    try {
      const response = await fetchWithLocalAuthRetry(`/api/export/outing/${outing.id}`, { credentials: 'include' })
      await assertWingDexApiResponse(response, 'Export failed')

      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `wingdex-outing-${new Date(outing.startTime).toISOString().split('T')[0]}.csv`
      a.click()
      URL.revokeObjectURL(url)
      toast.success('Outing exported in eBird Record CSV format')
    } catch (error) {
      const detail = getWingDexApiErrorMessage(error, 'Please try again.')
      toast.error(`Failed to export outing: ${detail}`)
      logClientFailure('export/outing/export', error, { outingId: outing.id })
    }
  }

  const handleDeleteOuting = () => {
    setDeleteOutingOpen(true)
  }

  const handleSaveNotes = () => {
    data.updateOuting(outing.id, { notes })
    setEditingNotes(false)
    toast.success('Notes saved')
  }

  const handleSaveLocationName = () => {
    const nextLocationName = locationName.trim()
    const resetLocationName = outing.defaultLocationName || outing.locationName || 'Unknown Location'
    const resolvedLocationName = nextLocationName || resetLocationName
    const resolvedDefaultLocationName = outing.defaultLocationName || outing.locationName || 'Unknown Location'

    data.updateOuting(outing.id, {
      locationName: resolvedLocationName,
      defaultLocationName: resolvedDefaultLocationName,
    })
    setLocationName(resolvedLocationName)
    setEditingLocationName(false)
    if (!nextLocationName) {
      toast.success('Outing name reset')
      return
    }
    toast.success('Outing name saved')
  }

  const handleDeleteObservation = (obsIds: string[], speciesName: string) => {
    setPendingDeleteObservation({ ids: obsIds, speciesName })
  }

  const handleAddSpecies = async () => {
    if (!newSpeciesName.trim() || isAddingSpecies) return

    const normalizedName = selectedSpeciesEntry
      ? `${selectedSpeciesEntry.common} (${selectedSpeciesEntry.scientific})`
      : newSpeciesName.trim()

    const obs: Observation = {
      id: `obs_${Date.now()}_manual`,
      outingId: outing.id,
      speciesName: normalizedName,
      count: 1,
      certainty: 'confirmed',
      notes: 'Manually added',
    }
    setIsAddingSpecies(true)
    try {
      await data.addObservations([obs])
      data.updateDex(outing.id, [obs])
      setNewSpeciesName('')
      setSelectedSpeciesEntry(null)
      setAddingSpecies(false)
      toast.success(`${getDisplayName(normalizedName)} added`)
    } catch {
      toast.error(`Could not add ${getDisplayName(normalizedName)}. Try again.`)
    } finally {
      setIsAddingSpecies(false)
    }
  }

  const outingDate = new Date(outing.startTime)
  const endDate = outing.endTime ? new Date(outing.endTime) : null
  const durationMs = endDate && !isNaN(endDate.getTime()) ? endDate.getTime() - outingDate.getTime() : null
  const durationStr = durationMs && durationMs > 0
    ? durationMs >= 3600000
      ? `${Math.floor(durationMs / 3600000)}h ${Math.round((durationMs % 3600000) / 60000)}m`
      : `${Math.round(durationMs / 60000)}m`
    : null

  useEffect(() => {
    setNotes(outing.notes || '')
    setEditingNotes(false)
    setLocationName(outing.locationName || '')
    setEditingLocationName(false)
  }, [outing.id, outing.notes, outing.locationName])

  return (
    <div className="px-4 sm:px-6 py-6 space-y-5 max-w-3xl mx-auto">
      {/* Header */}
      <div>
        <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 mb-2">
          <ArrowLeft size={20} />
          Back
        </Button>
        {editingLocationName ? (
            <div className="space-y-2">
              <OutingNameAutocomplete
                aria-label="Location name"
                value={locationName}
                onChange={setLocationName}
                outings={data.outings}
                placeholder="Outing name"
                autoFocus
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={handleSaveLocationName}>
                  <Check size={14} className="mr-1" />
                  Save
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setLocationName(outing.locationName || '')
                    setEditingLocationName(false)
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-start justify-between gap-3">
              <h2 className="font-serif text-2xl font-semibold text-foreground">
                {outing.locationName || 'Outing'}
              </h2>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditingLocationName(true)}
                aria-label="Edit outing name"
              >
                <PencilSimple size={14} />
              </Button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-sm text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <CalendarBlank size={14} />
              {formatStoredDate(outing.startTime, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
            <span className="flex items-center gap-1.5">
              <Clock size={14} />
              {formatStoredTimeWithTZ(outing.startTime)}
              {durationStr && <span className="text-muted-foreground/60">({durationStr})</span>}
            </span>
          </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard value={groupedConfirmed.length + groupedPossible.length} label="Species" accent="text-primary" />
        <StatCard value={groupedConfirmed.length} label="Confirmed" accent="text-secondary" />
        <StatCard
          value={observations.reduce((sum, o) => sum + o.count, 0)}
          label="Total Count"
          accent="text-primary"
        />
      </div>

      {/* Location */}
      {outing.lat && outing.lon && (
        <a
          href={`https://www.google.com/maps?q=${outing.lat},${outing.lon}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-sm text-muted-foreground press-feel-light"
        >
          <MapPin size={16} weight="fill" className="text-primary flex-shrink-0" />
          <span className="truncate">{outing.defaultLocationName || outing.locationName}</span>
          <span className="text-xs flex-shrink-0">
            ({outing.lat.toFixed(4)}°, {outing.lon.toFixed(4)}°)
          </span>
        </a>
      )}

      {/* Species list */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-foreground">
            Species ({groupedConfirmed.length + groupedPossible.length})
          </h3>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAddingSpecies(!addingSpecies)}
          >
            {addingSpecies ? <X size={14} className="mr-1" /> : <Plus size={14} className="mr-1" />}
            {addingSpecies ? 'Cancel' : 'Add Species'}
          </Button>
        </div>

        {/* Manual species entry */}
        {addingSpecies && (
          <Card className="p-3 space-y-3 border-primary/30">
            <div className="space-y-2">
              <Label htmlFor="species-name">Species Name</Label>
              <SpeciesAutocomplete
                id="species-name"
                value={newSpeciesName}
                onChange={(value) => {
                  setNewSpeciesName(value)
                  setSelectedSpeciesEntry(null)
                }}
                onSelect={entry => {
                  setSelectedSpeciesEntry(entry)
                  setNewSpeciesName(entry.common)
                }}
                onSubmit={handleAddSpecies}
                autoFocus
              />
            </div>
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={handleAddSpecies} disabled={!newSpeciesName.trim() || isAddingSpecies}>
                <Check size={14} className="mr-1" />
                Add
              </Button>
            </div>
          </Card>
        )}

        {/* Confirmed species */}
        {groupedConfirmed.length > 0 && (
          <div>
            {groupedConfirmed.map(group => (
              <BirdRow
                key={group.speciesName}
                speciesName={group.speciesName}
                subtitle={group.totalCount > 1 ? `x${group.totalCount}` : undefined}
                onClick={() => onSelectSpecies(group.speciesName)}
                actions={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive flex-shrink-0 h-8 w-8 p-0"
                    onClick={(e) => { e.stopPropagation(); handleDeleteObservation(group.obsIds, group.speciesName) }}
                  >
                    <Trash size={14} />
                  </Button>
                }
              />
            ))}
          </div>
        )}

        {/* Possible species */}
        {groupedPossible.length > 0 && (
          <>
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider pt-1">
              Possible
            </p>
            <div>
              {groupedPossible.map(group => (
                <BirdRow
                  key={group.speciesName}
                  speciesName={group.speciesName}
                  subtitle={group.totalCount > 1 ? `x${group.totalCount}` : undefined}
                  onClick={() => onSelectSpecies(group.speciesName)}
                  actions={
                    <>
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 flex-shrink-0">possible</Badge>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-destructive flex-shrink-0 h-8 w-8 p-0"
                        onClick={(e) => { e.stopPropagation(); handleDeleteObservation(group.obsIds, group.speciesName) }}
                      >
                        <Trash size={14} />
                      </Button>
                    </>
                  }
                />
              ))}
            </div>
          </>
        )}

        {groupedConfirmed.length === 0 && groupedPossible.length === 0 && (
          <div className="py-8 text-center">
            <BirdLogo size={32} className="text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">
              No species recorded yet
            </p>
          </div>
        )}
      </div>

      {/* Notes */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-foreground">Notes</h3>
          {!editingNotes && (
            <Button variant="ghost" size="sm" onClick={() => setEditingNotes(true)}>
              <PencilSimple size={14} className="mr-1" />
              Edit
            </Button>
          )}
        </div>
        {editingNotes ? (
          <div className="space-y-2">
            <Textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Add notes about this outing..."
              rows={3}
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSaveNotes}>
                <Check size={14} className="mr-1" />
                Save
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setNotes(outing.notes || ''); setEditingNotes(false) }}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground italic">
            {outing.notes || 'No notes yet'}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-2 border-t border-border">
        <Button
          variant="outline"
          className="flex-1"
          onClick={handleExport}
          disabled={confirmed.length === 0}
        >
          <Download size={16} className="mr-1" />
          Export eBird CSV
        </Button>
        <Button
          variant="outline"
          className="text-destructive hover:bg-destructive/10"
          onClick={handleDeleteOuting}
        >
          <Trash size={16} />
        </Button>
      </div>

      <AlertDialog open={deleteOutingOpen} onOpenChange={setDeleteOutingOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this outing?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this outing and all of its observations.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                data.deleteOuting(outing.id)
                toast.success('Outing deleted')
                onBack()
              }}
            >
              Delete Outing
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!pendingDeleteObservation}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteObservation(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove species from outing?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDeleteObservation
                ? `Remove ${getDisplayName(pendingDeleteObservation.speciesName)} from this outing?`
                : 'Remove this species from the outing?'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (!pendingDeleteObservation) return
                data.bulkUpdateObservations(pendingDeleteObservation.ids, { certainty: 'rejected' })
                toast.success('Observation removed')
                setPendingDeleteObservation(null)
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
