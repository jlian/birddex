import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react'
import { useTheme } from 'next-themes'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Toaster } from '@/components/ui/sonner'
import { toast } from 'sonner'
import { MapPin, GithubLogo, UserCircle } from '@phosphor-icons/react'
import { BirdLogo } from '@/components/ui/bird-logo'
import { useWingDexData } from '@/hooks/use-wingdex-data'
import { getStableDevUserId } from '@/lib/dev-user'
import { authClient } from '@/lib/auth-client'
import { fetchWithLocalAuthRetry } from '@/lib/local-auth-fetch'
import { getEmojiAvatarColor, emojiForBirdName, emojiAvatarDataUrl } from '@/lib/fun-names'
import { useAuthGate } from '@/hooks/use-auth-gate'
import type { OutingSortField, SortDir as OutingSortDir } from '@/components/pages/OutingsPage'
import type { SortField as WingDexSortField, SortDir as WingDexSortDir } from '@/components/pages/WingDexPage'

import HomePage from '@/components/pages/HomePage'

const OutingsPage = lazy(() => import('@/components/pages/OutingsPage'))
const WingDexPage = lazy(() => import('@/components/pages/WingDexPage'))
const SettingsPage = lazy(() => import('@/components/pages/SettingsPage'))
const TermsPage = lazy(() => import('@/components/pages/TermsPage'))
const PrivacyPage = lazy(() => import('@/components/pages/PrivacyPage'))
const loadAddPhotosFlow = () => import('@/components/flows/AddPhotosFlow')
const AddPhotosFlow = lazy(loadAddPhotosFlow)

interface UserInfo {
  name: string
  image: string
  email: string
  id: string
  isAnonymous: boolean
}

function isDevRuntime(): boolean {
  const host = window.location.hostname.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1'
}

function getFallbackUser(): UserInfo {
  return {
    name: 'dev-user',
    image: '',
    email: 'dev@localhost',
    id: getStableDevUserId(),
    isAnonymous: false,
  }
}

/** Placeholder id used for a visitor that has no session yet. */
const GUEST_USER_ID = 'guest'

const SIGNUP_PROMPT_KEY = 'wingdex.signupPrompted'

function signupPromptKey(userId: string): string {
  return `${SIGNUP_PROMPT_KEY}.${userId}`
}

/**
 * The server names every anonymous account with a bird name and stores no
 * image, so the avatar is derived from that name rather than stored twice.
 */
function avatarForBirdName(name: string): string {
  return emojiAvatarDataUrl(emojiForBirdName(name))
}

/**
 * Identity used before any session exists. It lets AppContent mount so a
 * visitor can browse immediately, while no anonymous user has been created
 * on the server yet. It is `isAnonymous` so every existing auth gate keeps
 * treating it as "not signed in".
 */
function getGuestUser(): UserInfo {
  return {
    name: 'guest',
    image: '',
    email: '',
    id: isDevRuntime() ? getStableDevUserId() : GUEST_USER_ID,
    isAnonymous: true,
  }
}

// ─── URL Hash Router ──────────────────────────────────────

function parseHash(): { tab: string; subId?: string } {
  const hash = window.location.hash.slice(1)
  if (!hash) return { tab: 'home' }
  const [segment, ...rest] = hash.split('/')
  const subId = rest.length > 0 ? decodeURIComponent(rest.join('/')) : undefined
  if (['home', 'outings', 'wingdex', 'settings', 'terms', 'privacy'].includes(segment)) {
    return { tab: segment, subId }
  }
  return { tab: 'home' }
}

