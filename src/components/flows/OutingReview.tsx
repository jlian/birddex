import { debug } from '@/lib/debug'
import { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { CalendarBlank, CheckCircle, XCircle, PencilSimple } from '@phosphor-icons/react'
import { Switch } from '@/components/ui/switch'
import { findMatchingOuting } from '@/lib/clustering'
import { dateToLocalISOWithOffset, toLocalISOWithOffset, formatStoredDate, formatStoredTimeWithTZ } from '@/lib/timezone'
import type { WingDexDataStore } from '@/hooks/use-wingdex-data'
import type { Outing } from '@/lib/types'
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

function normalizeStateProvinceCode(raw?: string): string | undefined {
  if (!raw) return undefined
  const value = raw.trim().toUpperCase()
  if (!value) return undefined
  return /^[A-Z]{2}-[A-Z0-9]{1,6}$/.test(value) ? value : undefined
}

function extractRegionCodes(result: any): { stateProvince?: string; countryCode?: string } {
  const address = result?.address as Record<string, string> | undefined
  if (!address) return {}

  const countryCode = address.country_code?.trim().toUpperCase()
  const directState =
    normalizeStateProvinceCode(address['ISO3166-2-lvl4']) ||
    normalizeStateProvinceCode(address['ISO3166-2-lvl3']) ||
    normalizeStateProvinceCode(address['ISO3166-2-lvl5'])

  if (directState || !countryCode) {
    return { stateProvince: directState, countryCode: countryCode || undefined }
  }

  const stateCode =
    address.state_code?.trim().toUpperCase() ||
    address.region_code?.trim().toUpperCase()
  if (stateCode && /^[A-Z0-9]{1,6}$/.test(stateCode)) {
    return {
      stateProvince: `${countryCode}-${stateCode}`,
      countryCode,
    }
  }

  return { countryCode }
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
  const [inferredStateProvince, setInferredStateProvince] = useState<string | undefined>(undefined)
  const [inferredCountryCode, setInferredCountryCode] = useState<string | undefined>(undefined)

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
  const [placeResults, setPlaceResults] = useState<Array<{ place_id: number; display_name: string; lat: string; lon: string; address?: Record<string, string> }>>([])
  const [isSearchingPlace, setIsSearchingPlace] = useState(false)
  const [overriddenCoords, setOverriddenCoords] = useState<{ lat: number; lon: number } | null>(null)
  const [isEditingLocation, setIsEditingLocation] = useState(false)
  const [locationSearchQuery, setLocationSearchQuery] = useState('')

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
    try {
      // Prefer Nominatim-native place hierarchy:
      // 1) nearby major nature POI from bounded search (park/reserve/refuge/etc.)
      // 2) natural feature at point (strait/bay/lake/cliff/etc.)
      // 3) neighborhood-level reverse geocode
      // 4) city-level reverse geocode
      debug('geocoding', 'Starting reverse geocoding')

      const scoreResult = (result: any): number => {
        if (!result) return 0
        const category = String(result.category || '').toLowerCase()
        const type = String(result.type || '').toLowerCase()
        const address = result.address || {}
        const hasName = Boolean(result.name || result.namedetails?.['name:en'] || result.namedetails?.name)

        let score = 0
        if (category === 'leisure' && type === 'park') score += 100
        else if (category === 'boundary' && type === 'protected_area') score += 95
        else if (category === 'natural') score += 80
        else if (category === 'waterway') score += 72
        else if (category === 'place' && ['suburb', 'neighbourhood', 'village', 'town'].includes(type)) score += 60
        else if (category === 'boundary' && type === 'administrative') score += 45

        if (hasName) score += 5
        if (address.city || address.town || address.village || address.county) score += 5
        return Math.min(score, 100)
      }

      const fetchNearbyNaturePlace = async (): Promise<any | null> => {
        const deltas = [0.02]
        const queries = ['park']
        const EARLY_EXIT_SCORE = 90
        let best: any | null = null
        let bestScore = 0

        for (const delta of deltas) {
          const left = (lon - delta).toFixed(6)
          const right = (lon + delta).toFixed(6)
          const top = (lat + delta).toFixed(6)
          const bottom = (lat - delta).toFixed(6)

          for (const q of queries) {
            const url = new URL('https://nominatim.openstreetmap.org/search')
            url.searchParams.set('format', 'jsonv2')
            url.searchParams.set('q', q)
            url.searchParams.set('addressdetails', '1')
            url.searchParams.set('namedetails', '1')
            url.searchParams.set('accept-language', 'en')
            url.searchParams.set('bounded', '1')
            url.searchParams.set('limit', '5')
            url.searchParams.set('viewbox', `${left},${top},${right},${bottom}`)

            const res = await fetch(url.toString())
            if (!res.ok) throw new Error(`Nominatim ${res.status}`)

            const results = await res.json()
            if (!Array.isArray(results) || results.length === 0) continue

            for (const item of results) {
              const itemScore = scoreResult(item)
              if (itemScore > bestScore) {
                best = item
                bestScore = itemScore
              }
              if (itemScore >= EARLY_EXIT_SCORE) return item
            }
          }
        }

        return best
      }

      const fetchReverse = async (params: Record<string, string>): Promise<any | null> => {
        const url = new URL('https://nominatim.openstreetmap.org/reverse')
        url.searchParams.set('lat', String(lat))
        url.searchParams.set('lon', String(lon))
        url.searchParams.set('format', 'jsonv2')
        url.searchParams.set('addressdetails', '1')
        url.searchParams.set('namedetails', '1')
        url.searchParams.set('accept-language', 'en')
        Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))

        const res = await fetch(url.toString())
        if (!res.ok) throw new Error(`Nominatim ${res.status}`)
        return res.json()
      }

      const formatLabel = (result: any): string => {
        if (!result) return ''
        const englishName =
          result.namedetails?.['name:en'] ||
          result.namedetails?.name
        const address = result.address || {}
        const primary =
          englishName ||
          result.name ||
          address.park ||
          address.nature_reserve ||
          address.recreation_ground ||
          address.leisure ||
          address.tourism ||
          address.amenity ||
          address.neighbourhood ||
          address.suburb ||
          address.village ||
          address.town ||
          address.city ||
          address.county ||
          address.state

        const locality =
          address.neighbourhood ||
          address.suburb ||
          address.village ||
          address.town ||
          address.city ||
          address.county

        const parts = [primary, locality, address.state]
          .filter((v, idx, arr) => !!v && arr.indexOf(v) === idx)
          .slice(0, 3)

        return parts.join(', ')
      }

      const naturePoiResult = await fetchNearbyNaturePlace()
      const naturePoiScore = scoreResult(naturePoiResult)
      let name = naturePoiScore >= 60 ? formatLabel(naturePoiResult) : ''
      let sourceResult: any = naturePoiScore >= 60 ? naturePoiResult : null

      if (!name) {
        const naturalResult = await fetchReverse({ layer: 'natural', zoom: '15' })
        const naturalScore = scoreResult(naturalResult)
        if (naturalScore >= 60) {
          name = formatLabel(naturalResult)
          sourceResult = naturalResult
        }
      }

      if (!name) {
        const neighborhoodResult = await fetchReverse({ layer: 'address', zoom: '14' })
        name = formatLabel(neighborhoodResult)
        sourceResult = neighborhoodResult
      }

      if (!name) {
        const cityResult = await fetchReverse({ layer: 'address', zoom: '10' })
        name = formatLabel(cityResult)
        sourceResult = cityResult
      }

      if (!name) throw new Error('No location name returned')
      
      debug('geocoding', 'Location identified')
      setSuggestedLocation(name)
      setLocationName(name)
      const region = extractRegionCodes(sourceResult)
      setInferredStateProvince(region.stateProvince)
      setInferredCountryCode(region.countryCode)
    } catch (error) {
      debug('geocoding', 'Reverse geocoding failed')
      toast.warning('Could not look up location name, using coordinates instead')
      // Fall back to default location or coordinate string
      const fallback = defaultLocationNameRef.current || `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`
      debug('geocoding', 'Using location fallback')
      setSuggestedLocation(fallback)
      setLocationName(fallback)
      setInferredStateProvince(undefined)
      setInferredCountryCode(undefined)
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

  const searchPlace = useCallback(async (query: string) => {
    if (!query.trim()) return
    searchAbortRef.current?.abort()
    const controller = new AbortController()
    searchAbortRef.current = controller
    setIsSearchingPlace(true)
    try {
      const url = new URL('https://nominatim.openstreetmap.org/search')
      url.searchParams.set('format', 'jsonv2')
      url.searchParams.set('q', query)
      url.searchParams.set('limit', '5')
      url.searchParams.set('addressdetails', '1')
      url.searchParams.set('accept-language', 'en')
      const res = await fetch(url.toString(), { signal: controller.signal })
      if (!res.ok) throw new Error(`Nominatim ${res.status}`)
      const results = await res.json()
      if (!controller.signal.aborted) setPlaceResults(results)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      debug('geocoding', 'Place search failed')
      toast.error('Place search failed')
    } finally {
      if (!controller.signal.aborted) setIsSearchingPlace(false)
    }
  }, [])

  const selectPlace = (place: { place_id: number; display_name: string; lat: string; lon: string; address?: Record<string, string> }) => {
    searchAbortRef.current?.abort()
    setIsSearchingPlace(false)
    const lat = parseFloat(place.lat)
    const lon = parseFloat(place.lon)
    setOverriddenCoords({ lat, lon })
    // Use the first part of the display name as location name
    const shortName = place.display_name.split(',').slice(0, 3).join(',').trim()
    setLocationName(shortName)
    const region = extractRegionCodes(place)
    setInferredStateProvince(region.stateProvince)
    setInferredCountryCode(region.countryCode)
    setPlaceResults([])
    setIsEditingLocation(false)
    setLocationSearchQuery('')
  }

  // Debounced place search: trigger Nominatim when user types in search field
  useEffect(() => {
    if (!locationSearchQuery.trim() || locationSearchQuery.trim().length < 3) {
      searchAbortRef.current?.abort()
      setIsSearchingPlace(false)
      setPlaceResults([])
      return
    }
    const timer = setTimeout(() => {
      void searchPlace(locationSearchQuery)
    }, 500)
    return () => {
      clearTimeout(timer)
      searchAbortRef.current?.abort()
    }
  }, [locationSearchQuery, searchPlace])


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
                <Input
                  id="location-name"
                  autoFocus
                  placeholder="Search for a place..."
                  value={locationSearchQuery}
                  onChange={e => setLocationSearchQuery(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && locationSearchQuery.trim()) {
                      setLocationName(locationSearchQuery.trim())
                      setOverriddenCoords(null)
                      setInferredStateProvince(undefined)
                      setInferredCountryCode(undefined)
                      setIsEditingLocation(false)
                      setLocationSearchQuery('')
                      setPlaceResults([])
                    }
                    if (e.key === 'Escape') {
                      setIsEditingLocation(false)
                      setLocationSearchQuery('')
                      setPlaceResults([])
                    }
                  }}
                />
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
                        key={place.place_id}
                        className="w-full text-left px-3 py-2 text-xs hover:bg-accent/50 active:bg-accent transition-colors"
                        onClick={() => selectPlace(place)}
                      >
                        {place.display_name}
                      </button>
                    ))}
                  </div>
                )}
                {suggestedLocation && locationSearchQuery && suggestedLocation !== locationName && (
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    onClick={() => {
                      setLocationName(suggestedLocation)
                      setOverriddenCoords(null)
                      setInferredStateProvince(undefined)
                      setInferredCountryCode(undefined)
                      setIsEditingLocation(false)
                      setLocationSearchQuery('')
                      setPlaceResults([])
                    }}
                  >
                    Use GPS: {suggestedLocation}
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
          </div>
          )}

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
