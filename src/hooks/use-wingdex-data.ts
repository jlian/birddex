import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Photo, Outing, Observation, DexEntry } from '@/lib/types'
import { getUserStorageKey } from '@/lib/storage-keys'
import { fetchWithLocalAuthRetry, isLocalRuntime } from '@/lib/local-auth-fetch'
import { assertWingDexApiResponse } from '@/lib/api-error'
import { logClientFailure } from '@/lib/client-log'

export type WingDexDataStore = ReturnType<typeof useWingDexData>

type WingDexPayload = {
  outings: Outing[]
  photos: Photo[]
  observations: Observation[]
  dex: DexEntry[]
}

type StorageMode = 'api' | 'local'

export function rollbackItemsById<T extends { id: string }>(
  current: T[],
  previous: T[],
  touchedIds: Set<string>,
): T[] {
  const previousById = new Map(previous.map(item => [item.id, item]))
  const result = current.flatMap(item => {
    if (!touchedIds.has(item.id)) return [item]
    const prior = previousById.get(item.id)
    return prior ? [prior] : []
  })
  const resultIds = new Set(result.map(item => item.id))
  for (const item of previous) {
    if (touchedIds.has(item.id) && !resultIds.has(item.id)) {
      result.push(item)
    }
  }
  return result
}

function rebuildDexFromState(
  allOutings: Outing[],
  allObservations: Observation[],
  existingDex: DexEntry[]
): DexEntry[] {
  const outingsById = new Map(allOutings.map(outing => [outing.id, outing]))
  const existingBySpecies = new Map(existingDex.map(entry => [entry.speciesName, entry]))
  const grouped = new Map<string, Observation[]>()

  for (const observation of allObservations) {
    if (observation.certainty !== 'confirmed') continue
    const list = grouped.get(observation.speciesName)
    if (list) {
      list.push(observation)
    } else {
      grouped.set(observation.speciesName, [observation])
    }
  }

  const rebuilt: DexEntry[] = []

  for (const [speciesName, speciesObservations] of grouped.entries()) {
    const speciesOutings = speciesObservations
      .map(observation => outingsById.get(observation.outingId))
      .filter((outing): outing is Outing => !!outing)

    if (speciesOutings.length === 0) continue

    const firstSeen = speciesOutings.reduce((min, currentOuting) =>
      new Date(currentOuting.startTime) < new Date(min.startTime)
        ? currentOuting
        : min
    )
    const lastSeen = speciesOutings.reduce((max, currentOuting) =>
      new Date(currentOuting.startTime) > new Date(max.startTime)
        ? currentOuting
        : max
    )

    const totalCount = speciesObservations.reduce((sum, observation) => sum + observation.count, 0)
    const totalOutings = new Set(speciesObservations.map(observation => observation.outingId)).size
    const existing = existingBySpecies.get(speciesName)
    const latestWithPhoto = [...speciesObservations].reverse().find(observation => observation.representativePhotoId)

    rebuilt.push({
      speciesName,
      firstSeenDate: firstSeen.startTime,
      lastSeenDate: lastSeen.startTime,
      addedDate: existing?.addedDate || new Date().toISOString(),
      totalOutings,
      totalCount,
      bestPhotoId: latestWithPhoto?.representativePhotoId || existing?.bestPhotoId,
      notes: existing?.notes || '',
      wikiTitle: existing?.wikiTitle,
      thumbnailUrl: existing?.thumbnailUrl,
    })
  }

  return rebuilt.sort((a, b) => a.speciesName.localeCompare(b.speciesName))
}

export const buildDexFromState = rebuildDexFromState

function readLocalData(userId: string): WingDexPayload {
  if (!isLocalRuntime() || typeof window === 'undefined' || !window.localStorage) {
    return { outings: [], photos: [], observations: [], dex: [] }
  }

  const read = <T>(suffix: 'outings' | 'photos' | 'observations' | 'dex'): T[] => {
    const key = getUserStorageKey(userId, suffix)
    const raw = window.localStorage.getItem(key)
    if (!raw) return []

    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as T[]) : []
    } catch {
      return []
    }
  }

  return {
    outings: read<Outing>('outings'),
    photos: read<Photo>('photos'),
    observations: read<Observation>('observations'),
    dex: read<DexEntry>('dex'),
  }
}

