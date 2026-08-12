/**
 * @vitest-environment jsdom
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import type React from 'react'
import { useAuthGate } from '@/hooks/use-auth-gate'

const mockSignInPasskey = vi.fn()
const mockGetSession = vi.fn()
const mockAddPasskey = vi.fn()
const mockSignOut = vi.fn()

vi.mock('@/lib/auth-client', () => ({
  authClient: {
    signIn: {
      passkey: (...args: unknown[]) => mockSignInPasskey(...args),
      social: vi.fn(),
    },
    getSession: (...args: unknown[]) => mockGetSession(...args),
    passkey: {
      addPasskey: (...args: unknown[]) => mockAddPasskey(...args),
    },
    signOut: (...args: unknown[]) => mockSignOut(...args),
  },
}))

vi.mock('@/lib/fun-names', () => ({
  generateBirdName: () => 'test-bird',
  getEmojiAvatarColor: () => '',
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}))

vi.mock('@/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}))

vi.mock('@phosphor-icons/react', () => ({
  Key: () => <span>Key</span>,
  GithubLogo: () => <span>GitHub</span>,
  AppleLogo: () => <span>Apple</span>,
  GoogleChromeLogo: () => <span>Google</span>,
}))

vi.mock('@/components/ui/switch', () => ({
  Switch: ({ checked, onCheckedChange, ...props }: { checked: boolean; onCheckedChange: (v: boolean) => void } & Record<string, unknown>) => (
    <button role="switch" aria-checked={checked} onClick={() => onCheckedChange(!checked)} {...props}>
      {checked ? 'On' : 'Off'}
    </button>
  ),
}))

function Harness({ onUpgraded, isAnonymous = true, hasUnsavedSightings = false }: { onUpgraded: () => void | Promise<void>; isAnonymous?: boolean; hasUnsavedSightings?: boolean }) {
  const [actionRan, setActionRan] = useState(false)
  // requireAuth is gone: nothing gates on having an account any more. The modal
  // is opened directly now, and onUpgraded is what callers hang work off.
  const { openSignIn, authGateModal } = useAuthGate({
    isAnonymous,
    hasUnsavedSightings,
    onUpgraded: async () => {
      setActionRan(true)
      await onUpgraded()
    },
  })

  return (
    <>
      <button onClick={() => openSignIn()}>Open gated action</button>
      {authGateModal}
      {actionRan && <div>action-ran</div>}
    </>
  )
}

describe('useAuthGate', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockSignInPasskey.mockReset()
    mockGetSession.mockReset()
    mockAddPasskey.mockReset()
    mockSignOut.mockReset()
    vi.stubGlobal('fetch', vi.fn())
    mockSignOut.mockResolvedValue({ error: null })
    mockAddPasskey.mockResolvedValue({ error: null })
  })

  it('opens the combined auth modal and signs up with the passkey action', async () => {
    // One ceremony (#271): verify-registration returns the session and user it
    // just created, and sets the cookie server-side. No finalize call follows.
    mockAddPasskey.mockResolvedValue({
      data: { id: 'pk-test-1', session: { id: 'sess-1' }, user: { id: 'user-1' } },
      error: null,
    })

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    const onUpgraded = vi.fn()
    render(<Harness onUpgraded={onUpgraded} />)

    await userEvent.click(screen.getByText('Open gated action'))
    expect(screen.getByRole('heading', { name: /start your wingdex/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /continue with github/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /continue with apple/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /sign up/i }))

    await waitFor(() => {
      expect(onUpgraded).toHaveBeenCalledTimes(1)
      expect(screen.getByText('action-ran')).toBeInTheDocument()
    })

    expect(mockAddPasskey).toHaveBeenCalledTimes(1)
    expect(mockAddPasskey).toHaveBeenCalledWith(
      expect.objectContaining({ createSession: true }),
    )
  })

  it('uses the passkey log-in action from the combined auth modal', async () => {
    mockSignInPasskey.mockResolvedValue({ error: null })
    mockGetSession.mockResolvedValue({
      data: {
        user: {
          id: 'u1',
          isAnonymous: false,
        },
      },
    })

    const onUpgraded = vi.fn()
    render(<Harness onUpgraded={onUpgraded} />)

    await userEvent.click(screen.getByText('Open gated action'))
    expect(screen.getByRole('heading', { name: /start your wingdex/i })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /log in/i }))

    await waitFor(() => {
      expect(mockSignInPasskey).toHaveBeenCalled()
      expect(onUpgraded).toHaveBeenCalledTimes(1)
    })

    expect(mockAddPasskey).not.toHaveBeenCalled()
  })

  it('uses Keep your sightings copy whenever anonymous data exists', async () => {
    render(<Harness onUpgraded={vi.fn()} hasUnsavedSightings />)

    await userEvent.click(screen.getByText('Open gated action'))

    expect(screen.getByRole('heading', { name: 'Keep your sightings' })).toBeInTheDocument()
    expect(screen.getByText(/only in this browser/i)).toBeInTheDocument()
  })

  it('still opens the modal for a signed-in user, since it is now a sign-in entry point', async () => {
    // There is no gate to bypass any more. openSignIn is what the header button
    // and Settings use, so it opens regardless of who is asking.
    const onUpgraded = vi.fn()
    render(<Harness onUpgraded={onUpgraded} isAnonymous={false} />)

    await userEvent.click(screen.getByText('Open gated action'))

    expect(screen.getByRole('heading', { name: /start your wingdex/i })).toBeInTheDocument()
    expect(onUpgraded).not.toHaveBeenCalled()
  })

  it('does not call onUpgraded when passkey creation is cancelled', async () => {
    mockAddPasskey.mockResolvedValue({
      error: { code: 'ERROR_CEREMONY_ABORTED', message: 'not allowed by the user agent' },
    })

    const onUpgraded = vi.fn()
    render(<Harness onUpgraded={onUpgraded} />)

    await userEvent.click(screen.getByText('Open gated action'))
    await userEvent.click(screen.getByRole('button', { name: /sign up/i }))

    await waitFor(() => {
      expect(mockAddPasskey).toHaveBeenCalledTimes(1)
    })

    // Modal stays open, callback never fires
    expect(onUpgraded).not.toHaveBeenCalled()
    expect(screen.queryByText('action-ran')).not.toBeInTheDocument()
  })

  it('shows error when authenticator is already registered', async () => {
    mockAddPasskey.mockResolvedValue({
      error: { code: 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED', message: 'Authenticator registered' },
    })

    const onUpgraded = vi.fn()
    render(<Harness onUpgraded={onUpgraded} />)

    await userEvent.click(screen.getByText('Open gated action'))
    await userEvent.click(screen.getByRole('button', { name: /sign up/i }))

    await waitFor(() => {
      expect(screen.getByText(/already has a passkey/i)).toBeInTheDocument()
    })
    expect(onUpgraded).not.toHaveBeenCalled()
  })
})
