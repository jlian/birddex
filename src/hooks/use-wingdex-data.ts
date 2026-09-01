import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Photo, Outing, Observation, DexEntry } from '@/lib/types'
import { getUserStorageKey } from '@/lib/storage-keys'
import { fetchWithLocalAuthRetry, isLocalRuntime } from '@/lib/local-auth-fetch'
import { assertWingDexApiResponse } from '@/lib/api-error'
import { logClientFailure } from '@/lib/client-log'
import {
  getLoadedTaxonMetadataByCode,
  getTaxonMetadataByCode,
  resolveSpeciesIdentity,
} from '@/lib/taxonomy-order'

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

export function publishPayload<T>(ref: { current: T }, next: T, publish: (value: T) => void): void {
  ref.current = next
  publish(next)
}

/**
 * Local-mode equivalent of DEX_QUERY. Exported for tests: it has to agree with
 * the server grouping or a species merges one way offline and splits the other.
 */
export function rebuildDexFromState(
  allOutings: Outing[],
  allObservations: Observation[],
  existingDex: DexEntry[]
): DexEntry[] {
  const outingsById = new Map(allOutings.map(outing => [outing.id, outing]))
  // Keyed by the grouping key, not the display label. MIN(speciesName) can
  // change while the group's identity does not: adding a spelling that sorts
  // earlier relabels the group, and a name lookup would then miss, resetting
  // addedDate to now and dropping notes, bestPhotoId and the cached wiki data.
  // Older local payloads predate `id`, so fall back to the name for those.
  const existingByKey = new Map(existingDex.map(entry => [entry.id ?? `name:${entry.speciesName}`, entry]))
  const existingBySpecies = new Map(existingDex.map(entry => [entry.speciesName, entry]))
  const grouped = new Map<string, Observation[]>()

  // Same grouping key as DEX_QUERY on the server: the eBird code when the
  // observation has one, the display name when it does not, in separate
  // namespaces. Local mode has to agree with the server or a species would
  // merge in one and split in the other.
  for (const observation of allObservations) {
    if (observation.certainty !== 'confirmed' && observation.certainty !== 'possible') continue
    const key = observation.speciesCode
      ? `code:${observation.speciesCode}`
      : `name:${observation.speciesName}`
    const list = grouped.get(key)
    if (list) {
      list.push(observation)
    } else {
      grouped.set(key, [observation])
    }
  }

  const rebuilt: DexEntry[] = []

  for (const [groupKey, speciesObservations] of grouped.entries()) {
    const speciesOutings = speciesObservations
      .map(observation => outingsById.get(observation.outingId))
      .filter((outing): outing is Outing => !!outing)

    if (speciesOutings.length === 0) continue

    // Mirrors MIN(speciesName) in DEX_QUERY. Rows sharing a code are the same
    // bird spelled differently, so any is correct; the smallest is stable.
    const selectedObservation = speciesObservations.reduce((minimum, observation) =>
      observation.speciesName < minimum.speciesName ? observation : minimum
    )
    const speciesName = selectedObservation.speciesName
    const speciesCode = speciesObservations.find(o => o.speciesCode)?.speciesCode
    const taxonCodes = new Set(speciesObservations.map(observation => observation.taxonCode ?? ''))
    const unanimousTaxonCode = taxonCodes.size === 1 ? selectedObservation.taxonCode : undefined
    const taxonCode = unanimousTaxonCode ?? speciesCode
    const metadata = taxonCode ? getLoadedTaxonMetadataByCode(taxonCode) : undefined

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
    const existing = existingByKey.get(groupKey) ?? existingBySpecies.get(speciesName)
    const latestWithPhoto = [...speciesObservations].reverse().find(observation => observation.representativePhotoId)

    rebuilt.push({
      // The same key this group was collected under, which is what DEX_QUERY
      // now returns as `id`. Local and server dexes must agree on identity or a
      // row would key one way offline and another way after a sync.
      id: groupKey,
      speciesName,
      ...(speciesCode ? { speciesCode } : {}),
      ...(taxonCode ? { taxonCode } : {}),
      commonName: metadata?.commonName ?? existing?.commonName,
      scientificName: metadata?.scientificName ?? existing?.scientificName,
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

async function resolveObservationIdentity(observation: Observation): Promise<Observation> {
  const identity = await resolveSpeciesIdentity(observation.speciesName)
  const { speciesCode: _speciesCode, taxonCode: _taxonCode, ...rest } = observation
  return { ...rest, ...(identity ?? {}) }
}

async function migratePersistedObservationIdentity(observation: Observation): Promise<Observation> {
  const identity = await resolveSpeciesIdentity(observation.speciesName)
  if (!identity) return observation
  const { speciesCode: _speciesCode, taxonCode: _taxonCode, ...rest } = observation
  return { ...rest, ...identity }
}

export async function applyLocalObservationUpdates(
  observation: Observation,
  updates: Partial<Observation>,
): Promise<Observation> {
  const updated = { ...observation, ...updates }
  return typeof updates.speciesName === 'string'
    ? resolveObservationIdentity(updated)
    : updated
}

async function resolveLocalUpdates(updates: Partial<Observation>): Promise<Partial<Observation>> {
  if (typeof updates.speciesName !== 'string') return updates
  const identity = await resolveSpeciesIdentity(updates.speciesName)
  return {
    ...updates,
    speciesCode: identity?.speciesCode,
    taxonCode: identity?.taxonCode,
  }
}

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

export async function enrichLocalDex(payload: WingDexPayload): Promise<WingDexPayload> {
  const observations = await Promise.all(payload.observations.map(migratePersistedObservationIdentity))
  const rebuiltFromObservations = rebuildDexFromState(payload.outings, observations, payload.dex)
  const rebuiltIds = new Set(rebuiltFromObservations.map(entry => entry.id))
  const sourceIds = new Set(payload.observations.flatMap(observation => [
    `name:${observation.speciesName}`,
    ...(observation.speciesCode ? [`code:${observation.speciesCode}`] : []),
  ]))
  const rebuiltDex = [
    ...rebuiltFromObservations,
    ...payload.dex.filter(entry => {
      const id = entry.id ?? (entry.speciesCode ? `code:${entry.speciesCode}` : `name:${entry.speciesName}`)
      return !rebuiltIds.has(id) && !sourceIds.has(id)
    }),
  ]
  const dex = await Promise.all(rebuiltDex.map(async entry => {
    const id = entry.id ?? (entry.speciesCode ? `code:${entry.speciesCode}` : `name:${entry.speciesName}`)
    const code = entry.taxonCode ?? entry.speciesCode
    if (!code) return { ...entry, id }
    const metadata = await getTaxonMetadataByCode(code)
    return metadata ? { ...entry, id, ...metadata } : { ...entry, id }
  }))
  return { ...payload, observations, dex }
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
  const refreshGeneration = useRef(0)
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
    const generation = ++refreshGeneration.current
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
      if (refreshGeneration.current !== generation) return
      setStorageMode('api')
      setPayload({
        outings: next.outings || [],
        photos: next.photos || [],
        observations: next.observations || [],
        dex: next.dex || [],
      })
    } catch {
      if (refreshGeneration.current !== generation) return
      if (isLocalRuntime()) {
        const next = await enrichLocalDex(readLocalData(userId))
        if (refreshGeneration.current !== generation) return
        setStorageMode('local')
        setPayload(next)
        writeLocalData(userId, next)
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
      refreshGeneration.current += 1
    }
  }, [refresh])

  const applyPayload = (next: WingDexPayload) => {
    publishPayload(payloadRef, next, setPayload)
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

  const addObservations = async (newObservations: Observation[]): Promise<Observation[]> => {
    if (newObservations.length === 0) return []

    const preparedObservations = await Promise.all(newObservations.map(resolveObservationIdentity))

    const previousObservations = payloadRef.current.observations
    const newIds = new Set(preparedObservations.map(observation => observation.id))
    const optimistic: WingDexPayload = {
      ...payloadRef.current,
      observations: [
        ...payloadRef.current.observations.filter(observation => !newIds.has(observation.id)),
        ...preparedObservations,
      ],
    }
    applyPayload(optimistic)

    if (storageMode === 'api') {
      try {
        const response = await apiJson<{ observations: Observation[]; dexUpdates: DexEntry[] }>('/api/data/observations', {
          method: 'POST',
          body: JSON.stringify(preparedObservations),
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
        return response.observations || preparedObservations
      } catch (err) {
        logClientFailure('data/observations/write', err, { count: newObservations.length })
        setPayload(current => ({
          ...current,
          observations: rollbackItemsById(current.observations, previousObservations, newIds),
        }))
        throw err
      }
    }
    return preparedObservations
  }

  const updateObservation = async (observationId: string, updates: Partial<Observation>) => {
    const localUpdates = storageMode === 'local' ? await resolveLocalUpdates(updates) : undefined
    const optimistic: WingDexPayload = {
      ...payloadRef.current,
      observations: payloadRef.current.observations.map(observation =>
        observation.id === observationId ? { ...observation, ...(localUpdates ?? updates) } : observation
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

  const bulkUpdateObservations = async (ids: string[], updates: Partial<Observation>) => {
    if (ids.length === 0) return

    const idSet = new Set(ids)
    const localUpdates = storageMode === 'local' ? await resolveLocalUpdates(updates) : undefined
    const optimistic: WingDexPayload = {
      ...payloadRef.current,
      observations: payloadRef.current.observations.map(observation =>
        idSet.has(observation.id)
          ? { ...observation, ...(localUpdates ?? updates) }
          : observation
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

    const incomingAccepted = confirmedObservations.filter(
      obs => obs.certainty === 'confirmed' || obs.certainty === 'possible'
    )
    if (incomingAccepted.length === 0) return { newSpeciesCount: 0 }

    // Compare on the grouping key, matching DEX_QUERY and rebuildDexFromState.
    // Comparing display names would count a bird as new when it arrives under a
    // different spelling of a species already in the dex.
    const dexKey = (row: { speciesName: string; speciesCode?: string }) =>
      row.speciesCode ? `code:${row.speciesCode}` : `name:${row.speciesName}`
    const existingSpecies = new Set(payloadRef.current.dex.map(dexKey))
    const incomingSpecies = new Set(incomingAccepted.map(dexKey))
    const newSpeciesCount = Array.from(incomingSpecies).filter(
      key => !existingSpecies.has(key)
    ).length

    if (storageMode === 'local') {
      const uniqueCombined = new Map<string, Observation>()
      for (const observation of payloadRef.current.observations) {
        uniqueCombined.set(observation.id, observation)
      }
      for (const observation of incomingAccepted) {
        uniqueCombined.set(observation.id, observation)
      }

      const combinedConfirmed = Array.from(uniqueCombined.values()).filter(
        observation => observation.certainty === 'confirmed' || observation.certainty === 'possible'
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

  const dexByKey = useMemo(() =>
    new Map(payload.dex.map(entry => [entry.id, entry])),
    [payload.dex]
  )
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

  const getDexEntry = (identity: string) => {
    return dexByKey.get(identity) ?? dexBySpecies.get(identity)
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
        groupKey: entry.id,
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
