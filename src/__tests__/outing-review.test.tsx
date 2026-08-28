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
        defaultLocationName="Discovery Park"
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
        defaultLocationName="Discovery Park"
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
        defaultLocationName="Discovery Park"
        onConfirm={onConfirm}
      />,
    )

    expect(screen.queryByText('Add to existing outing?')).not.toBeInTheDocument()

    await act(async () => finishConfirmation())
  })

  it('does not restart GPS lookup when the default location changes while confirming', async () => {
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
        defaultLocationName="Previous location"
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
        defaultLocationName="Discovery Park, Seattle"
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
        defaultLocationName="Discovery Park"
        onConfirm={vi.fn(async () => undefined)}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Discovery Park/ }))
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
        defaultLocationName="Discovery Park"
        onConfirm={vi.fn(async () => undefined)}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Discovery Park/ }))
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
        defaultLocationName="Discovery Park"
        onConfirm={vi.fn(async () => undefined)}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Discovery Park/ }))
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
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/geocoding/reverse')) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }))
  }

  const renderWithGps = (data: WingDexDataStore, onConfirm = vi.fn(async () => undefined)) => {
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
    stubReverse({ result: null, nearby: [], regionCodes: {} })
    renderWithGps(createDataStore())

    await waitFor(() => {
      expect(screen.getByText(/No named place found nearby/i)).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument()

    // The coordinate string is a usable fallback name. It renders in the
    // name control, which is a button until tapped, and the lookup rounds to
    // 3 decimals before querying, so the value shown is the rounded one.
    const nameControl = screen.getByRole('button', { name: /48\.9800/ })
    expect(nameControl).toBeInTheDocument()

    // Tapping it opens a real editable input, so the user is never blocked.
    fireEvent.click(nameControl)
    const field = await screen.findByDisplayValue(/48\.9800/) as HTMLInputElement
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
    )
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
    renderWithGps(createDataStore())

    await waitFor(() => {
      expect(screen.getByText(/Location lookup failed/i)).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })
})
