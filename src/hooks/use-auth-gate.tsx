import { useState, useCallback, useRef } from 'react'
import { Key, GithubLogo, AppleLogo, GoogleChromeLogo } from '@phosphor-icons/react'
import { toast } from 'sonner'

import { authClient } from '@/lib/auth-client'
import { discardPendingAccountMergeToken, finalizeAccountMerge, prepareAccountMerge } from '@/lib/account-merge'
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
      isAnonymous={isAnonymous}
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
  isAnonymous: boolean
  hasUnsavedSightings?: boolean
  onUpgraded: () => void
}

function AuthGateModal({
  open,
  onOpenChange,
  isAnonymous,
  hasUnsavedSightings,
  onUpgraded,
}: AuthGateModalProps) {
  const dialogContentRef = useRef<HTMLDivElement | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const visibleProviders = ['github', 'apple', 'google'] as const

  const buildSocialCallbackURL = (provider: 'github' | 'apple' | 'google'): string => {
    if (typeof window === 'undefined') return '/'
    const params = new URLSearchParams()
    params.set('auth_provider', provider)
    params.set('auth_source', 'social')
    return `/?${params.toString()}`
  }

  const prepareCurrentAnonymousMerge = async (
    authMethod: 'github' | 'apple' | 'google' | 'passkey',
  ): Promise<string | null> => {
    if (!isAnonymous) return null
    const current = await authClient.getSession()
    const currentIsAnonymous = Boolean(
      (current.data?.user as { isAnonymous?: boolean } | undefined)?.isAnonymous,
    )
    return currentIsAnonymous ? prepareAccountMerge(authMethod) : null
  }

  const handleSignUpWithPasskey = async () => {
    setErrorMessage(null)
    setIsLoading(true)

    let mergeToken: string | null = null
    try {
      mergeToken = await prepareCurrentAnonymousMerge('passkey')
    } catch (error) {
      logClientFailure('auth/account-merge/prepare', error)
      setIsLoading(false)
      setErrorMessage('Could not prepare your WingDex for account setup. Please try again.')
      return
    }

    // Better Auth creates a sessionless account transactionally, or promotes
    // the current anonymous owner in place when one already exists.
    const birdName = generateBirdName()
    const passkeyName = buildPasskeyName(getDeviceLabelFromNavigator(), birdName)

    const passkeyResult = await authClient.passkey.addPasskey({
      name: passkeyName,
      authenticatorAttachment: 'platform',
      createSession: true,
    })
    if (passkeyResult.error) {
      discardPendingAccountMergeToken()
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

    // A cancelled or failed sessionless ceremony leaves no account behind. An
    // existing anonymous account remains unchanged until verification succeeds.
    const created = passkeyResult.data as { session?: unknown; user?: unknown } | undefined
    if (!created?.session || !created?.user) {
      logClientFailure('auth/passkey/register', new Error('verify-registration returned no session'))
      setIsLoading(false)
      setErrorMessage('Account setup failed. Please try again.')
      return
    }

    try {
      if (mergeToken) await finalizeAccountMerge(mergeToken)
    } catch (error) {
      logClientFailure('auth/account-merge/finalize', error)
      setIsLoading(false)
      setErrorMessage('Your account is ready, but your WingDex still needs to be kept. Please try again.')
      return
    }
    setIsLoading(false)
    toast.success('Signed up with passkey')
    onUpgraded()
  }

  const handlePasskeySignIn = async () => {
    setErrorMessage(null)
    setIsLoading(true)

    let mergeToken: string | null
    try {
      mergeToken = await prepareCurrentAnonymousMerge('passkey')
    } catch (error) {
      logClientFailure('auth/account-merge/prepare', error)
      setIsLoading(false)
      setErrorMessage('Could not prepare your WingDex for login. Please try again.')
      return
    }
    const result = await authClient.signIn.passkey({ autoFill: false })
    if (result.error) {
      discardPendingAccountMergeToken()
      setIsLoading(false)
      if (isPasskeyCancellationLike(result.error)) {
        return
      } else {
        setErrorMessage(result.error.message || 'Passkey sign-in failed.')
      }
      return
    }

    if (mergeToken) {
      try {
        await finalizeAccountMerge(mergeToken)
      } catch (error) {
        logClientFailure('auth/account-merge/finalize', error)
        setIsLoading(false)
        setErrorMessage('Signed in, but your WingDex still needs to be kept. Please try again.')
        return
      }
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

  const handleSocialSignIn = async (provider: 'github' | 'apple' | 'google') => {
    setErrorMessage(null)
    setIsLoading(true)
    try {
      await prepareCurrentAnonymousMerge(provider)
      await authClient.signIn.social({
        provider,
        callbackURL: buildSocialCallbackURL(provider),
        errorCallbackURL: '/',
      })
    } catch (error) {
      discardPendingAccountMergeToken()
      logClientFailure('auth/social/sign-in', error)
      setIsLoading(false)
      setErrorMessage('Could not continue with that provider. Please try again.')
    }
  }

  const requestSignIn = (intent: SignInIntent) => {
    runSignIn(intent)
  }

  const runSignIn = (intent: SignInIntent) => {
    if (intent.kind === 'passkey') {
      void handlePasskeySignIn()
      return
    }
    void handleSocialSignIn(intent.provider)
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

        <div className="space-y-3 pt-1 min-h-[280px]">
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
