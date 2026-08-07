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
          label: 'Discovery Park, Seattle, Washington',
          lat: 47.6573,
          lon: -122.4055,
          stateProvince: 'US-WA',
          countryCode: 'US',
          attribution: {
            label: 'Location data © OpenStreetMap contributors',
            url: 'https://www.openstreetmap.org/copyright',
          },
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

    await screen.findByText('Discovery Park, Seattle, Washington')
    expect(fetchMock).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Continue to Species Identification' }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce())

    rerender(
      <OutingReview
        cluster={cluster}
        data={data}
        userId="user-1"
        defaultLocationName="Discovery Park, Seattle, Washington"
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
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/geocoding/search?q=Green+Lake')
  })
})