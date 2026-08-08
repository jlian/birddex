import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsPage from '@/components/pages/SettingsPage'
import type { WingDexDataStore } from '@/hooks/use-wingdex-data'
import { toast } from 'sonner'

const { signInAnonymous } = vi.hoisted(() => ({
  signInAnonymous: vi.fn(),
}))

vi.mock('@/lib/auth-client', () => ({
  authClient: {
    updateUser: vi.fn(),
    signIn: { anonymous: signInAnonymous },
    signOut: vi.fn(),
    passkey: {
      listUserPasskeys: vi.fn(async () => ({ data: [] })),
      updatePasskey: vi.fn(),
      deletePasskey: vi.fn(),
      addPasskey: vi.fn(),
    },
  },
}))

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'system', setTheme: vi.fn() }),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
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

describe('SettingsPage account deletion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not change identities or clear data after an unauthorized response', async () => {
    const data = createDataStore()
    const onSignedOut = vi.fn()
    const request = vi.fn(async () => new Response('Unauthorized', { status: 401 }))
    vi.stubGlobal('fetch', request)

    render(
      <SettingsPage
        data={data}
        user={{
          id: 'user-1',
          name: 'Test Birder',
          image: '',
          email: 'birder@example.com',
          isAnonymous: false,
        }}
        onSignedOut={onSignedOut}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete Data...' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete Account & All Data' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account forever' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Unauthorized'))
    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith('/api/auth/delete-account', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
    }))
    expect(signInAnonymous).not.toHaveBeenCalled()
    expect(data.clearAllData).not.toHaveBeenCalled()
    expect(onSignedOut).not.toHaveBeenCalled()
  })
})