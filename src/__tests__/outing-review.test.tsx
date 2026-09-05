import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import OutingReview from '@/components/flows/OutingReview'
import type { WingDexDataStore } from '@/hooks/use-wingdex-data'
import type { Outing } from '@/lib/types'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
  },
}))

function createDataStore(): WingDexDataStore {
  return {
    isLoading: false,
    photos: [],
    outings: [],
    observations: [],
    dex: [],
    addPhotos: vi.fn(),
    addOuting: vi.fn(),
    updateOuting: vi.fn(),
    deleteOuting: vi.fn(),
    addObservations: vi.fn(),
    updateObservation: vi.fn(),
    bulkUpdateObservations: vi.fn(),
    updateDex: vi.fn(() => ({ newSpeciesCount: 0 })),
    getOutingObservations: vi.fn(() => []),
    getOutingPhotos: vi.fn(() => []),
    getDexEntry: vi.fn(),
    importDexEntries: vi.fn(),
    clearAllData: vi.fn(),
    refresh: vi.fn(async () => undefined),
  }
}

const previousOuting: Outing = {
  id: 'previous-outing',
  userId: 'user-1',
  locationName: 'Previous Seattle outing',
  startTime: '2025-01-01T12:00:00Z',
  endTime: '2025-01-01T13:00:00Z',
  notes: '',
  createdAt: '2026-08-01T12:00:00Z',
}

