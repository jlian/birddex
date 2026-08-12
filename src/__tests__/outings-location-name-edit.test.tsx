import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { fireEvent, screen } from '@testing-library/dom'
import OutingsPage from '@/components/pages/OutingsPage'
import type { WingDexDataStore } from '@/hooks/use-wingdex-data'
import type { Outing } from '@/lib/types'
import { toast } from 'sonner'

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

const baseOuting: Outing = {
  id: 'outing_1',
  userId: 'dev-user',
  startTime: '2026-02-10T21:42:00.000Z',
  endTime: '2026-02-10T22:42:00.000Z',
  locationName: 'Central Park, New York',
  defaultLocationName: 'Central Park, New York',
  lat: 40.7829,
  lon: -73.9654,
  notes: '',
  createdAt: '2026-02-10T21:42:00.000Z',
}

function createDataStore(): WingDexDataStore {
  return {
    isLoading: false,
    photos: [],
    outings: [baseOuting],
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

describe('OutingsPage location name editing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('saves top outing name using trimmed value', () => {
    const data = createDataStore()

    render(
      <OutingsPage
        data={data}
        selectedOutingId={baseOuting.id}
        onSelectOuting={vi.fn()}
        onSelectSpecies={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit outing name' }))
    fireEvent.change(screen.getByLabelText('Location name'), {
      target: { value: '  Prospect Park  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(data.updateOuting).toHaveBeenCalledWith(baseOuting.id, {
      locationName: 'Prospect Park',
      defaultLocationName: 'Central Park, New York',
    })
    expect(toast.success).toHaveBeenCalledWith('Outing name saved')
  })

  it('resets to default API location name when cleared', () => {
    const data = createDataStore()

    render(
      <OutingsPage
        data={data}
        selectedOutingId={baseOuting.id}
        onSelectOuting={vi.fn()}
        onSelectSpecies={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit outing name' }))
    fireEvent.change(screen.getByLabelText('Location name'), {
      target: { value: '   ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(data.updateOuting).toHaveBeenCalledWith(baseOuting.id, {
      locationName: 'Central Park, New York',
      defaultLocationName: 'Central Park, New York',
    })
    expect(toast.success).toHaveBeenCalledWith('Outing name reset')
  })

  it('preserves existing location as default when missing on first rename', () => {
    const data = createDataStore()
    data.outings = [{ ...baseOuting, defaultLocationName: undefined }]

    render(
      <OutingsPage
        data={data}
        selectedOutingId={baseOuting.id}
        onSelectOuting={vi.fn()}
        onSelectSpecies={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit outing name' }))
    fireEvent.change(screen.getByLabelText('Location name'), {
      target: { value: 'Prospect Park' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(data.updateOuting).toHaveBeenCalledWith(baseOuting.id, {
      locationName: 'Prospect Park',
      defaultLocationName: 'Central Park, New York',
    })
  })
})
