import { debug } from '@/lib/debug'
import { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { CalendarBlank, CheckCircle, XCircle, PencilSimple, MagnifyingGlass } from '@phosphor-icons/react'
import { Switch } from '@/components/ui/switch'
import { findMatchingOuting } from '@/lib/clustering'
import { dateToLocalISOWithOffset, toLocalISOWithOffset, formatStoredDate, formatStoredTimeWithTZ } from '@/lib/timezone'
import type { WingDexDataStore } from '@/hooks/use-wingdex-data'
import type { Outing } from '@/lib/types'
import { reverseGeocode, searchPlaces, type GeocodingResult } from '@/lib/geocoding'
import { toast } from 'sonner'

interface PhotoCluster {
  photos: any[]
  startTime: Date
  endTime: Date
  centerLat?: number
  centerLon?: number
}

interface OutingReviewProps {
  cluster: PhotoCluster
  data: WingDexDataStore
  userId: string
  /** Pre-fill location from a previous outing (user can override) */
  defaultLocationName?: string
  /** Automatically look up location name from GPS when available */
  autoLookupGps?: boolean
  onConfirm: (
    outingId: string,
    locationName: string,
    lat?: number,
    lon?: number
  ) => Promise<void>
}

export default function OutingReview({
  cluster,
  data,
  userId,
  defaultLocationName = '',
  autoLookupGps = false,
  onConfirm
}: OutingReviewProps) {
  const hasGps = cluster.centerLat !== undefined && cluster.centerLon !== undefined
  const roundedLat = hasGps ? Number(cluster.centerLat!.toFixed(3)) : undefined
  const roundedLon = hasGps ? Number(cluster.centerLon!.toFixed(3)) : undefined
  const [locationName, setLocationName] = useState(defaultLocationName)
  const [isLoadingLocation, setIsLoadingLocation] = useState(false)
  const [isConfirming, setIsConfirming] = useState(false)
  const preparedOutingRef = useRef<Outing | null>(null)
  const defaultLocationNameRef = useRef(defaultLocationName)
  const [suggestedLocation, setSuggestedLocation] = useState(defaultLocationName)
  const [suggestedStateProvince, setSuggestedStateProvince] = useState<string | undefined>(undefined)
  const [suggestedCountryCode, setSuggestedCountryCode] = useState<string | undefined>(undefined)
  const [inferredStateProvince, setInferredStateProvince] = useState<string | undefined>(undefined)
  const [inferredCountryCode, setInferredCountryCode] = useState<string | undefined>(undefined)
  const [locationLookupFailed, setLocationLookupFailed] = useState(false)

  // Compute observation-local ISO string for display and manual editing.
  // cluster.startTime is a UTC-correct Date (exifTime is offset-aware),
  // so dateToLocalISOWithOffset formats it in the photo's GPS timezone.
  const startLocalISO = dateToLocalISOWithOffset(cluster.startTime, cluster.centerLat, cluster.centerLon)
  const startLocalMatch = startLocalISO.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/)

  // Manual date/time editing (#13)
  const [editingDateTime, setEditingDateTime] = useState(false)
  const [manualDate, setManualDate] = useState(
    startLocalMatch ? startLocalMatch[1] : cluster.startTime.toISOString().slice(0, 10)
  )
  const [manualTime, setManualTime] = useState(
    startLocalMatch ? startLocalMatch[2] : '00:00'
  )
  const [overriddenStartTime, setOverriddenStartTime] = useState<Date | null>(null)

  // Place search (#13)
  const [placeResults, setPlaceResults] = useState<GeocodingResult[]>([])
  const [isSearchingPlace, setIsSearchingPlace] = useState(false)
  const [overriddenCoords, setOverriddenCoords] = useState<{ lat: number; lon: number } | null>(null)
  const [isEditingLocation, setIsEditingLocation] = useState(false)
  const [locationSearchQuery, setLocationSearchQuery] = useState('')
  const [placeSearchFailed, setPlaceSearchFailed] = useState(false)

  // Effective coordinates (manual override or cluster GPS)
  const effectiveLat = overriddenCoords?.lat ?? cluster.centerLat
  const effectiveLon = overriddenCoords?.lon ?? cluster.centerLon
  const effectiveStartTime = overriddenStartTime ?? cluster.startTime
  const effectiveEndTime = overriddenStartTime
    ? new Date(overriddenStartTime.getTime() + (cluster.endTime.getTime() - cluster.startTime.getTime()))
    : cluster.endTime

  // Match against outings that existed when this review began. A newly saved
  // outing must not become its own "existing outing" while confirmation runs.
  const [matchingOuting] = useState(() => findMatchingOuting(cluster, data.outings))
  const [useExistingOuting, setUseExistingOuting] = useState(!!matchingOuting)

  const fetchLocationName = useCallback(async (lat: number, lon: number) => {
    setIsLoadingLocation(true)
    setLocationLookupFailed(false)
    try {
      debug('geocoding', 'Starting reverse geocoding')
      const result = await reverseGeocode(lat, lon)
      if (!result) throw new Error('No location name returned')
      
      debug('geocoding', 'Location identified')
      setSuggestedLocation(result.label)
      setLocationName(result.label)
      setSuggestedStateProvince(result.stateProvince)
      setSuggestedCountryCode(result.countryCode)
      setInferredStateProvince(result.stateProvince)
      setInferredCountryCode(result.countryCode)
    } catch (error) {
      debug('geocoding', 'Reverse geocoding failed')
      // Fall back to default location or coordinate string
      const fallback = defaultLocationNameRef.current || `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`
      debug('geocoding', 'Using location fallback')
      setSuggestedLocation(fallback)
      setLocationName(fallback)
      setSuggestedStateProvince(undefined)
      setSuggestedCountryCode(undefined)
      setInferredStateProvince(undefined)
      setInferredCountryCode(undefined)
      setLocationLookupFailed(true)
    } finally {
      setIsLoadingLocation(false)
    }
  }, [])

  // Automatically look up location name from GPS when enabled
  useEffect(() => {
    if (autoLookupGps && hasGps && !matchingOuting) {
      void fetchLocationName(roundedLat!, roundedLon!)
    }
  }, [autoLookupGps, hasGps, matchingOuting, fetchLocationName, roundedLat, roundedLon])

  useEffect(() => {
    if (autoLookupGps && hasGps && matchingOuting && !useExistingOuting) {
      void fetchLocationName(roundedLat!, roundedLon!)
    }
  }, [autoLookupGps, hasGps, matchingOuting, useExistingOuting, roundedLat, roundedLon, fetchLocationName])

  const doConfirm = async (name: string) => {
    if (isConfirming) return
    setIsConfirming(true)
    try {
      if (useExistingOuting && matchingOuting) {
        // Merge into existing outing, expand its time window if needed.
        // cluster.startTime is a proper UTC instant (exifTime is offset-aware),
        // so dateToLocalISOWithOffset correctly formats it in the outing's TZ.
        const clusterStartISO = dateToLocalISOWithOffset(
          cluster.startTime, matchingOuting.lat, matchingOuting.lon
        )
        const clusterEndISO = dateToLocalISOWithOffset(
          cluster.endTime, matchingOuting.lat, matchingOuting.lon
        )
        const existingStartMs = new Date(matchingOuting.startTime).getTime()
        const existingEndMs = new Date(matchingOuting.endTime).getTime()
        const clusterStartMs = cluster.startTime.getTime()
        const clusterEndMs = cluster.endTime.getTime()

        const needsTimeExpansion = clusterStartMs < existingStartMs || clusterEndMs > existingEndMs
        const needsRegionFill =
          (!matchingOuting.stateProvince && !!inferredStateProvince) ||
          (!matchingOuting.countryCode && !!inferredCountryCode)

        if (needsTimeExpansion || needsRegionFill) {
          data.updateOuting(matchingOuting.id, {
            startTime: needsTimeExpansion && clusterStartMs < existingStartMs ? clusterStartISO : matchingOuting.startTime,
            endTime: needsTimeExpansion && clusterEndMs > existingEndMs ? clusterEndISO : matchingOuting.endTime,
            stateProvince: matchingOuting.stateProvince || inferredStateProvince,
            countryCode: matchingOuting.countryCode || inferredCountryCode,
          })
        }

        await onConfirm(matchingOuting.id, matchingOuting.locationName, matchingOuting.lat, matchingOuting.lon)
        return
      }

      const outing = preparedOutingRef.current ?? {
        id: `outing_${crypto.randomUUID()}`,
        userId: userId.toString(),
        startTime: dateToLocalISOWithOffset(effectiveStartTime, effectiveLat, effectiveLon),
        endTime: dateToLocalISOWithOffset(effectiveEndTime, effectiveLat, effectiveLon),
        locationName: name || 'Unknown Location',
        defaultLocationName: name || 'Unknown Location',
        lat: effectiveLat,
        lon: effectiveLon,
        stateProvince: inferredStateProvince,
        countryCode: inferredCountryCode,
        notes: '',
        createdAt: new Date().toISOString()
      }
      preparedOutingRef.current = outing

      await data.addOuting(outing)
      await onConfirm(outing.id, name || 'Unknown Location', effectiveLat, effectiveLon)
      preparedOutingRef.current = null
    } finally {
      setIsConfirming(false)
    }
  }

  const handleConfirm = () => {
    void doConfirm(locationName).catch(() => {
      toast.error('Could not continue saving this outing. Try again.')
    })
  }

  const handleApplyDateTime = () => {
    const [year, month, day] = manualDate.split('-').map(Number)
    const [hours, minutes] = manualTime.split(':').map(Number)
    if (!isNaN(year) && !isNaN(month) && !isNaN(day) && !isNaN(hours) && !isNaN(minutes)) {
      // User types observation-local time. Convert to a correct UTC instant
      // by treating it as naive local at the GPS coords.
      const pad = (n: number) => String(n).padStart(2, '0')
      const naiveISO = `${year}-${pad(month)}-${pad(day)}T${pad(hours)}:${pad(minutes)}:00`
      const offsetAware = toLocalISOWithOffset(naiveISO, effectiveLat, effectiveLon)
      setOverriddenStartTime(new Date(offsetAware))
      setEditingDateTime(false)
    }
  }

  const searchAbortRef = useRef<AbortController | null>(null)

  const cancelPlaceSearch = useCallback(() => {
    searchAbortRef.current?.abort()
    searchAbortRef.current = null
    setIsSearchingPlace(false)
  }, [])

  const searchPlace = useCallback(async (query: string) => {
    if (!query.trim()) return
    searchAbortRef.current?.abort()
    const controller = new AbortController()
    searchAbortRef.current = controller
    setIsSearchingPlace(true)
    setPlaceSearchFailed(false)
    try {
      const results = await searchPlaces(query, controller.signal)
      if (!controller.signal.aborted) setPlaceResults(results)
    } catch (error) {
      if (controller.signal.aborted) return
      debug('geocoding', 'Place search failed')
      setPlaceSearchFailed(true)
    } finally {
      if (searchAbortRef.current === controller) {
        searchAbortRef.current = null
        setIsSearchingPlace(false)
      }
    }
  }, [])

  const selectPlace = (place: GeocodingResult) => {
    cancelPlaceSearch()
    setOverriddenCoords({ lat: place.lat, lon: place.lon })
    setLocationName(place.label)
    setInferredStateProvince(place.stateProvince)
    setInferredCountryCode(place.countryCode)
    setPlaceSearchFailed(false)
    setPlaceResults([])
    setIsEditingLocation(false)
    setLocationSearchQuery('')
  }

  const useEnteredLocation = () => {
    const name = locationSearchQuery.trim()
    if (!name) return
    cancelPlaceSearch()
    setLocationName(name)
    setOverriddenCoords(null)
    setInferredStateProvince(undefined)
    setInferredCountryCode(undefined)
    setIsEditingLocation(false)
    setLocationSearchQuery('')
    setPlaceResults([])
    setPlaceSearchFailed(false)
  }


  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {/* Date/time display with edit capability (#13) */}
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <CalendarBlank size={18} />
          {(() => {
            // Format in the observation's timezone (GPS coords), not browser TZ
            const displayISO = dateToLocalISOWithOffset(effectiveStartTime, effectiveLat, effectiveLon)
            return (
              <span>
                {formatStoredDate(displayISO)} at{' '}
                {formatStoredTimeWithTZ(displayISO)}
              </span>
            )
          })()}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5"
            onClick={() => setEditingDateTime(!editingDateTime)}
          >
            <PencilSimple size={14} />
          </Button>
        </div>

        {/* Manual date/time editor */}
        {editingDateTime && (
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Label htmlFor="manual-date" className="text-xs">Date</Label>
              <Input
                id="manual-date"
                type="date"
                value={manualDate}
                onChange={e => setManualDate(e.target.value)}
                className="h-8 text-sm"
              />
            </div>
            <div className="flex-1">
              <Label htmlFor="manual-time" className="text-xs">Time</Label>
              <Input
                id="manual-time"
                type="time"
                value={manualTime}
                onChange={e => setManualTime(e.target.value)}
                className="h-8 text-sm"
              />
            </div>
            <Button size="sm" className="h-8" onClick={handleApplyDateTime}>
              Apply
            </Button>
          </div>
        )}

        {/* GPS Status Indicator */}
        {hasGps ? (
          <div className="flex items-center gap-2 text-sm">
            <CheckCircle size={18} weight="fill" className="text-green-500" />
            <span className="text-green-600 dark:text-green-400 font-medium">GPS detected</span>
            <span className="text-muted-foreground">
              ({cluster.centerLat?.toFixed(4)}, {cluster.centerLon?.toFixed(4)})
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm">
            <XCircle size={18} weight="fill" className="text-amber-500" />
            <span className="text-amber-600 dark:text-amber-400 font-medium">No GPS data in photo</span>
          </div>
        )}
      </div>

      {/* Matching outing detected */}
      {matchingOuting && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">
                Add to existing outing?
              </p>
              <p className="text-xs text-muted-foreground truncate">
                {matchingOuting.locationName} · {formatStoredDate(matchingOuting.startTime)}
              </p>
            </div>
            <Switch
              checked={useExistingOuting}
              onCheckedChange={setUseExistingOuting}
              aria-label="Add to existing outing?"
            />
          </div>
        </div>
      )}

      <>
          {!useExistingOuting && (
          <div className="space-y-2">
            <Label htmlFor="location-name">Location Name</Label>

            {isLoadingLocation ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                <span>Identifying location from GPS...</span>
              </div>
            ) : isEditingLocation ? (
              <div className="relative space-y-2">
                <form
                  className="flex gap-2"
                  onSubmit={event => {
                    event.preventDefault()
                    void searchPlace(locationSearchQuery)
                  }}
                >
                  <Input
                    id="location-name"
                    autoFocus
                    placeholder="Search for a place..."
                    value={locationSearchQuery}
                    onChange={e => {
                      cancelPlaceSearch()
                      setPlaceSearchFailed(false)
                      setLocationSearchQuery(e.target.value)
                      setPlaceResults([])
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Escape') {
                        cancelPlaceSearch()
                        setIsEditingLocation(false)
                        setLocationSearchQuery('')
                        setPlaceResults([])
                      }
                    }}
                  />
                  <Button
                    type="submit"
                    size="icon"
                    variant="outline"
                    disabled={!locationSearchQuery.trim() || isSearchingPlace}
                    aria-label="Search locations"
                    title="Search locations"
                  >
                    <MagnifyingGlass size={18} />
                  </Button>
                </form>
                {(placeResults.length > 0 || isSearchingPlace) && (
                  <div className="absolute z-50 top-full left-0 right-0 mt-1 rounded-md border bg-popover shadow-md max-h-40 overflow-y-auto">
                    {isSearchingPlace && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground px-3 py-2">
                        <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                        Searching...
                      </div>
                    )}
                    {placeResults.map((place) => (
                      <button
                        type="button"
                        key={`${place.lat},${place.lon},${place.label}`}
                        className="w-full text-left px-3 py-2 text-xs hover:bg-accent/50 active:bg-accent transition-colors"
                        onClick={() => selectPlace(place)}
                      >
                        {place.label}
                        {place.context && (
                          <span className="block text-muted-foreground">{place.context}</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
                {placeSearchFailed && (
                  <p className="text-xs text-destructive">
                    Search failed.{' '}
                    <button
                      type="button"
                      className="font-medium underline underline-offset-2"
                      onClick={() => void searchPlace(locationSearchQuery)}
                    >
                      Retry
                    </button>
                  </p>
                )}
                {suggestedLocation && locationSearchQuery && suggestedLocation !== locationName && (
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    onClick={() => {
                      cancelPlaceSearch()
                      setLocationName(suggestedLocation)
                      setOverriddenCoords(null)
                      setInferredStateProvince(suggestedStateProvince)
                      setInferredCountryCode(suggestedCountryCode)
                      setIsEditingLocation(false)
                      setLocationSearchQuery('')
                      setPlaceResults([])
                    }}
                  >
                    Use GPS: {suggestedLocation}
                  </button>
                )}
                {locationSearchQuery.trim() && (
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    onClick={useEnteredLocation}
                  >
                    Use entered name without searching
                  </button>
                )}
              </div>
            ) : (
              <button
                type="button"
                className="w-full flex items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent/50 transition-colors text-left"
                onClick={() => {
                  setIsEditingLocation(true)
                  setLocationSearchQuery(locationName)
                }}
              >
                <span className={locationName ? 'text-foreground' : 'text-muted-foreground'}>
                  {locationName || 'Tap to set location'}
                </span>
                <PencilSimple size={14} className="text-muted-foreground shrink-0" />
              </button>
            )}
            {locationLookupFailed && hasGps && (
              <p className="text-xs text-destructive">
                Location lookup failed.{' '}
                <button
                  type="button"
                  className="font-medium underline underline-offset-2"
                  onClick={() => void fetchLocationName(roundedLat!, roundedLon!)}
                >
                  Retry
                </button>
              </p>
            )}
          </div>
          )}

          <p className="text-xs text-muted-foreground">
            Location data from{' '}
            <a href="https://www.geoapify.com/" target="_blank" rel="noreferrer" className="underline underline-offset-2">
              Geoapify
            </a>
            {', '}
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className="underline underline-offset-2">
              OpenStreetMap
            </a>
            {', and '}
            <a href="https://www.geonames.org/" target="_blank" rel="noreferrer" className="underline underline-offset-2">
              GeoNames
            </a>
            .
          </p>

          <div className="space-y-2">
            <Label>Photos ({cluster.photos.length})</Label>
            <ScrollArea className="h-32">
              <div className="grid grid-cols-4 gap-2">
                {cluster.photos.map(photo => (
                  <img
                    key={photo.id}
                    src={photo.thumbnail}
                    alt="Bird"
                    className="w-full aspect-square object-cover rounded"
                  />
                ))}
              </div>
            </ScrollArea>
          </div>

          <Button
            onClick={handleConfirm}
            disabled={isLoadingLocation || isConfirming}
            className="w-full bg-primary text-primary-foreground"
          >
            {isLoadingLocation || isConfirming ? 'Loading...' : 'Continue to Species Identification'}
          </Button>
        </>
    </div>
  )
}