describe('OutingReview', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('waits for session readiness before creating an outing', async () => {
    const data = createDataStore()
    let releaseSession: (ready: boolean) => void = () => undefined
    const ensureSessionReady = vi.fn(() => new Promise<boolean>(resolve => {
      releaseSession = resolve
    }))
    const onConfirm = vi.fn(async () => undefined)

    render(
      <OutingReview
        cluster={{
          photos: [],
          startTime: new Date('2026-08-07T12:00:00Z'),
          endTime: new Date('2026-08-07T13:00:00Z'),
        }}
        data={data}
        userId="anonymous-user"
        ensureSessionReady={ensureSessionReady}
        onConfirm={onConfirm}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Continue to Species Identification' }))
    await waitFor(() => expect(ensureSessionReady).toHaveBeenCalledOnce())
    expect(onConfirm).not.toHaveBeenCalled()

    releaseSession(true)
    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce())
    // The outing is handed over, not written: nothing is saved until the cluster has a sighting.
    expect(data.addOuting).not.toHaveBeenCalled()
  })

  it('does not offer a newly created outing as an existing outing while confirming', async () => {
    const data = createDataStore()
    data.addOuting = vi.fn(async (outing: Outing) => {
      data.outings = [outing]
    })

    let finishConfirmation: () => void = () => undefined
    const onConfirm = vi.fn(() => new Promise<void>(resolve => {
      finishConfirmation = resolve
    }))
    const cluster = {
      photos: [],
      startTime: new Date('2026-08-07T12:00:00Z'),
      endTime: new Date('2026-08-07T13:00:00Z'),
    }

    const { rerender } = render(
      <OutingReview
        cluster={cluster}
        data={data}
        userId="user-1"
        onConfirm={onConfirm}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Continue to Species Identification' }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce())

    rerender(
      <OutingReview
        cluster={cluster}
        data={data}
        userId="user-1"
        onConfirm={onConfirm}
      />,
    )

    expect(screen.queryByText('Add to existing outing?')).not.toBeInTheDocument()

    await act(async () => finishConfirmation())
  })

  it('does not restart GPS lookup when rerendering while confirming', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          label: 'Discovery Park, Seattle',
          context: 'Washington',
          lat: 47.6573,
          lon: -122.4055,
          stateProvince: 'US-WA',
          countryCode: 'US',
        },
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const data = createDataStore()
    let finishConfirmation: () => void = () => undefined
    const onConfirm = vi.fn(() => new Promise<void>(resolve => {
      finishConfirmation = resolve
    }))
    const cluster = {
      photos: [],
      startTime: new Date('2026-08-07T12:00:00Z'),
      endTime: new Date('2026-08-07T13:00:00Z'),
      centerLat: 47.6573,
      centerLon: -122.4055,
    }

    const { rerender } = render(
      <OutingReview
        cluster={cluster}
        data={data}
        userId="user-1"
        autoLookupGps
        onConfirm={onConfirm}
      />,
    )

    await screen.findByText('Discovery Park, Seattle')
    expect(fetchMock).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Continue to Species Identification' }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce())

    rerender(
      <OutingReview
        cluster={cluster}
        data={data}
        userId="user-1"
        autoLookupGps
        onConfirm={onConfirm}
      />,
    )

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(screen.queryByText('Identifying location from GPS...')).not.toBeInTheDocument()

    await act(async () => finishConfirmation())
  })

  it('searches for a place only after explicit submission', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <OutingReview
        cluster={{
          photos: [],
          startTime: new Date('2026-08-07T12:00:00Z'),
          endTime: new Date('2026-08-07T13:00:00Z'),
        }}
        data={createDataStore()}
        userId="user-1"
        onConfirm={vi.fn(async () => undefined)}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Tap to set location' }))
    const searchInput = screen.getByPlaceholderText('Search for a place...')
    fireEvent.change(searchInput, { target: { value: 'Green Lake' } })

    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.submit(searchInput.closest('form')!)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    expect(fetchMock.mock.calls[0][0]).toBe('/api/geocoding/search')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ query: 'Green Lake' }),
    })
  })

  it('cancels an in-flight place search when the query changes', async () => {
    let resolveSearch: (response: Response) => void = () => undefined
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>(resolve => {
        resolveSearch = resolve
        init?.signal?.addEventListener('abort', () => {
          resolveSearch(new Response(JSON.stringify({ results: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }))
        })
      })
    ))
    vi.stubGlobal('fetch', fetchMock)

    render(
      <OutingReview
        cluster={{
          photos: [],
          startTime: new Date('2026-08-07T12:00:00Z'),
          endTime: new Date('2026-08-07T13:00:00Z'),
        }}
        data={createDataStore()}
        userId="user-1"
        onConfirm={vi.fn(async () => undefined)}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Tap to set location' }))
    const searchInput = screen.getByPlaceholderText('Search for a place...')
    fireEvent.change(searchInput, { target: { value: 'Green Lake' } })
    fireEvent.submit(searchInput.closest('form')!)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const signal = fetchMock.mock.calls[0][1]?.signal
    expect(signal?.aborted).toBe(false)

    fireEvent.change(searchInput, { target: { value: 'Lake Union' } })

    expect(signal?.aborted).toBe(true)
    expect(screen.getByRole('button', { name: 'Search locations' })).toBeEnabled()
    expect(screen.queryByText('Searching...')).not.toBeInTheDocument()

    resolveSearch(new Response(JSON.stringify({
      results: [{
        label: 'Obsolete result',
        lat: 47.6,
        lon: -122.3,
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    await act(async () => undefined)
    expect(screen.queryByText('Obsolete result')).not.toBeInTheDocument()
  })

  it('always renders static provider attribution, including for manual names', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          label: 'Discovery Park, Seattle',
          lat: 47.6573,
          lon: -122.4055,
        },
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <OutingReview
        cluster={{
          photos: [],
          startTime: new Date('2026-08-07T12:00:00Z'),
          endTime: new Date('2026-08-07T13:00:00Z'),
          centerLat: 47.6573,
          centerLon: -122.4055,
        }}
        data={createDataStore()}
        userId="user-1"
        autoLookupGps
        onConfirm={vi.fn(async () => undefined)}
      />,
    )

    const osm = await screen.findByRole('link', { name: 'OpenStreetMap' })
    expect(osm).toHaveAttribute('href', 'https://www.openstreetmap.org/copyright')
    expect(osm.closest('p')).toHaveTextContent('Powered by Geoapify and OpenStreetMap')
    expect(screen.getByRole('link', { name: 'Geoapify' })).toHaveAttribute(
      'href',
      'https://www.geoapify.com/',
    )
    expect(screen.queryByRole('link', { name: 'GeoNames' })).not.toBeInTheDocument()

    fireEvent.click(await screen.findByRole('button', { name: /Discovery Park, Seattle/ }))
    const searchInput = screen.getByPlaceholderText('Search for a place...')
    fireEvent.change(searchInput, { target: { value: 'My birding spot' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use entered name without searching' }))

    expect(screen.getByRole('link', { name: 'Geoapify' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'OpenStreetMap' })).toBeInTheDocument()
  })

  it('keeps static provider attribution visible when adding to an existing outing', () => {
    const data = createDataStore()
    data.outings = [{
      id: 'outing-1',
      userId: 'user-1',
      locationName: 'Discovery Park',
      startTime: '2026-08-07T12:00:00.000Z',
      endTime: '2026-08-07T13:00:00.000Z',
      notes: '',
      createdAt: '2026-08-07T13:00:00.000Z',
    }]

    render(
      <OutingReview
        cluster={{
          photos: [],
          startTime: new Date('2026-08-07T12:15:00Z'),
          endTime: new Date('2026-08-07T12:45:00Z'),
        }}
        data={data}
        userId="user-1"
        onConfirm={vi.fn(async () => undefined)}
      />,
    )

    expect(screen.getByRole('switch', { name: 'Add to existing outing?' })).toBeChecked()
    expect(screen.getByRole('link', { name: 'Geoapify' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'OpenStreetMap' })).toBeInTheDocument()
  })

  it('shows a compact retry action after a place search failure', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('provider timeout'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    render(
      <OutingReview
        cluster={{
          photos: [],
          startTime: new Date('2026-08-07T12:00:00Z'),
          endTime: new Date('2026-08-07T13:00:00Z'),
        }}
        data={createDataStore()}
        userId="user-1"
        onConfirm={vi.fn(async () => undefined)}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Tap to set location' }))
    const searchInput = screen.getByPlaceholderText('Search for a place...')
    fireEvent.change(searchInput, { target: { value: 'Green Lake' } })
    fireEvent.submit(searchInput.closest('form')!)

    const retry = await screen.findByRole('button', { name: 'Retry' })
    expect(retry.closest('p')).toHaveTextContent('Search failed. Retry')
    fireEvent.click(retry)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('Search failed.')).not.toBeInTheDocument()
  })
})
describe('OutingReview reverse geocoding outcomes', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // The component reads centerLat/centerLon, not per-photo coordinates, and
  // only starts a lookup when both are present.
  const gpsCluster = {
    photos: [],
    startTime: new Date('2026-08-07T12:00:00Z'),
    endTime: new Date('2026-08-07T13:00:00Z'),
    centerLat: 48.9801,
    centerLon: -122.7887,
  } as unknown as Parameters<typeof OutingReview>[0]['cluster']

  /** Stub the reverse-geocoding endpoint with one JSON body. */
  const stubReverse = (body: unknown) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/geocoding/reverse')) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  const renderWithGps = (
    data: WingDexDataStore,
    onConfirm = vi.fn(async () => undefined),
  ) => {
    render(
      <OutingReview
        cluster={gpsCluster}
        data={data}
        userId="user-1"
        autoLookupGps
        onConfirm={onConfirm}
      />,
    )
    return onConfirm
  }

  it('shows the no-retry message and keeps the name editable when nothing is named nearby', async () => {
    // A successful lookup that found no NAMED place. Retrying would return the
    // same nothing, so the UI must not offer a Retry button here.
    const fetchMock = stubReverse({ result: null, nearby: [], regionCodes: {} })
    renderWithGps(createDataStore())

    await waitFor(() => {
      expect(screen.getByText(/No named place found nearby/i)).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument()

    const reverseCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/api/geocoding/reverse'))
    expect(reverseCall).toBeDefined()
    expect(JSON.parse((reverseCall![1] as RequestInit).body as string)).toEqual({
      lat: 48.9801,
      lon: -122.7887,
    })

    // The coordinate string is a usable fallback name. It renders in the
    // name control, which is a button until tapped.
    const nameControl = screen.getByRole('button', { name: /48\.9801/ })
    expect(nameControl).toBeInTheDocument()

    // Tapping it opens a real editable input, so the user is never blocked.
    fireEvent.click(nameControl)
    const field = await screen.findByDisplayValue(/48\.9801/) as HTMLInputElement
    expect(field.readOnly).toBe(false)
  })

  it('keeps region codes from an empty lookup so the eBird export still gets them', async () => {
    // The case this contract exists for: offshore and unmapped land often have
    // a valid ISO code and no named place. The codes must survive onto the
    // saved outing even though `result` is null.
    stubReverse({
      result: null,
      nearby: [],
      regionCodes: { stateProvince: 'US-WA', countryCode: 'US' },
    })
    const data = createDataStore()
    const onConfirm = vi.fn(async () => undefined)
    renderWithGps(data, onConfirm)

    await waitFor(() => {
      expect(screen.getByText(/No named place found nearby/i)).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Continue to Species Identification' }))
    // The outing is HANDED to onConfirm rather than written here: nothing is
    // saved until the cluster has a sighting.
    await waitFor(() => expect(onConfirm).toHaveBeenCalled())
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ stateProvince: 'US-WA', countryCode: 'US' }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      false,
    )
  })

  it('does not reuse an unrelated previous outing name after a successful empty lookup', async () => {
    stubReverse({ result: null, nearby: [], regionCodes: {} })
    const data = createDataStore()
    data.outings = [previousOuting]
    renderWithGps(data)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /48\.9801.*-122\.7887/ })).toBeInTheDocument()
    })
    expect(screen.queryByText('Previous Seattle outing')).not.toBeInTheDocument()
  })

  it('offers a retry when the lookup actually fails', async () => {
    // The other unhappy ending. A real failure IS worth retrying, so this path
    // must stay distinguishable from the empty one.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/geocoding/reverse')) {
        return new Response('Service Unavailable', { status: 503 })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const data = createDataStore()
    data.outings = [previousOuting]
    renderWithGps(data)

    await waitFor(() => {
      expect(screen.getByText(/Location lookup failed/i)).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
    expect(screen.queryByText(previousOuting.locationName)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /48\.9801.*-122\.7887/ })).toBeInTheDocument()
  })
})

