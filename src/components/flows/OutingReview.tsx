import { debug } from '@/lib/debug'
import { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { CalendarBlank, CheckCircle, XCircle, PencilSimple, MagnifyingGlass, NavigationArrow } from '@phosphor-icons/react'
import { Switch } from '@/components/ui/switch'
import { findMatchingOuting } from '@/lib/clustering'
import { dateToLocalISOWithOffset, toLocalISOWithOffset, formatStoredDate, formatStoredTimeWithTZ } from '@/lib/timezone'
import type { WingDexDataStore } from '@/hooks/use-wingdex-data'
import type { Outing } from '@/lib/types'
import { reverseGeocode, searchPlaces, type GeocodingResult } from '@/lib/geocoding'
import { getCurrentLocation } from '@/lib/current-location'
import { toast } from 'sonner'

interface PhotoCluster {
  photos: any[]
  startTime: Date
  endTime: Date
  centerLat?: number
  centerLon?: number
}

type LocationSource = 'gps' | 'current'
type LookupState = 'ok' | 'empty' | 'error'
interface LocationSuggestion {
  name: string
  lat: number
  lon: number
  source: LocationSource
  state: LookupState
  stateProvince?: string
  countryCode?: string
}

interface OutingReviewProps {
  cluster: PhotoCluster
  data: WingDexDataStore
  userId: string
  /** Automatically look up location name from GPS when available */
  autoLookupGps?: boolean
  ensureSessionReady?: () => Promise<boolean>
  onConfirm: (
    outing: Outing | null,
    outingId: string,
    locationName: string,
    lat?: number,
    lon?: number,
    outingOverridesPhotoGps?: boolean,
  ) => Promise<void>
}

export default function OutingReview({
  cluster,
  data,
  userId,
  autoLookupGps = false,
  ensureSessionReady = async () => true,
  onConfirm
}: OutingReviewProps) {
  const hasGps = cluster.centerLat !== undefined && cluster.centerLon !== undefined
  const [locationName, setLocationName] = useState('')
  const [isLoadingLocation, setIsLoadingLocation] = useState(false)
  const [isLocating, setIsLocating] = useState(false)
  const [locationError, setLocationError] = useState<string | null>(null)
  const locationRequestRef = useRef<AbortController | null>(null)
  const [isConfirming, setIsConfirming] = useState(false)
  const [suggestion, setSuggestion] = useState<LocationSuggestion | null>(null)
  const [inferredStateProvince, setInferredStateProvince] = useState<string | undefined>(undefined)
  const [inferredCountryCode, setInferredCountryCode] = useState<string | undefined>(undefined)
  /**
   * Why three states rather than one boolean.
   *
   * A reverse-geocode call has two very different unhappy endings, and
   * collapsing them into "failed" produced a misleading UI. `'error'` means the
   * request genuinely broke: a 500, a timeout, a network drop. Retrying that is
   * sensible. `'empty'` means the lookup SUCCEEDED and there is no named place
   * near the coordinate, which is common in rural areas: 18.5% of 20,000
   * iNaturalist coordinates have no named OSM feature within 2 km. Retrying
   * that is guaranteed to return the same nothing, so offering a Retry button
   * invites the user to click something that cannot help them.
   */
  const [lookupState, setLookupState] = useState<LookupState>('ok')

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
  const [overriddenCoords, setOverriddenCoords] = useState<{
    lat: number; lon: number; source: 'search' | 'current'
  } | null>(null)
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

  const cancelLocationRequest = useCallback(() => {
    locationRequestRef.current?.abort()
    locationRequestRef.current = null
    setIsLocating(false)
    setIsLoadingLocation(false)
  }, [])

  const fetchLocationName = useCallback(async (
    lat: number,
    lon: number,
    source: LocationSource = 'gps',
    controller = new AbortController(),
  ) => {
    if (locationRequestRef.current !== controller) locationRequestRef.current?.abort()
    locationRequestRef.current = controller
    setIsLoadingLocation(true)
    setLookupState('ok')

    const applyLocation = (
      name: string,
      state: LookupState,
      regionCodes: { stateProvince?: string; countryCode?: string } = {},
    ) => {
      setSuggestion({ name, lat, lon, source, state, ...regionCodes })
      setLocationName(name)
      setInferredStateProvince(regionCodes.stateProvince)
      setInferredCountryCode(regionCodes.countryCode)
      setLookupState(state)
    }
    // A prior outing's name is not evidence about this coordinate, even on error.
    const coordinates = `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`
    applyLocation(coordinates, 'ok')

    try {
      debug('geocoding', 'Starting reverse geocoding')
      const { result, regionCodes } = await reverseGeocode(lat, lon, controller.signal)
      if (controller.signal.aborted) return
      if (!result) {
        debug('geocoding', 'No named place near this coordinate')
        applyLocation(coordinates, 'empty', regionCodes)
        return
      }

      debug('geocoding', 'Location identified')
      applyLocation(result.label, 'ok', { stateProvince: result.stateProvince, countryCode: result.countryCode })
    } catch {
      if (controller.signal.aborted) return
      debug('geocoding', 'Reverse geocoding request failed')
      applyLocation(coordinates, 'error')
    } finally {
      if (locationRequestRef.current === controller) {
        locationRequestRef.current = null
        setIsLoadingLocation(false)
      }
    }
  }, [])

  useEffect(() => {
    if (autoLookupGps && hasGps && !useExistingOuting) {
      void fetchLocationName(cluster.centerLat!, cluster.centerLon!)
    }
    return cancelLocationRequest
  }, [autoLookupGps, hasGps, useExistingOuting, cluster.centerLat, cluster.centerLon, fetchLocationName, cancelLocationRequest])

  const doConfirm = async (name: string) => {
    if (isConfirming) return
    cancelLocationRequest()
    cancelPlaceSearch()
    setIsConfirming(true)
    try {
      if (!await ensureSessionReady()) throw new Error('Anonymous session is not ready')
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

        await onConfirm(
          null,
          matchingOuting.id,
          matchingOuting.locationName,
          matchingOuting.lat,
          matchingOuting.lon,
          false,
        )
        return
      }

      const outing = {
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

      // Nothing is written until the cluster produces a sighting; see AddPhotosFlow.
      await onConfirm(
        outing,
        outing.id,
        name || 'Unknown Location',
        effectiveLat,
        effectiveLon,
        overriddenCoords !== null,
      )
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

  useEffect(() => () => searchAbortRef.current?.abort(), [])

  const requestCurrentLocation = async () => {
    cancelLocationRequest()
    cancelPlaceSearch()
    const controller = new AbortController()
    locationRequestRef.current = controller
    setLocationError(null)
    setIsLocating(true)
    setPlaceResults([])
    setPlaceSearchFailed(false)
    try {
      const coordinates = await getCurrentLocation(controller.signal)
      if (controller.signal.aborted) return
      setOverriddenCoords({ ...coordinates, source: 'current' })
      setIsLocating(false)
      setIsEditingLocation(false)
      setLocationSearchQuery('')
      await fetchLocationName(coordinates.lat, coordinates.lon, 'current', controller)
    } catch (error) {
      if (controller.signal.aborted) return
      debug('geolocation', 'Current location request failed', error)
      setLocationError(error instanceof Error ? error.message : 'Could not get your location. Try again or search for a place.')
    } finally {
      if (locationRequestRef.current === controller) {
        locationRequestRef.current = null
        setIsLocating(false)
      }
    }
  }

  const searchPlace = useCallback(async (query: string) => {
    if (!query.trim()) return
    cancelLocationRequest()
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
  }, [cancelLocationRequest])

  const selectPlace = (place: GeocodingResult) => {
    cancelLocationRequest()
    cancelPlaceSearch()
    setLocationError(null)
    setOverriddenCoords({ lat: place.lat, lon: place.lon, source: 'search' })
    setLocationName(place.label)
    setInferredStateProvince(place.stateProvince)
    setInferredCountryCode(place.countryCode)
    setPlaceSearchFailed(false)
    setPlaceResults([])
    setIsEditingLocation(false)
    setLocationSearchQuery('')
    // The name is no longer the reverse-geocode fallback, so the "no named
    // place found nearby" hint would be both false and confusing: it asks the
    // user to tap the field they just filled in.
    setLookupState('ok')
  }

  const useEnteredLocation = () => {
    const name = locationSearchQuery.trim()
    if (!name) return
    cancelLocationRequest()
    cancelPlaceSearch()
    setLocationError(null)
    setLocationName(name)
    if (overriddenCoords?.source !== 'current') {
      setOverriddenCoords(null)
      setInferredStateProvince(undefined)
      setInferredCountryCode(undefined)
    }
    setIsEditingLocation(false)
    setLocationSearchQuery('')
    setPlaceResults([])
    setPlaceSearchFailed(false)
    // Same reason as selectPlace: the user has named this outing, so the
    // reverse-geocode hint no longer describes the current value.
    setLookupState('ok')
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
            {/*
              effectiveLat/Lon, not cluster.centerLat/Lon. Picking a search
              result MOVES the outing's coordinates, and showing the original
              here made that override invisible: the line kept displaying the
              photo's GPS while the saved outing used the searched place.
            */}
            <span className="text-muted-foreground">
              ({effectiveLat?.toFixed(4)}, {effectiveLon?.toFixed(4)})
            </span>
          </div>
        ) : overriddenCoords ? (
          // No EXIF GPS, but the user searched for a place, so the outing DOES
          // have coordinates now. Saying "No GPS data" here would be false.
          <div className="flex items-center gap-2 text-sm">
            <CheckCircle size={18} weight="fill" className="text-green-500" />
            <span className="text-green-600 dark:text-green-400 font-medium">
              {overriddenCoords.source === 'current' ? 'Current location' : 'Location set from search'}
            </span>
            <span className="text-muted-foreground">
              ({overriddenCoords.lat.toFixed(4)}, {overriddenCoords.lon.toFixed(4)})
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
              onCheckedChange={value => {
                cancelLocationRequest()
                cancelPlaceSearch()
                setUseExistingOuting(value)
              }}
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
                <span>{suggestion?.source === 'current' ? 'Finding a name for your location...' : 'Identifying location from GPS...'}</span>
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
                      cancelLocationRequest()
                      cancelPlaceSearch()
                      setPlaceSearchFailed(false)
                      setLocationSearchQuery(e.target.value)
                      setPlaceResults([])
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Escape') {
                        cancelLocationRequest()
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
                {!hasGps && !overriddenCoords && (
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full justify-start"
                    onClick={() => void requestCurrentLocation()}
                    disabled={isLocating || isConfirming}
                  >
                    <NavigationArrow size={18} />
                    {isLocating ? 'Getting current location...' : 'Use current location'}
                  </Button>
                )}
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
                {suggestion && locationSearchQuery && (
                  suggestion.name !== locationName || suggestion.lat !== effectiveLat || suggestion.lon !== effectiveLon
                ) && (
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    onClick={() => {
                      cancelLocationRequest()
                      cancelPlaceSearch()
                      setLocationError(null)
                      setLocationName(suggestion.name)
                      setOverriddenCoords(suggestion.source === 'current'
                        ? { lat: suggestion.lat, lon: suggestion.lon, source: 'current' }
                        : null)
                      setInferredStateProvince(suggestion.stateProvince)
                      setInferredCountryCode(suggestion.countryCode)
                      setLookupState(suggestion.state)
                      setIsEditingLocation(false)
                      setLocationSearchQuery('')
                      setPlaceResults([])
                    }}
                  >
                    {suggestion.source === 'current' ? 'Use current location' : 'Use GPS'}: {suggestion.name}
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
                  cancelLocationRequest()
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
            {(isLocating || isLoadingLocation) && (
              <Button type="button" variant="ghost" size="sm" onClick={cancelLocationRequest}>
                Cancel location lookup
              </Button>
            )}
            {locationError && <p role="alert" className="text-xs text-destructive">{locationError}</p>}
            {lookupState === 'error' && suggestion && (
              <p className="text-xs text-destructive">
                Location lookup failed.{' '}
                <button
                  type="button"
                  className="font-medium underline underline-offset-2"
                  onClick={() => void fetchLocationName(suggestion.lat, suggestion.lon, suggestion.source)}
                >
                  Retry
                </button>
              </p>
            )}
            {lookupState === 'empty' && suggestion && (
              // Deliberately no Retry: the lookup worked, and the answer is that
              // nothing named is nearby, so a retry returns the same result.
              <p className="text-xs text-muted-foreground">
                No named place found nearby. Tap above to name this outing.
              </p>
            )}
          </div>
          )}

          <p className="text-xs text-muted-foreground">
            Powered by{' '}
            <a href="https://www.geoapify.com/" target="_blank" rel="noreferrer" className="underline underline-offset-2">
              Geoapify
            </a>
            {' and '}
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className="underline underline-offset-2">
              OpenStreetMap
            </a>
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
            disabled={isLocating || isLoadingLocation || isConfirming}
            className="w-full bg-primary text-primary-foreground"
          >
            {isLocating || isLoadingLocation || isConfirming ? 'Loading...' : 'Continue to Species Identification'}
          </Button>
        </>
    </div>
  )
}
