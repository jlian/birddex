import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AddPhotosFlow from '@/components/flows/AddPhotosFlow'
import type { WingDexDataStore } from '@/hooks/use-wingdex-data'

vi.mock('@/lib/photo-utils', () => ({
  extractEXIF: vi.fn(async () => ({})),
  generateThumbnail: vi.fn(async () => 'data:image/jpeg;base64,fixture'),
  computeFileHash: vi.fn(async (file: File) => `hash-${file.name}`),
}))

vi.mock('@/components/flows/OutingReview', () => ({
  default: ({ cluster }: { cluster: { photos: unknown[] } }) => (
    <div>Photos ({cluster.photos.length})</div>
  ),
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

function createFileList(count: number): FileList {
  const files = Array.from(
    { length: count },
    (_, index) => new File([String(index)], `bird-${index}.jpg`, { type: 'image/jpeg' }),
  )
  const fileList = Object.create(FileList.prototype) as FileList
  Object.defineProperties(fileList, {
    length: { value: files.length },
    item: { value: (index: number) => files[index] ?? null },
    [Symbol.iterator]: { value: files[Symbol.iterator].bind(files) },
  })
  files.forEach((file, index) => {
    Object.defineProperty(fileList, index, { value: file })
  })
  return fileList
}

describe('AddPhotosFlow upload', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('carries a 200-photo FileList into outing review without truncation', async () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation(file => `blob:${(file as File).name}`)
    render(
      <AddPhotosFlow
        data={createDataStore()}
        onClose={vi.fn()}
        ensureSessionReady={vi.fn(async () => true)}
        userId="user-1"
      />,
    )
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')
    const files = createFileList(200)

    expect(files).toBeInstanceOf(FileList)
    fireEvent.change(input!, { target: { files } })

    await waitFor(() => {
      expect(screen.getByText('Photos (200)')).toBeInTheDocument()
    })
  })
})
