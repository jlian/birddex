/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url":"https://wingdex.app/"}
 *
 * Prompting to sign up at the first outing save.
 *
 * Saving is the moment there is something to lose, so that is where the single
 * prompt goes. Declining is final: the avatar badge carries the message from
 * then on, and no second prompt ever appears.
 */

import { render } from '@testing-library/react'
import { fireEvent, screen, waitFor } from '@testing-library/dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseSession = vi.fn()
const mockOpenSignIn = vi.fn()

vi.mock('@/lib/auth-client', () => ({
  authClient: {
    useSession: () => mockUseSession(),
    signIn: {
      anonymous: () => Promise.resolve({ error: null }),
      social: vi.fn(),
    },
  },
}))

vi.mock('@/hooks/use-wingdex-data', () => ({
  useWingDexData: () => ({
    photos: [],
    outings: [],
    observations: [],
    dex: [],
  }),
}))

vi.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  TabsContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('@/lib/fun-names', () => ({
  generateBirdName: () => 'test-bird-name',
  getEmojiAvatarColor: () => '',
  emojiForBirdName: () => '🐦',
  emojiAvatarDataUrl: () => 'data:image/svg+xml;utf8,bird',
}))

vi.mock('@/components/ui/avatar', () => ({
  Avatar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AvatarImage: () => null,
  AvatarFallback: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

vi.mock('@/components/ui/sonner', () => ({ Toaster: () => null }))

vi.mock('@phosphor-icons/react', () => ({
  MapPin: () => <span>MapPin</span>,
  GithubLogo: () => <span>GithubLogo</span>,
}))

vi.mock('@/components/pages/HomePage', () => ({
  default: ({ onAddPhotos }: { onAddPhotos: () => void }) => (
    <button onClick={onAddPhotos}>Upload &amp; Identify</button>
  ),
}))

vi.mock('@/components/pages/OutingsPage', () => ({ default: () => <div>OutingsPage</div> }))
vi.mock('@/components/pages/WingDexPage', () => ({ default: () => <div>WingDexPage</div> }))
vi.mock('@/components/pages/SettingsPage', () => ({ default: () => <div>SettingsPage</div> }))

// Stands in for the real flow so the two callbacks that drive the prompt can be
// fired directly, without a model download or a photo.
vi.mock('@/components/flows/AddPhotosFlow', () => ({
  default: ({ onClose, onOutingSaved }: { onClose: () => void; onOutingSaved?: () => void }) => (
    <div>
      <button onClick={() => onOutingSaved?.()}>fire-saved</button>
      <button onClick={onClose}>fire-close</button>
    </div>
  ),
}))

vi.mock('@/hooks/use-auth-gate', () => ({
  useAuthGate: () => ({
    openSignIn: mockOpenSignIn,
    authGateModal: null,
  }),
}))

async function openFlowSaveAndClose() {
  fireEvent.click(await screen.findByText('Upload & Identify'))
  fireEvent.click(await screen.findByText('fire-saved'))
  fireEvent.click(screen.getByText('fire-close'))
}

describe('signup prompt at first outing save', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockOpenSignIn.mockClear()
    window.localStorage.clear()
    mockUseSession.mockReturnValue({
      data: { user: { id: 'anon-1', name: 'anon', image: '', email: '', isAnonymous: true } },
      isPending: false,
      refetch: vi.fn(),
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ providers: [] }),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('prompts once the first save is done and the flow is closed', async () => {
    const { default: App } = await import('@/App')
    render(<App />)

    await openFlowSaveAndClose()

    await waitFor(() => expect(mockOpenSignIn).toHaveBeenCalledTimes(1))
  })

  it('does not prompt while the flow is still open', async () => {
    const { default: App } = await import('@/App')
    render(<App />)

    fireEvent.click(await screen.findByText('Upload & Identify'))
    fireEvent.click(await screen.findByText('fire-saved'))

    expect(mockOpenSignIn).not.toHaveBeenCalled()
  })

  it('does not prompt again on a later save', async () => {
    const { default: App } = await import('@/App')
    const { unmount } = render(<App />)

    await openFlowSaveAndClose()
    await waitFor(() => expect(mockOpenSignIn).toHaveBeenCalledTimes(1))

    // A reload must not reset this, or declining would be re-asked every visit.
    unmount()
    render(<App />)
    await openFlowSaveAndClose()

    expect(mockOpenSignIn).toHaveBeenCalledTimes(1)
  })

  it('does not prompt a signed-in user', async () => {
    mockUseSession.mockReturnValue({
      data: { user: { id: 'user-1', name: 'octocat', image: '', email: 'o@example.com' } },
      isPending: false,
      refetch: vi.fn(),
    })

    const { default: App } = await import('@/App')
    render(<App />)

    await openFlowSaveAndClose()

    expect(mockOpenSignIn).not.toHaveBeenCalled()
  })
})