function writeLocalData(userId: string, payload: WingDexPayload) {
  if (!isLocalRuntime() || typeof window === 'undefined' || !window.localStorage) return

  window.localStorage.setItem(getUserStorageKey(userId, 'outings'), JSON.stringify(payload.outings))
  window.localStorage.setItem(getUserStorageKey(userId, 'photos'), JSON.stringify(payload.photos))
  window.localStorage.setItem(getUserStorageKey(userId, 'observations'), JSON.stringify(payload.observations))
  window.localStorage.setItem(getUserStorageKey(userId, 'dex'), JSON.stringify(payload.dex))
}

async function apiJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetchWithLocalAuthRetry(input, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
    ...init,
  })

  await assertWingDexApiResponse(response)

  return response.json() as Promise<T>
}

export function useWingDexData(userId: string, { hasSession = true }: { hasSession?: boolean } = {}) {
  const [isLoading, setIsLoading] = useState(true)
  const [storageMode, setStorageMode] = useState<StorageMode>('api')
  const [payload, setPayload] = useState<WingDexPayload>({
    outings: [],
    photos: [],
    observations: [],
    dex: [],
  })

  const payloadRef = useRef(payload)
  useEffect(() => {
    payloadRef.current = payload
  }, [payload])

  useEffect(() => {
    if (isLocalRuntime() || typeof window === 'undefined' || !window.localStorage) {
      return
    }

    try {
      const photosKey = getUserStorageKey(userId, 'photos')
      window.localStorage.removeItem(photosKey)
      window.localStorage.removeItem(`wingdex_kv_${photosKey}`)
    } catch {
      // Ignore storage errors in hosted mode cleanup
    }
  }, [userId])

  const refresh = useCallback(async () => {
    // A guest has no session yet, so this request can only 401. Skipping it keeps
    // the console clean and avoids a pointless round trip; the effect below re-runs
    // once an account exists, because `hasSession` and `userId` both change then.
    //
    // Clearing rather than returning: signing out must not leave the previous
    // account's sightings on screen until the next reload.
    if (!hasSession) {
      setPayload({ outings: [], photos: [], observations: [], dex: [] })
      return
    }
    try {
      const next = await apiJson<WingDexPayload>('/api/data/all')
      setStorageMode('api')
      setPayload({
        outings: next.outings || [],
        photos: next.photos || [],
        observations: next.observations || [],
        dex: next.dex || [],
      })
    } catch {
      if (isLocalRuntime()) {
        setStorageMode('local')
        setPayload(readLocalData(userId))
      }
    }
  }, [userId, hasSession])

  useEffect(() => {
    let cancelled = false

    setIsLoading(true)
    void refresh().finally(() => {
      if (!cancelled) {
        setIsLoading(false)
      }
    })

    return () => {
      cancelled = true
    }
  }, [refresh])

  const applyPayload = (next: WingDexPayload) => {
    setPayload(next)
    if (storageMode === 'local') {
      writeLocalData(userId, next)
    }
  }

  const applyDexUpdates = (dexUpdates: DexEntry[] | undefined) => {
    if (!dexUpdates) return
    setPayload(current => {
      const next = { ...current, dex: dexUpdates }
      if (storageMode === 'local') {
        writeLocalData(userId, next)
      }
      return next
    })
  }

  const addPhotos = async (newPhotos: Photo[]): Promise<void> => {
    if (newPhotos.length === 0) return

    const previousPhotos = payloadRef.current.photos
    const newIds = new Set(newPhotos.map(photo => photo.id))
    const optimistic: WingDexPayload = {
      ...payloadRef.current,
      photos: [...payloadRef.current.photos.filter(photo => !newIds.has(photo.id)), ...newPhotos],
    }
    applyPayload(optimistic)

    if (storageMode === 'api') {
      const requestBody = newPhotos.map(photo => ({
        id: photo.id,
        outingId: photo.outingId,
        exifTime: photo.exifTime,
        gps: photo.gps,
        fileHash: photo.fileHash,
        fileName: photo.fileName,
      }))

      const postPhotos = () =>
        apiJson<Photo[]>('/api/data/photos', {
          method: 'POST',
          body: JSON.stringify(requestBody),
        })

      try {
        await postPhotos()
      } catch (err) {
        logClientFailure('data/photos/write', err, { count: requestBody.length, willRetry: true })
        await new Promise(resolve => window.setTimeout(resolve, 600))
        try {
          await postPhotos()
        } catch (retryErr) {
          logClientFailure('data/photos/write', retryErr, { count: requestBody.length, retried: true })
          setPayload(current => ({
            ...current,
            photos: rollbackItemsById(current.photos, previousPhotos, newIds),
          }))
          throw retryErr
        }
      }
    }
  }

  const addOuting = async (outing: Outing): Promise<void> => {
    const previousOutings = payloadRef.current.outings
    const optimistic: WingDexPayload = {
      ...payloadRef.current,
      outings: [outing, ...payloadRef.current.outings.filter(item => item.id !== outing.id)],
    }
    applyPayload(optimistic)

    if (storageMode === 'api') {
      try {
        const savedOuting = await apiJson<Outing>('/api/data/outings', {
          method: 'POST',
          body: JSON.stringify(outing),
        })
        setPayload(current => {
          const alreadyPresent = current.outings.some(item => item.id === savedOuting.id)
          return {
            ...current,
            outings: alreadyPresent
              ? current.outings.map(item => (item.id === savedOuting.id ? savedOuting : item))
              : [savedOuting, ...current.outings],
          }
        })
      } catch (err) {
        logClientFailure('data/outings/write', err, { outingId: outing.id })
        setPayload(current => ({
          ...current,
          outings: rollbackItemsById(current.outings, previousOutings, new Set([outing.id])),
        }))
        throw err
      }
    }
  }

  const updateOuting = (outingId: string, updates: Partial<Outing>) => {
    const optimistic: WingDexPayload = {
      ...payloadRef.current,
      outings: payloadRef.current.outings.map(outing =>
        outing.id === outingId ? { ...outing, ...updates } : outing
      ),
    }
    applyPayload(optimistic)

    if (storageMode === 'api') {
      void apiJson<Outing>(`/api/data/outings/${outingId}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      })
        .then(savedOuting => {
          setPayload(current => {
            const alreadyPresent = current.outings.some(outing => outing.id === outingId)
            return {
              ...current,
              outings: alreadyPresent
                ? current.outings.map(outing => (outing.id === outingId ? savedOuting : outing))
                : [savedOuting, ...current.outings],
            }
          })
        })
        .catch(err => logClientFailure('data/outings/write', err, { outingId }))
    }
  }

  const deleteOuting = (outingId: string) => {
    const remainingOutings = payloadRef.current.outings.filter(outing => outing.id !== outingId)
    const remainingObservations = payloadRef.current.observations.filter(
      observation => observation.outingId !== outingId
    )
    const remainingPhotos = payloadRef.current.photos.filter(photo => photo.outingId !== outingId)
    const optimistic: WingDexPayload = {
      outings: remainingOutings,
      photos: remainingPhotos,
      observations: remainingObservations,
      dex: rebuildDexFromState(remainingOutings, remainingObservations, payloadRef.current.dex),
    }

    applyPayload(optimistic)

    if (storageMode === 'api') {
      void apiJson<{ dexUpdates: DexEntry[] }>(`/api/data/outings/${outingId}`, { method: 'DELETE' })
        .then(response => applyDexUpdates(response.dexUpdates))
        .catch(err => logClientFailure('data/outings/delete', err, { outingId }))
    }
  }

  const addObservations = async (newObservations: Observation[]): Promise<void> => {
    if (newObservations.length === 0) return

    const previousObservations = payloadRef.current.observations
    const newIds = new Set(newObservations.map(observation => observation.id))
    const optimistic: WingDexPayload = {
      ...payloadRef.current,
      observations: [
        ...payloadRef.current.observations.filter(observation => !newIds.has(observation.id)),
        ...newObservations,
      ],
    }
    applyPayload(optimistic)

    if (storageMode === 'api') {
      try {
        const response = await apiJson<{ observations: Observation[]; dexUpdates: DexEntry[] }>('/api/data/observations', {
          method: 'POST',
          body: JSON.stringify(newObservations),
        })
        setPayload(current => {
          const byId = new Map(current.observations.map(observation => [observation.id, observation]))
          for (const observation of response.observations || []) {
            byId.set(observation.id, observation)
          }
          return {
            ...current,
            observations: Array.from(byId.values()),
            dex: response.dexUpdates || current.dex,
          }
        })
      } catch (err) {
        logClientFailure('data/observations/write', err, { count: newObservations.length })
        setPayload(current => ({
          ...current,
          observations: rollbackItemsById(current.observations, previousObservations, newIds),
        }))
        throw err
      }
    }
  }

  const updateObservation = (observationId: string, updates: Partial<Observation>) => {
    const optimistic: WingDexPayload = {
      ...payloadRef.current,
      observations: payloadRef.current.observations.map(observation =>
        observation.id === observationId ? { ...observation, ...updates } : observation
      ),
    }

    if (storageMode === 'local') {
      optimistic.dex = rebuildDexFromState(optimistic.outings, optimistic.observations, optimistic.dex)
    }

    applyPayload(optimistic)

    if (storageMode === 'api') {
      void apiJson<{ observation?: Observation; dexUpdates: DexEntry[] }>('/api/data/observations', {
        method: 'PATCH',
        body: JSON.stringify({ id: observationId, ...updates }),
      })
        .then(response => {
          setPayload(current => {
            const nextObservations = response.observation
              ? (() => {
                  const resolved = response.observation as Observation
                  const alreadyPresent = current.observations.some(observation => observation.id === observationId)
                  return alreadyPresent
                    ? current.observations.map(observation =>
                        observation.id === observationId ? resolved : observation
                      )
                    : [...current.observations, resolved]
                })()
              : current.observations

            return {
              ...current,
              observations: nextObservations,
              dex: response.dexUpdates || current.dex,
            }
          })
        })
        .catch(err => logClientFailure('data/observations/write', err, { observationId }))
    }
  }

  const bulkUpdateObservations = (ids: string[], updates: Partial<Observation>) => {
    if (ids.length === 0) return

    const idSet = new Set(ids)
    const optimistic: WingDexPayload = {
      ...payloadRef.current,
      observations: payloadRef.current.observations.map(observation =>
        idSet.has(observation.id) ? { ...observation, ...updates } : observation
      ),
    }

    if (storageMode === 'local') {
      optimistic.dex = rebuildDexFromState(optimistic.outings, optimistic.observations, optimistic.dex)
    }

    applyPayload(optimistic)

    if (storageMode === 'api') {
      void apiJson<{ observations?: Observation[]; dexUpdates: DexEntry[] }>('/api/data/observations', {
        method: 'PATCH',
        body: JSON.stringify({ ids, patch: updates }),
      })
        .then(response => {
          setPayload(current => {
            const updatesById = new Map((response.observations || []).map(observation => [observation.id, observation]))
            const nextObservations = [
              ...current.observations.map(observation => updatesById.get(observation.id) || observation),
              ...(response.observations || []).filter(
                observation => !current.observations.some(existing => existing.id === observation.id)
              ),
            ]

            return {
              ...current,
              observations: nextObservations,
              dex: response.dexUpdates || current.dex,
            }
          })
        })
        .catch(err => logClientFailure('data/observations/write', err, { count: ids.length }))
    }
  }

  const updateDex = (
    outingId: string,
    confirmedObservations: Observation[]
  ): { newSpeciesCount: number } => {
    const outing = payloadRef.current.outings.find(currentOuting => currentOuting.id === outingId)
    if (!outing) return { newSpeciesCount: 0 }

    const incomingConfirmed = confirmedObservations.filter(
      obs => obs.certainty === 'confirmed'
    )
    if (incomingConfirmed.length === 0) return { newSpeciesCount: 0 }

    const existingSpecies = new Set(payloadRef.current.dex.map(entry => entry.speciesName))
    const incomingSpecies = new Set(incomingConfirmed.map(obs => obs.speciesName))
    const newSpeciesCount = Array.from(incomingSpecies).filter(
      speciesName => !existingSpecies.has(speciesName)
    ).length

    if (storageMode === 'local') {
      const uniqueCombined = new Map<string, Observation>()
      for (const observation of payloadRef.current.observations) {
        uniqueCombined.set(observation.id, observation)
      }
      for (const observation of incomingConfirmed) {
        uniqueCombined.set(observation.id, observation)
      }

      const combinedConfirmed = Array.from(uniqueCombined.values()).filter(
        observation => observation.certainty === 'confirmed'
      )
      const recomputedDex = rebuildDexFromState(payloadRef.current.outings, combinedConfirmed, payloadRef.current.dex)
      applyPayload({
        ...payloadRef.current,
        dex: recomputedDex,
      })
    }

    return { newSpeciesCount }
  }

  const observationsByOuting = useMemo(() => {
    const map = new Map<string, Observation[]>()
    for (const obs of payload.observations) {
      const list = map.get(obs.outingId)
      if (list) list.push(obs)
      else map.set(obs.outingId, [obs])
    }
    return map
  }, [payload.observations])

  const photosByOuting = useMemo(() => {
    const map = new Map<string, Photo[]>()
    for (const photo of payload.photos) {
      const list = map.get(photo.outingId)
      if (list) list.push(photo)
      else map.set(photo.outingId, [photo])
    }
    return map
  }, [payload.photos])

  const dexBySpecies = useMemo(() =>
    new Map(payload.dex.map(entry => [entry.speciesName, entry])),
    [payload.dex]
  )

  const getOutingObservations = (outingId: string) => {
    return observationsByOuting.get(outingId) ?? []
  }

  const getOutingPhotos = (outingId: string) => {
    return photosByOuting.get(outingId) ?? []
  }

  const getDexEntry = (speciesName: string) => {
    return dexBySpecies.get(speciesName)
  }

  const importDexEntries = (entries: DexEntry[]) => {
    const updated = new Map(payloadRef.current.dex.map(entry => [entry.speciesName, entry]))

    entries.forEach(entry => {
      const existing = updated.get(entry.speciesName)

      if (existing) {
        const existingFirst = new Date(existing.firstSeenDate)
        const existingLast = new Date(existing.lastSeenDate)
        const entryFirst = new Date(entry.firstSeenDate)
        const entryLast = new Date(entry.lastSeenDate)

        updated.set(entry.speciesName, {
          ...existing,
          firstSeenDate:
            entryFirst < existingFirst
              ? entry.firstSeenDate
              : existing.firstSeenDate,
          lastSeenDate:
            entryLast > existingLast ? entry.lastSeenDate : existing.lastSeenDate,
          totalOutings: existing.totalOutings + entry.totalOutings,
          totalCount: existing.totalCount + entry.totalCount
        })
      } else {
        updated.set(entry.speciesName, entry)
      }
    })

    const optimisticDex = Array.from(updated.values()).sort((a, b) =>
      a.speciesName.localeCompare(b.speciesName)
    )
    applyPayload({
      ...payloadRef.current,
      dex: optimisticDex,
    })

    if (storageMode === 'api') {
      const patches = entries.map(entry => ({
        speciesName: entry.speciesName,
        addedDate: entry.addedDate,
        bestPhotoId: entry.bestPhotoId,
        notes: entry.notes,
      }))

      void apiJson<{ dexUpdates: DexEntry[] }>('/api/data/dex', {
        method: 'PATCH',
        body: JSON.stringify(patches),
      })
        .then(response => applyDexUpdates(response.dexUpdates))
        .catch(err => logClientFailure('data/dex/write', err, { count: patches.length }))
    }
  }

  const clearAllData = () => {
    const next: WingDexPayload = {
      outings: [],
      photos: [],
      observations: [],
      dex: [],
    }
    applyPayload(next)

    if (storageMode === 'api') {
      void apiJson<{ cleared: boolean }>('/api/data/clear', { method: 'DELETE' })
        .catch(err => logClientFailure('data/clear/delete', err))
    }

    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        const legacySavedSpotsKey = getUserStorageKey(userId, 'savedSpots')
        window.localStorage.removeItem(legacySavedSpotsKey)
      } catch {
        // Ignore storage errors; primary data has already been cleared
      }
    }
  }

  const store = useMemo(() => ({
    isLoading,
    photos: payload.photos,
    outings: payload.outings,
    observations: payload.observations,
    dex: payload.dex,
    addPhotos,
    addOuting,
    updateOuting,
    deleteOuting,
    addObservations,
    updateObservation,
    bulkUpdateObservations,
    updateDex,
    getOutingObservations,
    getOutingPhotos,
    getDexEntry,
    importDexEntries,
    clearAllData,
    refresh,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mutation fns close over refs, not state; intentionally omitted
  }), [isLoading, payload, refresh])

  return store
}
