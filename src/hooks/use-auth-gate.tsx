import { useState, useCallback, useRef } from 'react'
import { Key, GithubLogo, AppleLogo, GoogleChromeLogo, DownloadSimple } from '@phosphor-icons/react'
import { toast } from 'sonner'

import { authClient } from '@/lib/auth-client'
import { fetchWithLocalAuthRetry } from '@/lib/local-auth-fetch'
import { assertWingDexApiResponse } from '@/lib/api-error'
import { logClientFailure } from '@/lib/client-log'
import { generateBirdName } from '@/lib/fun-names'
import { buildPasskeyName, getDeviceLabelFromNavigator, isPasskeyCancellationLike } from '@/lib/passkey-label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

/** Safely extract error code from Better Auth error union */
function errCode(err: { code?: string; message?: string }): string | undefined {
  return 'code' in err ? err.code : undefined
}

interface AuthGateOptions {
  isAnonymous: boolean
  /** Anonymous sightings that signing in to another account would leave behind. */
  hasUnsavedSightings?: boolean
  onUpgraded: () => void | Promise<void>
}

/**
 * Hook that gates actions behind authentication.
 * Returns `openSignIn()` to open the auth modal. Nothing gates on having an
 * account: identification runs on-device, so signing up is about making data
 * durable rather than unlocking a feature.
 * If user is already authenticated, runs the callback immediately.
 * Also returns `authGateModal` element to render once in the tree.
 */
export function useAuthGate({ isAnonymous, hasUnsavedSightings, onUpgraded }: AuthGateOptions) {
  const [open, setOpen] = useState(false)

  const openSignIn = useCallback(() => {
    setOpen(true)
  }, [])

  const handleUpgraded = useCallback(async () => {
    setOpen(false)
    await onUpgraded()
  }, [onUpgraded])

  const modal = (
    <AuthGateModal
      open={open}
      onOpenChange={setOpen}
      hasUnsavedSightings={hasUnsavedSightings}
      onUpgraded={handleUpgraded}
    />
  )

  return { openSignIn, authGateModal: modal }
}

// -- Modal ------------------------------------------------

type SignInIntent = { kind: 'passkey' } | { kind: 'social'; provider: 'github' | 'apple' | 'google' }

interface AuthGateModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  hasUnsavedSightings?: boolean
  onUpgraded: () => void
}

