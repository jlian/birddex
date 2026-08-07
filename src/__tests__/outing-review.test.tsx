import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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
})