function useHashRouter() {
  const [route, setRoute] = useState(parseHash)
  const navigatingWithSubId = useRef(false)

  useEffect(() => {
    const onChange = () => {
      // popstate fires on browser back/forward, restore saved scroll position
      const saved = window.history.state?.scrollY
      setRoute(parseHash())
      if (typeof saved === 'number') {
        // Defer so the DOM renders the target view first
        requestAnimationFrame(() => window.scrollTo(0, saved))
      }
    }
    window.addEventListener('popstate', onChange)
    window.addEventListener('hashchange', onChange)
    return () => {
      window.removeEventListener('popstate', onChange)
      window.removeEventListener('hashchange', onChange)
    }
  }, [])

  // Clear the guard after each render
  useEffect(() => { navigatingWithSubId.current = false })

  const navigate = useCallback((tab: string, subId?: string) => {
    // Save current scroll position in the current history entry before navigating away
    window.history.replaceState({ scrollY: window.scrollY }, '')

    const hash = subId
      ? `#${tab}/${encodeURIComponent(subId)}`
      : tab === 'home' ? '' : `#${tab}`
    window.history.pushState(null, '', hash || window.location.pathname)
    if (subId) navigatingWithSubId.current = true
    setRoute({ tab, subId })
    // Scroll to top on forward navigation into a detail view
    if (subId) window.scrollTo(0, 0)
  }, [])

  const handleTabChange = useCallback((val: string) => {
    // Guard: if we just navigated with a subId, don't let onValueChange override it
    if (navigatingWithSubId.current) return
    navigate(val)
  }, [navigate])

  return { tab: route.tab, subId: route.subId, navigate, handleTabChange }
}

// ─── App ──────────────────────────────────────────────────