function AuthGateModal({
  open,
  onOpenChange,
  hasUnsavedSightings,
  onUpgraded,
}: AuthGateModalProps) {
  const dialogContentRef = useRef<HTMLDivElement | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [pendingSignIn, setPendingSignIn] = useState<SignInIntent | null>(null)
  const visibleProviders = ['github', 'apple', 'google'] as const

  const buildSocialCallbackURL = (provider: 'github' | 'apple' | 'google'): string => {
    if (typeof window === 'undefined') return '/'
    const params = new URLSearchParams()
    params.set('auth_provider', provider)
    params.set('auth_source', 'social')
    return `/?${params.toString()}`
  }

  const handleSignUpWithPasskey = async () => {
    setErrorMessage(null)
    setIsLoading(true)

    // One ceremony (#271). Registration now starts unauthenticated and the
    // server creates the user, the passkey and the session together, so there
    // is no anonymous account to mint first and promote afterwards. The server
    // sets the session cookie on the same response.
    const birdName = generateBirdName()
    const passkeyName = buildPasskeyName(getDeviceLabelFromNavigator(), birdName)

    const passkeyResult = await authClient.passkey.addPasskey({
      name: passkeyName,
      authenticatorAttachment: 'platform',
      createSession: true,
    })
    if (passkeyResult.error) {
      setIsLoading(false)
      if (isPasskeyCancellationLike(passkeyResult.error)) {
        return
      } else if (errCode(passkeyResult.error) === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') {
        setErrorMessage('This device already has a passkey. Try Log in instead.')
      } else {
        setErrorMessage(passkeyResult.error.message || 'Passkey registration failed.')
      }
      return
    }

    // A cancelled or failed ceremony never reaches here: the server rolls back
    // user, passkey and session together, so there is no half-made account to
    // clean up. Guard anyway, since a missing session would otherwise surface
    // much later as a confusing signed-out state.
    const created = passkeyResult.data as { session?: unknown; user?: unknown } | undefined
    if (!created?.session || !created?.user) {
      logClientFailure('auth/passkey/register', new Error('verify-registration returned no session'))
      setIsLoading(false)
      setErrorMessage('Account setup failed. Please try again.')
      return
    }

    setIsLoading(false)
    toast.success('Signed up with passkey')
    onUpgraded()
  }

  const handlePasskeySignIn = async () => {
    setErrorMessage(null)
    setIsLoading(true)

    const result = await authClient.signIn.passkey({ autoFill: false })
    if (result.error) {
      setIsLoading(false)
      if (isPasskeyCancellationLike(result.error)) {
        return
      } else {
        setErrorMessage(result.error.message || 'Passkey sign-in failed.')
      }
      return
    }

    // Verify it's a real (non-anonymous) session
    const sessionResult = await authClient.getSession()
    const isAnonymous = Boolean(
      (sessionResult.data?.user as { isAnonymous?: boolean } | undefined)?.isAnonymous,
    )
    if (isAnonymous || !sessionResult.data?.user) {
      await authClient.signOut()
      setIsLoading(false)
      setErrorMessage('No account found for that passkey.')
      return
    }

    setIsLoading(false)
    toast.success('Signed in with passkey')
    onUpgraded()
  }

  const handleSocialSignIn = (provider: 'github' | 'apple' | 'google') => {
    setErrorMessage(null)
    void authClient.signIn.social({
      provider,
      callbackURL: buildSocialCallbackURL(provider),
      errorCallbackURL: '/',
    })
  }

  /**
   * Signing in swaps to a different account, so anonymous sightings are left
   * behind. Signing up does not: it upgrades the anonymous user in place and
   * keeps the id. So this warns on the log-in paths only, and once per attempt
   * rather than any time the modal is open.
   */
  const requestSignIn = (intent: SignInIntent) => {
    if (hasUnsavedSightings) {
      setPendingSignIn(intent)
      return
    }
    runSignIn(intent)
  }

  const runSignIn = (intent: SignInIntent) => {
    if (intent.kind === 'passkey') {
      void handlePasskeySignIn()
      return
    }
    handleSocialSignIn(intent.provider)
  }

  // Runs against the session that is about to be replaced, so it has to happen
  // before the ceremony rather than after it.
  const handleExportSightings = async () => {
    setIsExporting(true)
    setErrorMessage(null)
    try {
      const response = await fetchWithLocalAuthRetry('/api/export/sightings', { credentials: 'include' })
      await assertWingDexApiResponse(response, 'Export failed')

      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `wingdex-sightings-${new Date().toISOString().split('T')[0]}.csv`
      a.click()
      URL.revokeObjectURL(url)
      toast.success('Sightings CSV exported')
    } catch (error) {
      logClientFailure('export/sightings/export', error)
      setErrorMessage('Could not export your sightings. Please try again.')
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setPendingSignIn(null)
        onOpenChange(next)
      }}
    >
      <DialogContent
        ref={dialogContentRef}
        className="sm:max-w-md outline-none"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          window.requestAnimationFrame(() => {
            dialogContentRef.current?.focus({ preventScroll: true })
          })
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {hasUnsavedSightings ? 'Keep your WingDex' : 'Start your WingDex'}
          </DialogTitle>
          {hasUnsavedSightings && (
            <p className="text-sm text-muted-foreground">
              Your sightings are saved, but only in this browser. They go away if you
              clear your cookies or switch devices. An account keeps them, and unlocks
              import and export. It takes one tap and no email.
            </p>
          )}
          <DialogDescription>
            By continuing you accept{' '}
            <a
              href="#terms"
              onClick={() => onOpenChange(false)}
              className="text-primary underline-offset-4 hover:underline"
            >
              Terms of Use
            </a>{' '}
            and{' '}
            <a
              href="#privacy"
              onClick={() => onOpenChange(false)}
              className="text-primary underline-offset-4 hover:underline"
            >
              Privacy Policy
            </a>
          </DialogDescription>
        </DialogHeader>

        {pendingSignIn && (
          <SignInDataWarning
            isBusy={isLoading}
            isExporting={isExporting}
            errorMessage={errorMessage}
            onExport={() => void handleExportSightings()}
            onContinue={() => runSignIn(pendingSignIn)}
            onBack={() => setPendingSignIn(null)}
          />
        )}

        <div className={`space-y-3 pt-1 min-h-[280px] ${pendingSignIn ? 'hidden' : ''}`}>
          {/* Social providers -- top, like Reddit */}
          {visibleProviders.length > 0 && (
            <div className="space-y-2">
              {visibleProviders.includes('github') && (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => requestSignIn({ kind: 'social', provider: 'github' })}
                  disabled={isLoading}
                >
                  <GithubLogo size={18} className="mr-2" />
                  Continue with GitHub
                </Button>
              )}
              {visibleProviders.includes('apple') && (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => requestSignIn({ kind: 'social', provider: 'apple' })}
                  disabled={isLoading}
                >
                  <AppleLogo size={18} className="mr-2" />
                  Continue with Apple
                </Button>
              )}
              {visibleProviders.includes('google') && (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => requestSignIn({ kind: 'social', provider: 'google' })}
                  disabled={isLoading}
                >
                  <GoogleChromeLogo size={18} className="mr-2" />
                  Continue with Google
                </Button>
              )}
            </div>
          )}

          {/* OR divider */}
          {visibleProviders.length > 0 && (
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-background px-2 text-muted-foreground">or</span>
            </div>
          </div>
          )}

          {/* Passkey */}
          <div className="space-y-3 rounded-lg border border-border/70 bg-muted/20 px-3 py-3">
            <p className="flex items-center justify-center gap-2 text-sm font-medium text-foreground">
              <Key size={18} />
              Continue with a Passkey
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Button
                className="w-full"
                onClick={() => requestSignIn({ kind: 'passkey' })}
                disabled={isLoading}
              >
                {isLoading ? 'Working…' : 'Log in'}
              </Button>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => void handleSignUpWithPasskey()}
                disabled={isLoading}
              >
                {isLoading ? 'Working…' : 'Sign up'}
              </Button>
            </div>
          </div>

          {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SignInDataWarning({
  isBusy,
  isExporting,
  errorMessage,
  onExport,
  onContinue,
  onBack,
}: {
  isBusy: boolean
  isExporting: boolean
  errorMessage: string | null
  onExport: () => void
  onContinue: () => void
  onBack: () => void
}) {
  return (
    <div className="space-y-3 pt-1 min-h-[280px]">
      <div className="space-y-2 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-3 py-3">
        <p className="text-sm font-medium text-foreground">These sightings will not move</p>
        <p className="text-xs text-muted-foreground">
          Continuing switches this browser to the account you log in to. These sightings
          will not appear there, so export them first if you want a copy.
        </p>
        <p className="text-xs text-muted-foreground">
          Signing up instead keeps them: it turns this browser&rsquo;s sightings into an account.
        </p>
      </div>

      <Button
        variant="outline"
        className="w-full"
        onClick={onExport}
        disabled={isBusy || isExporting}
      >
        <DownloadSimple size={18} className="mr-2" />
        {isExporting ? 'Exporting…' : 'Export sightings as CSV'}
      </Button>

      <Button className="w-full" onClick={onContinue} disabled={isBusy}>
        {isBusy ? 'Working…' : 'Continue to log in'}
      </Button>

      <Button variant="ghost" className="w-full" onClick={onBack} disabled={isBusy}>
        Back
      </Button>

      {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}
    </div>
  )
}