describe('OutingReview current location', () => {
  const noGpsCluster = {
    photos: [],
    startTime: new Date('2026-08-07T12:00:00Z'),
    endTime: new Date('2026-08-07T13:00:00Z'),
  }
  const devicePosition = {
    coords: { latitude: 47.612345, longitude: -122.312345, accuracy: 5000 },
    timestamp: Date.now(),
  }
  const namedPlace = {
    label: 'Device park', lat: 47.61, lon: -122.31, stateProvince: 'US-WA', countryCode: 'US',
  }
  const response = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
  const setup = (data = createDataStore()) => {
    const getCurrentPosition = vi.fn()
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } })
    const fetchMock = vi.fn().mockImplementation(async () => response({ result: namedPlace }))
    vi.stubGlobal('fetch', fetchMock)
    const onConfirm = vi.fn(async () => undefined)
    const view = render(<OutingReview cluster={noGpsCluster} data={data} userId="user-1" onConfirm={onConfirm} />)
    const grant = async () => {
      await act(async () => getCurrentPosition.mock.calls.at(-1)![0](devicePosition))
    }
    return { ...view, getCurrentPosition, fetchMock, onConfirm, grant }
  }
  const requestLocation = () => {
    const nameField = screen.queryByRole('button', { name: 'Tap to set location' })
    if (nameField) fireEvent.click(nameField)
    fireEvent.click(screen.getByRole('button', { name: 'Use current location' }))
  }
  const continueReview = () => fireEvent.click(screen.getByRole('button', { name: 'Continue to Species Identification' }))

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('starts blank with no automatic location request or reuse of an unrelated outing', async () => {
    const data = createDataStore()
    data.outings = [previousOuting]
    const { getCurrentPosition, fetchMock, onConfirm } = setup(data)
    expect(screen.getByRole('button', { name: 'Tap to set location' })).toBeInTheDocument()
    expect(screen.queryByText(previousOuting.locationName)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Use current location' })).not.toBeInTheDocument()
    expect(getCurrentPosition).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    continueReview()
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ locationName: 'Unknown Location', lat: undefined, lon: undefined }),
      expect.any(String), 'Unknown Location', undefined, undefined, false,
    ))
  })

  it('reveals current location only while editing without requesting permission on focus', () => {
    const { getCurrentPosition, fetchMock } = setup()
    expect(screen.queryByRole('button', { name: 'Use current location' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Tap to set location' }))
    expect(screen.getByPlaceholderText('Search for a place...')).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Use current location' })).toBeInTheDocument()
    expect(getCurrentPosition).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByPlaceholderText('Search for a place...'), { key: 'Escape' })
    expect(screen.queryByRole('button', { name: 'Use current location' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Tap to set location' })).toBeInTheDocument()
  })

  it('uses exact device coordinates, not a named feature centroid, even with automatic geo lookup off', async () => {
    const { getCurrentPosition, fetchMock, onConfirm, grant } = setup()
    requestLocation()
    expect(screen.getByRole('button', { name: 'Getting current location...' })).toBeDisabled()
    expect(getCurrentPosition).toHaveBeenCalledOnce()
    await grant()
    expect(screen.getByText('Current location')).toBeInTheDocument()
    expect(screen.queryByText('Location set from search')).not.toBeInTheDocument()
    expect(screen.getByText('(47.6123, -122.3123)')).toBeInTheDocument()
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ lat: 47.612345, lon: -122.312345 })
    continueReview()
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        lat: 47.612345, lon: -122.312345, locationName: 'Device park',
        defaultLocationName: 'Device park', stateProvince: 'US-WA', countryCode: 'US',
      }),
      expect.any(String), 'Device park', 47.612345, -122.312345, true,
    ))
  })

  it.each([
    [1, /access was denied/i],
    [2, /location is unavailable/i],
    [3, /timed out/i],
  ])('explains location error %s and allows retry or manual naming', async (code, message) => {
    const { getCurrentPosition, fetchMock, onConfirm } = setup()
    requestLocation()
    await act(async () => getCurrentPosition.mock.calls[0][1]({ code }))
    expect(screen.getByRole('alert')).toHaveTextContent(message)
    expect(screen.getByRole('button', { name: 'Use current location' })).toBeEnabled()
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.change(screen.getByPlaceholderText('Search for a place...'), { target: { value: 'My park' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use entered name without searching' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    continueReview()
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ locationName: 'My park', lat: undefined }),
      expect.any(String), 'My park', undefined, undefined, false,
    ))
  })

  it('keeps an empty geocode result and its region codes without suggesting a lookup retry', async () => {
    const { fetchMock, onConfirm, grant } = setup()
    fetchMock.mockResolvedValueOnce(response({ result: null, regionCodes: { countryCode: 'US', stateProvince: 'US-WA' } }))
    requestLocation()
    await grant()
    expect(screen.getByText(/No named place found nearby/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    continueReview()
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ lat: 47.612345, lon: -122.312345, countryCode: 'US', stateProvince: 'US-WA' }),
      expect.any(String), expect.stringContaining('47.6123'), 47.612345, -122.312345, true,
    ))
  })

  it('retries failed reverse geocoding at the same device coordinates without acquiring location again', async () => {
    const { fetchMock, getCurrentPosition, grant } = setup()
    fetchMock.mockRejectedValueOnce(new Error('Offline'))
    requestLocation()
    await grant()
    expect(screen.getByText(/Location lookup failed/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('Device park')
    expect(getCurrentPosition).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ lat: 47.612345, lon: -122.312345 })
  })

  it('retains device coordinates when renaming, searching elsewhere, and restoring the suggestion', async () => {
    const { fetchMock, onConfirm, grant } = setup()
    requestLocation()
    await grant()
    fireEvent.click(screen.getByRole('button', { name: 'Device park' }))
    fireEvent.change(screen.getByPlaceholderText('Search for a place...'), { target: { value: 'Custom park' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use entered name without searching' }))
    expect(screen.getByText('(47.6123, -122.3123)')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Custom park' }))
    fetchMock.mockResolvedValueOnce(response({ results: [{ label: 'Other park', lat: 10, lon: 20 }] }))
    fireEvent.click(screen.getByRole('button', { name: 'Search locations' }))
    fireEvent.click(await screen.findByText('Other park'))
    expect(screen.getByText('Location set from search')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Other park' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use current location: Device park' }))
    expect(screen.getByText('Current location')).toBeInTheDocument()
    continueReview()
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ lat: 47.612345, lon: -122.312345, countryCode: 'US' }),
      expect.any(String), 'Device park', 47.612345, -122.312345, true,
    ))
  })

  it('ignores a location callback after cancellation and preserves a newer request', async () => {
    const { getCurrentPosition, fetchMock, grant } = setup()
    requestLocation()
    const obsolete = getCurrentPosition.mock.calls[0][0]
    fireEvent.click(screen.getByRole('button', { name: 'Cancel location lookup' }))
    requestLocation()
    await act(async () => obsolete(devicePosition))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Getting current location...' })).toBeDisabled()
    await grant()
    expect(screen.getByText('Device park')).toBeInTheDocument()
  })

  it('ignores an in-flight device lookup when the user starts editing', async () => {
    const { fetchMock, grant } = setup()
    requestLocation()
    fireEvent.change(screen.getByPlaceholderText('Search for a place...'), { target: { value: 'Chosen manually' } })
    await grant()
    expect(screen.getByDisplayValue('Chosen manually')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('aborts reverse geocoding and ignores its late result after cancellation and a rename', async () => {
    const { fetchMock, grant } = setup()
    let finishLookup: (value: Response) => void = () => undefined
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finishLookup = resolve }))
    requestLocation()
    await grant()
    const signal: AbortSignal = fetchMock.mock.calls[0][1].signal
    fireEvent.click(screen.getByRole('button', { name: 'Cancel location lookup' }))
    fireEvent.click(screen.getByRole('button', { name: /47\.6123.*-122\.3123/ }))
    fireEvent.change(screen.getByPlaceholderText('Search for a place...'), { target: { value: 'Custom park' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use entered name without searching' }))
    await act(async () => finishLookup(response({ result: namedPlace })))
    expect(signal.aborted).toBe(true)
    expect(screen.queryByText('Device park')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Custom park' })).toBeInTheDocument()
  })

  it('does not geocode a device result arriving after dismissal', async () => {
    const { unmount, fetchMock, grant } = setup()
    requestLocation()
    unmount()
    await grant()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not apply a previous cluster request to the next keyed review', async () => {
    const { rerender, fetchMock, grant } = setup()
    requestLocation()
    rerender(<OutingReview
      key="next-cluster"
      cluster={{ ...noGpsCluster, startTime: new Date('2026-08-08T12:00:00Z') }}
      data={createDataStore()}
      userId="user-1"
      onConfirm={vi.fn(async () => undefined)}
    />)
    await grant()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Tap to set location' })).toBeInTheDocument()
  })

  it('preserves matched-outing inheritance and offers current location only after declining the match', async () => {
    const data = createDataStore()
    data.outings = [{ ...previousOuting, startTime: noGpsCluster.startTime.toISOString(), endTime: noGpsCluster.endTime.toISOString(), lat: 10, lon: 20 }]
    const { onConfirm, getCurrentPosition } = setup(data)
    expect(screen.queryByRole('button', { name: 'Use current location' })).not.toBeInTheDocument()
    const toggle = screen.getByRole('switch', { name: 'Add to existing outing?' })
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'Tap to set location' })).toBeInTheDocument()
    requestLocation()
    fireEvent.click(toggle)
    continueReview()
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(null, previousOuting.id, previousOuting.locationName, 10, 20, false))
    await act(async () => getCurrentPosition.mock.calls[0][0](devicePosition))
    expect(onConfirm).toHaveBeenCalledOnce()
  })
})