function App() {
  const sessionState = authClient.useSession()
  const session = sessionState.data
  const isSessionPending = sessionState.isPending
  const refetchSession = sessionState.refetch
  const anonBootstrapStarted = useRef(false)
  const anonBootstrapPromise = useRef<Promise<boolean> | null>(null)
  const hadSessionRef = useRef(false)
  const wasRealUserRef = useRef(false)
  const explicitSignOutRef = useRef(false)
  const [anonBootstrapFailed, setAnonBootstrapFailed] = useState(false)
  // Only the first check matters: once the answer is known, later refetches keep
  // showing it rather than blanking the header again.
  const [sessionResolved, setSessionResolved] = useState(false)
  // Starts as a guest rather than null: with no BootShell, the app renders
  // immediately and a real session upgrades this in place when it resolves.
  const [user, setUser] = useState<UserInfo>(() => getGuestUser())

  useEffect(() => {
    if (!isSessionPending) setSessionResolved(true)
  }, [isSessionPending])

  const fetchLinkedProviders = useCallback(async (): Promise<string[]> => {
    try {
      const response = await fetchWithLocalAuthRetry('/api/auth/linked-providers', {
        credentials: 'include',
      })
      if (!response.ok) return []
      const data = await response.json() as { providers?: string[] }
      return Array.isArray(data.providers) ? data.providers : []
    } catch {
      return []
    }
  }, [])

  // Surface OAuth redirect errors as a toast
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const error = params.get('error')
    if (!error) return
    const desc = params.get('error_description')
    toast.error(`Sign-in failed: ${error}${desc ? `, ${desc}` : ''}`)
    params.delete('error')
    params.delete('error_description')
    const clean = params.toString()
    const url = window.location.pathname + (clean ? `?${clean}` : '') + window.location.hash
    window.history.replaceState(null, '', url)
  }, [])

  useEffect(() => {
    if (session && session.user) {
      hadSessionRef.current = true
      anonBootstrapStarted.current = false
      anonBootstrapPromise.current = null
      const isAnon = Boolean((session.user as { isAnonymous?: boolean }).isAnonymous)
      wasRealUserRef.current = !isAnon

      setAnonBootstrapFailed(false)
      const name = session.user.name || session.user.email || 'user'
      setUser({
        id: session.user.id,
        name,
        image: isAnon ? avatarForBirdName(name) : (session.user.image || ''),
        email: session.user.email || '',
        isAnonymous: isAnon,
      })
      return
    }

    // Only reset bootstrap guard when transitioning from a real session
    // to no session (e.g. after sign-out).
    if (hadSessionRef.current) {
      if (wasRealUserRef.current && !explicitSignOutRef.current) {
        toast.info('Your session has expired. Please sign in again.')
        // Fall back to the guest view rather than an empty screen: the toast
        // explains what happened, and the app stays usable while they sign in.
        setUser(getGuestUser())
      }
      hadSessionRef.current = false
      wasRealUserRef.current = false
      explicitSignOutRef.current = false
      anonBootstrapStarted.current = false
      anonBootstrapPromise.current = null
    }

    // No session. Passkey registration is sessionless-capable now
    // (`requireSession: false`), so nothing here needs an anonymous user yet.
    // Mount as a guest and defer the anonymous sign-in to the first action
    // that actually needs a server-side identity (see ensureAnonymousSession).
    //
    // This applies while the session check is still in flight too. A returning
    // user is resolved as a guest for those few hundred milliseconds and then
    // upgraded in place when the check returns, which shows the app immediately
    // instead of holding a splash screen for every visitor.

    if (isDevRuntime()) {
      // Dev keeps its own fallback identity when the auth backend is dead.
      setUser(anonBootstrapFailed ? getFallbackUser() : getGuestUser())
      return
    }

    setUser(getGuestUser())
  }, [
    session,
    isSessionPending,
    anonBootstrapFailed,
  ])

  /**
   * Create the anonymous user on demand, at the first point a server-side
   * identity is actually required. Idempotent: concurrent callers await the
   * same in-flight promise, so only one anonymous user is ever minted.
   * Resolves true when a session exists (or already existed), false on
   * failure. On failure it sets `anonBootstrapFailed` and does not retry in a
   * loop, matching the previous on-load behavior.
   */
  const ensureAnonymousSession = useCallback(async (): Promise<boolean> => {
    if (session?.user) return true
    if (anonBootstrapPromise.current) return anonBootstrapPromise.current
    if (anonBootstrapStarted.current) return false
    if (anonBootstrapFailed) {
      // Auth backend unreachable, stop retrying to avoid a tight loop.
      // User must reload to reattempt.
      return false
    }

    anonBootstrapStarted.current = true
    let succeeded = false
    const inFlight = authClient.signIn.anonymous().then((result) => {
      if (result.error) {
        setAnonBootstrapFailed(true)
        return false
      }
      // Set user directly from sign-in response so AppContent keeps rendering
      // with the real id immediately and fires /api/data/all in parallel with
      // the auto-refetch get-session instead of waiting for it.
      const u = result.data?.user
      if (u) {
        const isAnon = Boolean((u as { isAnonymous?: boolean }).isAnonymous)
        const name = u.name || u.email || 'user'
        setUser({
          id: u.id,
          name,
          image: isAnon ? avatarForBirdName(name) : (u.image || ''),
          email: u.email || '',
          isAnonymous: isAnon,
        })
      }
      succeeded = true
      return true
    }).catch(() => {
      setAnonBootstrapFailed(true)
      anonBootstrapStarted.current = false
      if (isDevRuntime()) setUser(getFallbackUser())
      return false
    }).finally(() => {
      // Keep a successful readiness promise until useSession publishes the
      // session. Multiple first-write boundaries can run during that gap.
      if (!succeeded) anonBootstrapPromise.current = null
    })

    anonBootstrapPromise.current = inFlight
    return inFlight
  }, [session, anonBootstrapFailed])

  useEffect(() => {
    if (!user || user.isAnonymous) return

    const params = new URLSearchParams(window.location.search)
    const provider = params.get('auth_provider')
    const source = params.get('auth_source')
    if (source !== 'social' || !['github', 'apple', 'google'].includes(provider ?? '')) return

    const finalizeSocialToast = async () => {
      const linkedProviders = await fetchLinkedProviders()
      const providerLabels: Record<string, string> = {
        github: 'GitHub',
        apple: 'Apple',
        google: 'Google',
      }
      const providerKey = provider as 'github' | 'apple' | 'google'
      const providerLabel = providerLabels[providerKey]
      const otherProviders = linkedProviders
        .filter((linkedProvider): linkedProvider is 'github' | 'apple' | 'google' => linkedProvider in providerLabels)
        .filter(linkedProvider => linkedProvider !== providerKey)
      const mergedIntoExistingAccount = linkedProviders.includes(providerKey) && otherProviders.length > 0

      if (mergedIntoExistingAccount) {
        const otherLabels = otherProviders.map(linkedProvider => providerLabels[linkedProvider])
        const mergedLabel = otherLabels.length === 1
          ? otherLabels[0]
          : 'existing'
        const accountLabel = mergedLabel === 'existing'
          ? 'Existing account'
          : `${mergedLabel} account`
        toast.success(`Signed in with ${providerLabel}. ${accountLabel} found and linked.`)
      } else {
        toast.success(`Signed in with ${providerLabel}.`)
      }

      params.delete('auth_provider')
      params.delete('auth_source')
      const clean = params.toString()
      const nextUrl = window.location.pathname + (clean ? `?${clean}` : '') + window.location.hash
      window.history.replaceState(null, '', nextUrl)
    }

    void finalizeSocialToast()
  }, [user, fetchLinkedProviders])

  // A guest is a placeholder identity with no server row, so data fetching waits
  // until a real session exists.
  return <AppContent user={user} hasSession={Boolean(session?.user)} sessionResolved={sessionResolved} refetchSession={refetchSession} ensureAnonymousSession={ensureAnonymousSession} onBeforeSignOut={() => { explicitSignOutRef.current = true }} />
}

