/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url":"http://localhost:5173/"}
 */

import { render } from '@testing-library/react'
import { screen } from '@testing-library/dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseSession = vi.fn()
const mockSignInAnonymous = vi.fn()

vi.mock('@/lib/auth-client', () => ({
  authClient: {
    useSession: () => mockUseSession(),
    signIn: {
      anonymous: () => mockSignInAnonymous(),
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
}))

vi.mock('@/components/ui/avatar', () => ({
  Avatar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AvatarImage: () => null,
  AvatarFallback: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

vi.mock('@/components/ui/sonner', () => ({
  Toaster: () => null,
}))

vi.mock('@phosphor-icons/react', () => ({
  House: () => <span>House</span>,
  List: () => <span>List</span>,
  Gear: () => <span>Gear</span>,
  MapPin: () => <span>MapPin</span>,
  GithubLogo: () => <span>GithubLogo</span>,
  Key: () => <span>Key</span>,
  PlusCircle: () => <span>PlusCircle</span>,
  UserPlus: () => <span>UserPlus</span>,
  ArrowsClockwise: () => <span>ArrowsClockwise</span>,
  ArrowLeft: () => <span>ArrowLeft</span>,
  // A local guest is now anonymous until something needs an account, so the
  // header renders the sign-in affordance that previously never appeared here.
  UserCircle: () => <span>UserCircle</span>,
}))

vi.mock('@/components/ui/bird-logo', () => ({
  BirdLogo: () => <span>BirdLogo</span>,
}))

vi.mock('@/components/pages/HomePage', () => ({
  default: () => <div>HomePage</div>,
}))

vi.mock('@/components/pages/OutingsPage', () => ({
  default: () => <div>OutingsPage</div>,
}))

vi.mock('@/components/pages/WingDexPage', () => ({
  default: () => <div>WingDexPage</div>,
}))

vi.mock('@/components/pages/SettingsPage', () => ({
  default: () => <div>SettingsPage</div>,
}))

vi.mock('@/components/flows/AddPhotosFlow', () => ({
  default: () => null,
}))

vi.mock('@/hooks/use-auth-gate', () => ({
  useAuthGate: () => ({
    requireAuth: (cb: () => void) => cb(),
    openSignIn: vi.fn(),
    authGateModal: null,
  }),
}))

describe('App auth guard (local runtime)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockUseSession.mockReturnValue({ data: null, isPending: false, refetch: vi.fn() })
    mockSignInAnonymous.mockResolvedValue({ error: { message: 'Local auth unavailable in test' } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (typeof localStorage.clear === 'function') {
      localStorage.clear()
    }
  })

  it('allows fallback user in local dev runtime when no hosted session exists', async () => {
    const { default: App } = await import('@/App')
    render(<App />)

    expect(await screen.findByText('HomePage')).toBeInTheDocument()
    expect(screen.queryByText('Welcome to WingDex')).not.toBeInTheDocument()
  })
})