describe('OutingReview coordinate display', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const stubSearch = (results: unknown[]) => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/geocoding/search')) {
        return new Response(JSON.stringify({ results }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/api/geocoding/reverse')) {
        return new Response(JSON.stringify({ result: null, nearby: [], regionCodes: {} }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }))
  }

  const pickFirstResult = async () => {
    // The name control is a button labelled with the current location name,
    // which here is either the coordinate fallback or the empty-state prompt.
    fireEvent.click(await screen.findByRole('button', { name: /Tap to set location|deg|\u00b0/ }))
    const input = screen.getByPlaceholderText('Search for a place...')
    fireEvent.change(input, { target: { value: 'Discovery Park' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search locations' }))
    fireEvent.click(await screen.findByText(/Discovery Park, Seattle/))
  }

  it('shows the searched coordinates, not the photo GPS, after an override', async () => {
    // The saved outing uses the searched place, so displaying the original
    // coordinate here would tell the user the override did not take.
    stubSearch([{ label: 'Discovery Park, Seattle', lat: 47.6615, lon: -122.4256 }])
    render(
      <OutingReview
        cluster={{
          photos: [],
          startTime: new Date('2026-08-07T12:00:00Z'),
          endTime: new Date('2026-08-07T13:00:00Z'),
          centerLat: 48.9801,
          centerLon: -122.7887,
        } as unknown as Parameters<typeof OutingReview>[0]['cluster']}
        data={createDataStore()}
        userId="user-1"
        onConfirm={vi.fn(async () => undefined)}
      />,
    )

    expect(screen.getByText(/48\.9801, -122\.7887/)).toBeInTheDocument()
    await pickFirstResult()
    await waitFor(() => {
      expect(screen.getByText(/47\.6615, -122\.4256/)).toBeInTheDocument()
    })
    expect(screen.queryByText(/48\.9801, -122\.7887/)).not.toBeInTheDocument()
  })

  it('stops claiming there is no GPS once a search has set the location', async () => {
    // A no-GPS outing that has been given coordinates by search is not the
    // same as one with no location at all, and the eBird export cares.
    stubSearch([{ label: 'Discovery Park, Seattle', lat: 47.6615, lon: -122.4256 }])
    const onConfirm = vi.fn(async () => undefined)
    render(
      <OutingReview
        cluster={{
          photos: [],
          startTime: new Date('2026-08-07T12:00:00Z'),
          endTime: new Date('2026-08-07T13:00:00Z'),
        } as unknown as Parameters<typeof OutingReview>[0]['cluster']}
        data={createDataStore()}
        userId="user-1"
        onConfirm={onConfirm}
      />,
    )

    expect(screen.getByText('No GPS data in photo')).toBeInTheDocument()
    await pickFirstResult()
    await waitFor(() => {
      expect(screen.getByText('Location set from search')).toBeInTheDocument()
    })
    expect(screen.queryByText('No GPS data in photo')).not.toBeInTheDocument()
    expect(screen.getByText(/47\.6615, -122\.4256/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Continue to Species Identification' }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalled())
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ lat: 47.6615, lon: -122.4256 }),
      expect.anything(),
      'Discovery Park, Seattle',
      47.6615,
      -122.4256,
      true,
    )
  })
})