function AppContent({ user, hasSession, sessionResolved, refetchSession, ensureAnonymousSession, onBeforeSignOut }: { user: UserInfo; hasSession: boolean; sessionResolved: boolean; refetchSession: () => Promise<unknown>; ensureAnonymousSession: () => Promise<boolean>; onBeforeSignOut: () => void }) {
  const { tab, subId, navigate, handleTabChange } = useHashRouter()
  const [showAddPhotos, setShowAddPhotos] = useState(false)
  const data = useWingDexData(user.id, { hasSession })

  // Everything an anonymous account holds is the user's own now, and it lives
  // only in this browser.
  const hasUnsavedSightings = user.isAnonymous
    && hasSession
    && (data.isLoading || data.outings.length > 0 || data.observations.length > 0)

  const { openSignIn, authGateModal } = useAuthGate({
    isAnonymous: user.isAnonymous,
    hasUnsavedSightings,
    onUpgraded: async () => {
      await refetchSession()
      navigate('home')
    },
  })

  const [wingDexSearchQuery, setWingDexSearchQuery] = useState('')
  const [wingDexSortField, setWingDexSortField] = useState<WingDexSortField>('date')
  const [wingDexSortDir, setWingDexSortDir] = useState<WingDexSortDir>('desc')
  const [outingsSearchQuery, setOutingsSearchQuery] = useState('')
  const [outingsSortField, setOutingsSortField] = useState<OutingSortField>('date')
  const [outingsSortDir, setOutingsSortDir] = useState<OutingSortDir>('desc')
  const { resolvedTheme } = useTheme()

  const prefetchAddPhotosFlow = useCallback(() => {
    void loadAddPhotosFlow()
    void import('@/lib/photo-utils')
    void import('@/lib/clustering')
  }, [])

  const handleAddPhotos = useCallback(() => {
    // No sign-up gate. Identification runs on-device, so an anonymous visitor
    // costs nothing to serve, and gating the core feature behind an account was
    // asking for commitment before showing any value. Signing up is now about
    // keeping the results: an anonymous account lives in one browser and is lost
    // when cookies are cleared, while a passkey makes it durable and portable.
    //
    // The flow still uploads and persists under a real user id, so the anonymous
    // account has to exist. Open the dialog first and create it in the
    // background: the first step is photo selection, which needs no identity,
    // and on a cold worker the round trip is slow enough to feel like a dead
    // click. If it fails, close again and surface the error.
    setShowAddPhotos(true)
    void ensureAnonymousSession().then((ok) => {
      if (!ok) {
        setShowAddPhotos(false)
        toast.error('Could not start a session. Please try again.')
      }
    })
  }, [ensureAnonymousSession])

  // Prompt to sign up exactly once, at the first save rather than the first
  // identification: saving is the moment there is something to lose. If they
  // decline, the avatar badge carries the message from then on.
  const promptSignupOnCloseRef = useRef<string | null>(null)

  const handleOutingSaved = useCallback(() => {
    if (!user.isAnonymous || !hasSession) return
    try {
      if (window.localStorage.getItem(signupPromptKey(user.id))) return
    } catch {
      // Without storage there is no way to remember a decline, and a prompt
      // that cannot promise "once" is worse than no prompt.
      return
    }
    promptSignupOnCloseRef.current = user.id
  }, [hasSession, user.id, user.isAnonymous])

  const handleCloseAddPhotos = useCallback(() => {
    setShowAddPhotos(false)
    const promptedUserId = promptSignupOnCloseRef.current
    if (!promptedUserId) return
    promptSignupOnCloseRef.current = null
    try {
      window.localStorage.setItem(signupPromptKey(promptedUserId), '1')
    } catch {
      return
    }
    openSignIn()
  }, [openSignIn])

  const handleSelectOuting = useCallback((id: string) => {
    navigate('outings', id)
  }, [navigate])

  const handleSelectOutingOptional = useCallback((id: string | null) => {
    navigate('outings', id ?? undefined)
  }, [navigate])

  const handleSelectSpecies = useCallback((name: string) => {
    navigate('wingdex', name)
  }, [navigate])

  const handleSelectSpeciesOptional = useCallback((name: string | null) => {
    navigate('wingdex', name ?? undefined)
  }, [navigate])

  const handleNavigate = useCallback((tab: string) => {
    navigate(tab)
  }, [navigate])

  const toggleWingDexSort = useCallback((field: WingDexSortField) => {
    if (wingDexSortField === field) {
      setWingDexSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'))
      return
    }

    setWingDexSortField(field)
    setWingDexSortDir(field === 'name' || field === 'family' ? 'asc' : 'desc')
  }, [wingDexSortField])

  const toggleOutingsSort = useCallback((field: OutingSortField) => {
    if (outingsSortField === field) {
      setOutingsSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'))
      return
    }

    setOutingsSortField(field)
    setOutingsSortDir(field === 'name' ? 'asc' : 'desc')
  }, [outingsSortField])

  // Sync <meta name="theme-color"> with current theme (#17)
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) {
      meta.setAttribute('content', resolvedTheme === 'dark' ? '#262e29' : '#e5ddd0')
    }
  }, [resolvedTheme])

  // Settings stays behind sign-up. Identification is free, but keeping and
  // moving data (import, export, passkeys, profile) is what an account is for.
  useEffect(() => {
    if (user.isAnonymous && tab === 'settings') {
      navigate('home')
    }
  }, [user.isAnonymous, tab, navigate])

  useEffect(() => {
    let idleCallbackId: number | null = null
    let timeoutId: number | null = null

    if (typeof window.requestIdleCallback === 'function') {
      idleCallbackId = window.requestIdleCallback(() => {
        prefetchAddPhotosFlow()
      })
    } else {
      timeoutId = window.setTimeout(() => {
        prefetchAddPhotosFlow()
      }, 300)
    }

    return () => {
      if (idleCallbackId !== null && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleCallbackId)
      }
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId)
      }
    }
  }, [prefetchAddPhotosFlow])

  const navItems = [
    { value: 'wingdex', label: 'WingDex', icon: BirdLogo },
    { value: 'outings', label: 'Outings', icon: MapPin },
  ]
  const avatarColorClass = getEmojiAvatarColor(user.image)
  const isEmojiAvatar = avatarColorClass.length > 0

  return (
    <div className="min-h-dvh bg-background flex flex-col">
      <Toaster position="bottom-center" />

      <Tabs value={tab} onValueChange={handleTabChange} activationMode="manual" className="flex-1 flex flex-col">
        {/* ── Top header, fixed at top so iOS Safari doesn't invalidate
              the compositor layer during programmatic scrollTo jumps ── */}
        <header className="fixed top-0 left-0 right-0 z-40 bg-background/80 backdrop-blur-xl">
          <div className="max-w-3xl mx-auto px-4 sm:px-6">
            <div className="flex items-center justify-between h-14 sm:h-16">
              {/* Logo, navigates to Home */}
              <button
                onClick={() => navigate('home')}
                className="flex items-center gap-2 cursor-pointer press-feel-light"
                aria-label="Home"
              >
                <BirdLogo size={32} className="text-primary" duotone />
              </button>

              {/* Nav tabs, WingDex + Outings (Home via logo, Settings via avatar) */}
              <TabsList className="flex bg-transparent gap-1 h-auto p-0">
                {navItems.map(item => (
                  <TabsTrigger
                    key={item.value}
                    value={item.value}
                    onClick={() => {
                      if (item.value === tab && subId) navigate(item.value)
                    }}
                    className="flex items-center gap-1.5 px-3 py-1.5 sm:px-4 sm:py-2 rounded-md text-sm font-medium cursor-pointer
                      data-[state=active]:bg-primary/10 data-[state=active]:text-primary
                      data-[state=inactive]:text-muted-foreground hover:bg-[var(--pressed-highlight-hover)]
                      press-feel-tab"
                  >
                    <item.icon size={18} />
                    {item.label}
                  </TabsTrigger>
                ))}
              </TabsList>

              {/* Right side: generic icon until an account exists, then the bird avatar */}
              <div className="flex items-center gap-3">
                {!sessionResolved ? (
                  // A returning user would otherwise be shown the logged-out
                  // button for the length of the session check. Hold the slot
                  // instead of guessing wrong, and keep the body painting.
                  <div className="h-8 w-8" aria-hidden="true" />
                ) : !hasSession ? (
                  <button
                    onClick={() => openSignIn()}
                    className="inline-flex items-center justify-center rounded-md text-primary cursor-pointer press-feel-light h-8 w-8"
                    aria-label="Log in"
                    title="Log in"
                  >
                    <UserCircle size={26} weight="duotone" />
                  </button>
                ) : (
                  <button
                    onClick={user.isAnonymous ? () => openSignIn() : () => navigate('settings')}
                    className="relative cursor-pointer press-feel"
                    aria-label={user.isAnonymous ? 'Log in' : 'Settings'}
                    title={user.isAnonymous ? 'Log in' : undefined}
                  >
                    <Avatar className={`h-8 w-8 ${avatarColorClass || 'bg-muted'}`}>
                      <AvatarImage
                        src={user.image}
                        alt={user.isAnonymous ? '' : user.name}
                        className={isEmojiAvatar ? 'scale-[0.65] object-contain' : 'object-cover'}
                      />
                      <AvatarFallback className="bg-muted text-muted-foreground text-xs">{user.name[0].toUpperCase()}</AvatarFallback>
                    </Avatar>
                    {hasUnsavedSightings && (
                      <span
                        role="status"
                        aria-label="These sightings are only on this device"
                        title="These sightings are only on this device"
                        className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-yellow-400 ring-2 ring-background"
                      />
                    )}
                  </button>
                )}
              </div>
            </div>
          </div>
        </header>

        {/* Spacer for fixed header */}
        <div className="h-14 sm:h-16 shrink-0" />

        {/* ── Main content ────────────────────────────────── */}
        <main className="w-full max-w-3xl mx-auto pb-8 flex-1">
          {tab === 'home' && (
            <TabsContent value="home" className="mt-0">
              <HomePage
                data={data}
                onAddPhotos={handleAddPhotos}
                onAddPhotosIntent={prefetchAddPhotosFlow}
                onSelectOuting={handleSelectOuting}
                onSelectSpecies={handleSelectSpecies}
                onNavigate={handleNavigate}
              />
            </TabsContent>
          )}

          {tab === 'outings' && (
            <TabsContent value="outings" className="mt-0">
              <Suspense fallback={null}>
                <OutingsPage
                  data={data}
                  selectedOutingId={subId ?? null}
                  onSelectOuting={handleSelectOutingOptional}
                  onSelectSpecies={handleSelectSpecies}
                  searchQuery={outingsSearchQuery}
                  onSearchQueryChange={setOutingsSearchQuery}
                  sortField={outingsSortField}
                  sortDir={outingsSortDir}
                  onToggleSort={toggleOutingsSort}
                />
              </Suspense>
            </TabsContent>
          )}

          {tab === 'wingdex' && (
            <TabsContent value="wingdex" className="mt-0">
              <Suspense fallback={null}>
                <WingDexPage
                  data={data}
                  selectedSpecies={subId ?? null}
                  onSelectSpecies={handleSelectSpeciesOptional}
                  onSelectOuting={handleSelectOuting}
                  onAddPhotos={handleAddPhotos}
                  onAddPhotosIntent={prefetchAddPhotosFlow}
                  searchQuery={wingDexSearchQuery}
                  onSearchQueryChange={setWingDexSearchQuery}
                  sortField={wingDexSortField}
                  sortDir={wingDexSortDir}
                  onToggleSort={toggleWingDexSort}
                />
              </Suspense>
            </TabsContent>
          )}

          {tab === 'settings' && (
            <TabsContent value="settings" className="mt-0">
              <Suspense fallback={null}>
                <SettingsPage
                  data={data}
                  user={user}
                  onSignIn={openSignIn}
                  onSignedOut={() => { onBeforeSignOut(); navigate('home') }}
                  onProfileUpdated={refetchSession}
                />
              </Suspense>
            </TabsContent>
          )}

          {tab === 'terms' && (
            <TabsContent value="terms" className="mt-0">
              <Suspense fallback={null}>
                <TermsPage />
              </Suspense>
            </TabsContent>
          )}

          {tab === 'privacy' && (
            <TabsContent value="privacy" className="mt-0">
              <Suspense fallback={null}>
                <PrivacyPage />
              </Suspense>
            </TabsContent>
          )}
        </main>
      </Tabs>

      {authGateModal}

      {showAddPhotos && (
        <Suspense fallback={null}>
          <AddPhotosFlow
            data={data}
            onClose={handleCloseAddPhotos}
            onOutingSaved={handleOutingSaved}
            ensureSessionReady={ensureAnonymousSession}
            userId={user.id}
          />
        </Suspense>
      )}

      <footer className="flex flex-col-reverse items-center gap-4 px-4 pt-12 pb-10 text-xs text-muted-foreground/50 sm:flex-row sm:justify-center sm:gap-4">
        <div className="flex items-center gap-2">
          <a href="https://github.com/jlian/wingdex/blob/main/CHANGELOG.md" target="_blank" rel="noopener noreferrer" className="press-feel-light">
            WingDex™ {typeof APP_VERSION !== 'undefined' ? APP_VERSION : 'dev'}
            {__GIT_HASH__ && window.location.hostname !== 'wingdex.app' && (
              <span className="font-mono text-[10px]">
                {` (${__GIT_BRANCH__}@${__GIT_HASH__})`}
              </span>
            )}
          </a>
          <a href="https://github.com/jlian/wingdex" target="_blank" rel="noopener noreferrer" aria-label="GitHub" className="press-feel-light">
            <GithubLogo size={16} />
          </a>
          <a href="https://johnlian.net" target="_blank" rel="noopener noreferrer" className="press-feel-light">By John Lian</a>
        </div>
        <nav className="flex items-center gap-4">
          <a href="/#privacy" className="press-feel-light">Privacy</a>
          <a href="/#terms" className="press-feel-light">Terms</a>
          <a href="https://github.com/jlian/wingdex/issues" target="_blank" rel="noopener noreferrer" className="press-feel-light">Issues?</a>
        </nav>
      </footer>

    </div>
  )
}

export default App
