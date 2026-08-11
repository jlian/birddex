import { useState, useCallback, useRef } from 'react'
import { Key, GithubLogo, AppleLogo, GoogleChromeLogo } from '@phosphor-icons/react'
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
import { Switch } from '@/components/ui/switch'

/** Safely extract error code from Better Auth error union */
function errCode(err: { code?: string; message?: string }): string | undefined {
  return 'code' in err ? err.code : undefined
}

interface AuthGateOptions {
  isAnonymous: boolean
  onUpgraded: () => void | Promise<void>
  demoDataEnabled?: boolean
  onSetDemoDataEnabled?: (enabled: boolean) => Promise<void> | void
}

/**
 * Hook that gates actions behind authentication.
 * Returns `requireAuth(callback)` -- if user is anonymous, opens auth modal.
 * If user is already authenticated, runs the callback immediately.
 * Also returns `authGateModal` element to render once in the tree.
 */
export function useAuthGate({ isAnonymous, onUpgraded, demoDataEnabled, onSetDemoDataEnabled }: AuthGateOptions) {
  const [open, setOpen] = useState(false)
  const pendingCallback = useRef<(() => void) | null>(null)

  const requireAuth = useCallback((callback: () => void) => {
    if (!isAnonymous) {
      callback()
      return
    }
    pendingCallback.current = callback
    setOpen(true)
  }, [isAnonymous])

  const openSignIn = useCallback(() => {
    pendingCallback.current = null
    setOpen(true)
  }, [])

  const handleUpgraded = useCallback(async () => {
    setOpen(false)
    await onUpgraded()
    const callback = pendingCallback.current
    pendingCallback.current = null
    callback?.()
  }, [onUpgraded])

  const modal = (
    <AuthGateModal
      open={open}
      onOpenChange={setOpen}
      onUpgraded={handleUpgraded}
      demoDataEnabled={demoDataEnabled}
      onSetDemoDataEnabled={onSetDemoDataEnabled}
    />
  )

  return { requireAuth, openSignIn, authGateModal: modal }
}

// -- Modal ------------------------------------------------

interface AuthGateModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onUpgraded: () => void
  demoDataEnabled?: boolean
  onSetDemoDataEnabled?: (enabled: boolean) => Promise<void> | void
}

function AuthGateModal({
  open,
  onOpenChange,
  onUpgraded,
  demoDataEnabled,
  onSetDemoDataEnabled,
}: AuthGateModalProps) {
  const dialogContentRef = useRef<HTMLDivElement | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isTogglingDemo, setIsTogglingDemo] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
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

  const handleDemoToggle = async (enabled: boolean) => {
    if (!onSetDemoDataEnabled) return
    setIsTogglingDemo(true)
    setErrorMessage(null)
    try {
      await onSetDemoDataEnabled(enabled)
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown error'
      setErrorMessage(`Demo data update failed: ${detail}`)
    } finally {
      setIsTogglingDemo(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
          <DialogTitle>Start your WingDex</DialogTitle>
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

        <div className="space-y-3 pt-1 min-h-[280px]">
          {/* Social providers -- top, like Reddit */}
          {visibleProviders.length > 0 && (
            <div className="space-y-2">
              {visibleProviders.includes('github') && (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => handleSocialSignIn('github')}
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
                  onClick={() => handleSocialSignIn('apple')}
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
                  onClick={() => handleSocialSignIn('google')}
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
                onClick={() => void handlePasskeySignIn()}
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

          {typeof demoDataEnabled === 'boolean' && onSetDemoDataEnabled && (
            <div className="pt-1">
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Demo data</p>
                  <p className="text-xs text-muted-foreground">Preview WingDex with sample sightings</p>
                </div>
                <Switch
                  checked={demoDataEnabled}
                  onCheckedChange={(checked) => void handleDemoToggle(checked)}
                  disabled={isLoading || isTogglingDemo}
                  aria-label="Toggle demo data"
                />
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
