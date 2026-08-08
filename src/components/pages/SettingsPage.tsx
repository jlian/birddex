import { useEffect, useMemo, useRef, useState } from 'react'
import { useTheme } from 'next-themes'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Confetti } from '@/components/ui/confetti'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Download, Upload, Info, Database, CaretDown, Sun, Moon, Desktop, Trash, GlobeHemisphereWest, Key, SignOut, ArrowsClockwise, PencilSimple } from '@phosphor-icons/react'
import { authClient } from '@/lib/auth-client'
import { fetchWithLocalAuthRetry, isLocalRuntime } from '@/lib/local-auth-fetch'
import { generateBirdName, emojiForBirdName, emojiAvatarDataUrl } from '@/lib/fun-names'
import { buildPasskeyName, getDeviceLabelFromNavigator, isPasskeyCancellationLike, toStandardPasskeyLabel } from '@/lib/passkey-label'
import { toast } from 'sonner'
import { clientLog, logClientFailure } from '@/lib/client-log'
import { generateTraceparent } from '@/lib/trace'
import demoCsv from '@/assets/ebird-import.csv?raw'
import type { WingDexDataStore } from '@/hooks/use-wingdex-data'

function errCode(err: { code?: string; message?: string }): string | undefined {
  return 'code' in err ? err.code : undefined
}

interface SettingsPageProps {
  data: WingDexDataStore
  user: {
    id: string
    name: string
    image: string
    email: string
    isAnonymous: boolean
  }
  onSignIn?: () => void
  onSignedOut?: () => void
  onProfileUpdated?: () => Promise<unknown> | void
}

const birdEmojiOptions = ['🐦', '🦉', '🦜', '🐧', '🦆', '🦩', '🦅', '🐤'] as const

function isEmojiAvatarDataUrl(value: string): boolean {
  return value.startsWith('data:image/svg+xml')
}



function getDeviceLabel(): string {
  return getDeviceLabelFromNavigator()
}



export default function SettingsPage({ data, user, onSignIn, onSignedOut, onProfileUpdated }: SettingsPageProps) {
  const importFileRef = useRef<HTMLInputElement>(null)
  const [showEBirdHelp, setShowEBirdHelp] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [showConfetti, setShowConfetti] = useState(false)
  const [deleteStep, setDeleteStep] = useState<'choose' | 'confirm-account' | null>(null)
  const [isDeletingAccount, setIsDeletingAccount] = useState(false)
  const [useGeoContext, setUseGeoContext] = useState(() => {
    const stored = localStorage.getItem('wingdex_useGeoContext')
    return stored === null ? true : stored === 'true'
  })
  const [mounted, setMounted] = useState(false)
  const [profileTimezone, setProfileTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles'
  )
  const { theme, setTheme } = useTheme()

  // Compute timezone option labels with current UTC offset (DST-aware)
  const timezoneOptions = useMemo(() => {
    const zones = [
      { value: 'Pacific/Honolulu', region: 'Hawaii' },
      { value: 'America/Anchorage', region: 'Alaska' },
      { value: 'America/Los_Angeles', region: 'Pacific' },
      { value: 'America/Denver', region: 'Mountain' },
      { value: 'America/Chicago', region: 'Central' },
      { value: 'America/New_York', region: 'Eastern' },
      { value: 'America/Puerto_Rico', region: 'Atlantic' },
      { value: 'America/Sao_Paulo', region: 'Brazil' },
      { value: 'America/Argentina/Buenos_Aires', region: 'Argentina' },
      { value: 'America/Bogota', region: 'Colombia' },
      { value: 'America/Mexico_City', region: 'Mexico' },
      { value: 'Europe/London', region: 'London' },
      { value: 'Europe/Paris', region: 'Central Europe' },
      { value: 'Europe/Helsinki', region: 'Eastern Europe' },
      { value: 'Europe/Moscow', region: 'Moscow' },
      { value: 'Africa/Nairobi', region: 'East Africa' },
      { value: 'Africa/Lagos', region: 'West Africa' },
      { value: 'Africa/Johannesburg', region: 'South Africa' },
      { value: 'Asia/Dubai', region: 'Gulf' },
      { value: 'Asia/Kolkata', region: 'India' },
      { value: 'Asia/Bangkok', region: 'Southeast Asia' },
      { value: 'Asia/Shanghai', region: 'China' },
      { value: 'Asia/Taipei', region: 'Taipei' },
      { value: 'Asia/Tokyo', region: 'Japan' },
      { value: 'Asia/Seoul', region: 'Korea' },
      { value: 'Australia/Perth', region: 'Western Australia' },
      { value: 'Australia/Sydney', region: 'Eastern Australia' },
      { value: 'Pacific/Auckland', region: 'New Zealand' },
    ]
    const now = new Date()
    return zones.map(z => {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: z.value, timeZoneName: 'shortOffset' }).formatToParts(now)
      const offset = (parts.find(p => p.type === 'timeZoneName')?.value ?? 'GMT').replace('GMT', 'UTC')
      return { value: z.value, label: `${offset} - ${z.region}` }
    })
  }, [])

  // Passkey management
  const [passkeys, setPasskeys] = useState<Array<{ id: string; name?: string; createdAt: Date }>>([]) 
  const [passkeysLoading, setPasskeysLoading] = useState(false)

  const [displayName, setDisplayName] = useState(user.name)
  const [profileImage, setProfileImage] = useState(user.image)
  const [profileSaving, setProfileSaving] = useState(false)

  // Capture the original social provider avatar so we can restore it on bird-emoji deselect
  const originalSocialImage = useRef(isEmojiAvatarDataUrl(user.image) ? '' : user.image)

  useEffect(() => {
    setDisplayName(user.name)
    setProfileImage(user.image)
    // Keep the social avatar ref current (skip emoji data-URLs)
    if (!isEmojiAvatarDataUrl(user.image)) {
      originalSocialImage.current = user.image
    }
  }, [user.name, user.image])

  /** Fire-and-forget save for name + image. */
  const saveProfile = async (name: string, image: string) => {
    setProfileSaving(true)
    try {
      const result = await authClient.updateUser({ name: name.trim(), image })
      if (result.error) throw new Error(result.error.message || 'Update failed')
      await onProfileUpdated?.()
    } catch {
      toast.error('Failed to update profile')
    } finally {
      setProfileSaving(false)
    }
  }

  useEffect(() => {
    if (user.isAnonymous) return
    setPasskeysLoading(true)
    void authClient.passkey.listUserPasskeys().then((result) => {
      if (result.data) {
        setPasskeys(result.data.map((p) => ({
          id: p.id, name: p.name, createdAt: new Date(p.createdAt),
        })))
      }
      setPasskeysLoading(false)
    }).catch((err) => {
      logClientFailure('settings/passkeys/list', err)
      toast.error('Failed to load passkeys')
      setPasskeysLoading(false)
    })
  }, [user.isAnonymous, user.id])

  useEffect(() => {
    setMounted(true)
  }, [])

  const handleImportEBird = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    try {
      const makePreviewFormData = () => {
        const formData = new FormData()
        formData.append('file', file)
        if (profileTimezone !== 'observation-local') {
          formData.append('profileTimezone', profileTimezone)
        }
        return formData
      }

      const postPreview = () => fetchWithLocalAuthRetry('/api/import/ebird-csv', {
        method: 'POST',
        credentials: 'include',
        body: makePreviewFormData(),
      })

      let previewResponse = await postPreview()
      if (previewResponse.status === 401 && isLocalRuntime()) {
        const signInResult = await authClient.signIn.anonymous()
        if (!signInResult.error) {
          previewResponse = await postPreview()
        }
      }

      if (!previewResponse.ok) {
        const body = await previewResponse.text().catch(() => '')
        throw new Error(body || `Preview failed (${previewResponse.status})`)
      }

      const previewPayload = await previewResponse.json() as {
        previews: Array<{ previewId: string; speciesName: string; conflict?: 'new' | 'duplicate' | 'update_dates' }>
      }

      const selectedPreviewIds = previewPayload.previews
        .filter(preview => preview.conflict !== 'duplicate')
        .map(preview => preview.previewId)

      if (selectedPreviewIds.length === 0) {
        toast.error('No valid data found in CSV')
        return
      }

      const confirmResponse = await fetchWithLocalAuthRetry('/api/import/ebird-csv/confirm', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ previewIds: selectedPreviewIds }),
      })

      if (!confirmResponse.ok) {
        const body = await confirmResponse.text().catch(() => '')
        throw new Error(body || `Confirm failed (${confirmResponse.status})`)
      }

      const confirmPayload = await confirmResponse.json() as {
        imported: { outings: number; newSpecies: number }
      }

      if (confirmPayload.imported.newSpecies > 0) {
        setShowConfetti(true)
        setTimeout(() => setShowConfetti(false), 3500)
      }

      toast.success(
        `Imported eBird data across ${confirmPayload.imported.outings} outings` +
        (confirmPayload.imported.newSpecies > 0 ? ` (${confirmPayload.imported.newSpecies} new!)` : '')
      )

      await data.refresh()
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown error'
      toast.error(`Failed to import eBird data: ${detail}`)
      clientLog.error('import/ebirdCsv/import', {
        resultType: 'Failed',
        resultDescription: 'The eBird CSV import flow failed during preview, confirmation, or refresh',
      })
    }

    if (importFileRef.current) {
      importFileRef.current.value = ''
    }
  }

  const handleExportDex = async () => {
    try {
      const response = await fetchWithLocalAuthRetry('/api/export/sightings', { credentials: 'include' })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(body || `Export failed (${response.status})`)
      }

      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `wingdex-sightings-${new Date().toISOString().split('T')[0]}.csv`
      a.click()
      URL.revokeObjectURL(url)
      toast.success('Sightings CSV exported')
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown error'
      toast.error(`Failed to export sightings CSV: ${detail}`)
    }
  }

  return (
    <>
    <Confetti active={showConfetti} />
    <div className="px-4 sm:px-6 py-6 space-y-6 max-w-3xl mx-auto">
      <div>
        <h2 className="font-serif text-2xl font-semibold text-foreground">
          Settings
        </h2>
      </div>

      {user.isAnonymous && (
      <Card className="p-4 space-y-3">
        <h3 className="font-semibold text-foreground">Profile</h3>
        <p className="text-sm text-muted-foreground">
          Create account or sign in to access your saved sightings and passkeys.
        </p>
        <Button variant="outline" className="w-full justify-start" onClick={onSignIn}>
          <Key size={20} className="mr-2" />
          Create account or sign in
        </Button>
      </Card>
      )}

      {!user.isAnonymous && (
      <Card className="p-4 space-y-4">
        <div className="space-y-2">
          <h3 className="font-semibold text-foreground">Profile</h3>
          <p className="text-sm text-muted-foreground flex items-center gap-1.5">
            Welcome, <button
              type="button"
              className="text-muted-foreground cursor-pointer press-feel-light disabled:opacity-50 transition-opacity duration-200"
              disabled={profileSaving}
              onClick={() => {
                const name = generateBirdName()
                const emoji = emojiForBirdName(name)
                const image = emojiAvatarDataUrl(emoji)
                setDisplayName(name)
                setProfileImage(image)
                void saveProfile(name, image)
              }}
              aria-label="Generate new nickname"
            >
              <ArrowsClockwise size={14} weight="bold" />
            </button>
            <span className="text-foreground font-medium">{displayName}</span>
            <button
              type="button"
              className="text-muted-foreground cursor-pointer press-feel-light disabled:opacity-50 transition-opacity duration-200"
              disabled={profileSaving}
              onClick={() => {
                const nextName = window.prompt('Update display name', displayName)
                if (!nextName || nextName.trim() === displayName) return
                const trimmedName = nextName.trim()
                setDisplayName(trimmedName)
                void saveProfile(trimmedName, profileImage)
              }}
              aria-label="Edit display name"
            >
              <PencilSimple size={14} weight="bold" />
            </button>
          </p>
        </div>

        <div className="flex gap-2">
          {birdEmojiOptions.map((emoji) => {
            const emojiImage = emojiAvatarDataUrl(emoji)
            const isSelected = profileImage === emojiImage
            return (
              <button
                key={emoji}
                type="button"
                className={`h-9 w-9 rounded-md text-lg flex items-center justify-center cursor-pointer transition-all ${
                  isSelected
                    ? 'ring-2 ring-primary ring-offset-2 ring-offset-background'
                    : 'hover:scale-110'
                }`}
                disabled={profileSaving}
                onClick={() => {
                  if (isSelected) {
                    const restored = isEmojiAvatarDataUrl(originalSocialImage.current)
                      ? ''
                      : (originalSocialImage.current || '')
                    setProfileImage(restored)
                    void saveProfile(displayName, restored)
                  } else {
                    setProfileImage(emojiImage)
                    void saveProfile(displayName, emojiImage)
                  }
                }}
                aria-label={isSelected ? 'Remove avatar' : `Use ${emoji} avatar`}
              >
                {emoji}
              </button>
            )
          })}
        </div>

      </Card>
      )}

      {/* Passkeys */}
      {!user.isAnonymous && (
      <Card className="p-4 space-y-4">
        <div className="space-y-2">
          <h3 className="font-semibold text-foreground">Passkeys</h3>
          <p className="text-sm text-muted-foreground">
            Passkeys let you sign in securely with biometrics on your devices.
          </p>
        </div>
        {passkeysLoading ? (
          <p className="text-sm text-muted-foreground">Loading passkeys…</p>
        ) : passkeys.length > 0 ? (
          <div className="space-y-2">
            {passkeys.map((pk) => {
              const passkeyLabel = toStandardPasskeyLabel(pk.name, user.name)
              return <div key={pk.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Key size={16} className="shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{passkeyLabel}</p>
                    <p className="text-xs text-muted-foreground">
                      Added {pk.createdAt.toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <div className="flex items-center shrink-0 ml-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={async () => {
                      const newName = window.prompt('Rename passkey', passkeyLabel)
                      if (newName === null) return
                      const result = await authClient.passkey.updatePasskey({ id: pk.id, name: newName.trim() })
                      if (result.error) {
                        toast.error(result.error.message || 'Failed to rename passkey')
                        return
                      }
                      setPasskeys((prev) => prev.map((p) => p.id === pk.id ? { ...p, name: newName.trim() } : p))
                      toast.success('Passkey renamed')
                    }}
                  >
                    <PencilSimple size={16} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive hover:bg-destructive/10 disabled:opacity-30 disabled:pointer-events-none"
                    disabled={passkeys.length <= 1}
                    onClick={async () => {
                      const result = await authClient.passkey.deletePasskey({ id: pk.id })
                      if (result.error) {
                        toast.error(result.error.message || 'Failed to remove passkey')
                        return
                      }
                      setPasskeys((prev) => prev.filter((p) => p.id !== pk.id))
                      toast.success('Passkey removed')
                    }}
                  >
                    <Trash size={16} />
                  </Button>
                </div>
              </div>
            })}
          </div>
        ) : null}

        <Button
          variant="outline"
          className="w-full justify-start"
          onClick={async () => {
            const deviceLabel = getDeviceLabel()
            const passkeyName = buildPasskeyName(deviceLabel, user.name)
            const result = await authClient.passkey.addPasskey({
              name: passkeyName,
              authenticatorAttachment: 'platform',
            })
            if (result.error) {
              if (isPasskeyCancellationLike(result.error)) {
                return
              }
              if (errCode(result.error) === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') {
                toast.error('This device already has a passkey registered.')
              } else if (errCode(result.error) !== 'ERROR_CEREMONY_ABORTED') {
                toast.error(result.error.message || 'Failed to add passkey')
              }
              return
            }
            const listResult = await authClient.passkey.listUserPasskeys()
            if (listResult.data) {
              setPasskeys(listResult.data.map((p) => ({
                id: p.id, name: p.name, createdAt: new Date(p.createdAt),
              })))
            }
            toast.success('Passkey added')
          }}
        >
          <Key size={20} className="mr-2" />
          Add a Passkey
        </Button>
      </Card>
      )}

      {/* Appearance */}
      <Card className="p-4 space-y-4">
        <div className="space-y-2">
          <h3 className="font-semibold text-foreground">Appearance</h3>
          <p className="text-sm text-muted-foreground">
            Choose your preferred color scheme
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {([
            { value: 'light', label: 'Light', icon: Sun },
            { value: 'dark', label: 'Dark', icon: Moon },
            { value: 'system', label: 'System', icon: Desktop },
          ] as const).map(({ value, label, icon: Icon }) => (
            <Button
              key={value}
              variant={mounted && theme === value ? 'default' : 'outline'}
              className="flex flex-col items-center gap-1.5 h-auto py-3"
              onClick={() => setTheme(value)}
            >
              <Icon size={20} />
              <span className="text-xs">{label}</span>
            </Button>
          ))}
        </div>
      </Card>

      {!user.isAnonymous && (
      <Card className="p-4 space-y-4">
        <div className="space-y-2">
          <h3 className="font-semibold text-foreground">Import &amp; Export</h3>
          <p className="text-sm text-muted-foreground">
            Import your eBird life list or export your sightings as CSV
          </p>
        </div>

        <div className="space-y-3">
          <AlertDialog open={showImportDialog} onOpenChange={setShowImportDialog}>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                className="w-full justify-start"
              >
                <Upload size={20} className="mr-2" />
                Import from eBird CSV
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Import from eBird CSV</AlertDialogTitle>
                <AlertDialogDescription>
                  Choose your eBird profile timezone before selecting your CSV file.
                </AlertDialogDescription>
              </AlertDialogHeader>

              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label className="text-sm text-muted-foreground flex items-center gap-1.5">
                    <GlobeHemisphereWest size={14} />
                    eBird profile timezone
                  </label>
                  <select
                    value={profileTimezone}
                    onChange={e => setProfileTimezone(e.target.value)}
                    className="w-full appearance-none rounded-md border border-input bg-background px-3 py-2 pr-8 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 bg-[length:16px_16px] bg-[position:right_8px_center] bg-no-repeat"
                    style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m7 15 5 5 5-5'/%3E%3Cpath d='m7 9 5-5 5 5'/%3E%3C/svg%3E")` }}
                  >
                    {timezoneOptions.map(tz => (
                      <option key={tz.value} value={tz.value}>{tz.label}</option>
                    ))}
                    <option value="observation-local">None (times already local)</option>
                  </select>
                </div>

                <p className="text-xs text-muted-foreground">
                  eBird records times in the timezone of the device that submitted
                  the checklist &mdash; typically your phone&apos;s home timezone.
                  This includes Merlin: if you ID photos from a trip abroad at
                  home, Merlin maps the photo&apos;s time to your device&apos;s
                  timezone. If you only bird locally, choose &ldquo;None&rdquo;.
                  Otherwise, select your home timezone so we can convert times to
                  each observation&apos;s local time.
                </p>
              </div>

              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    setShowImportDialog(false)
                    importFileRef.current?.click()
                  }}
                >
                  Choose CSV File
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <Button
            variant="outline"
            className="w-full justify-start"
            onClick={handleExportDex}
            disabled={data.dex.length === 0}
          >
            <Download size={20} className="mr-2" />
            Export Sightings CSV
          </Button>

          <input
            ref={importFileRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={handleImportEBird}
          />

          <button
            onClick={() => setShowEBirdHelp(!showEBirdHelp)}
            className="flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors cursor-pointer w-full"
          >
            <Info size={16} />
            <span>How to export from eBird</span>
            <CaretDown
              size={14}
              className={`transition-transform ${showEBirdHelp ? 'rotate-180' : ''}`}
            />
          </button>

          {showEBirdHelp && (
            <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">
                Export your eBird data in 3 steps:
              </p>
              <ol className="list-decimal list-inside space-y-2">
                <li>
                  Go to{' '}
                  <a
                    href="https://ebird.org/downloadMyData"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline underline-offset-2"
                  >
                    ebird.org/downloadMyData
                  </a>{' '}
                  and sign in
                </li>
                <li>
                  Click <strong className="text-foreground">Submit</strong> to
                  request your data download
                </li>
                <li>
                  You will receive an email with a download link for your CSV file.
                  Upload that file here.
                </li>
              </ol>
              <p className="text-xs">
                WingDex will create outings grouped by date and location, with all your
                species as confirmed observations.
              </p>
            </div>
          )}
        </div>
      </Card>
      )}

      {/* Old Account card removed -- now rendered above Appearance */}

      {/* Bird Identification */}
      <Card className="p-4 space-y-4">
        <div className="space-y-2">
          <h3 className="font-semibold text-foreground">Bird Identification</h3>
          <p className="text-sm text-muted-foreground">
            Settings for AI species identification
          </p>
        </div>
        <div className="flex items-center justify-between">
          <div className="space-y-0.5 flex-1">
            <label htmlFor="geo-context-setting" className="text-sm font-medium text-foreground cursor-pointer">
              Use Location and Time
            </label>
            <p className="text-xs text-muted-foreground">
              Uses photo location and month on this device to improve identification. WingDex may
              forward rounded coordinates to OpenStreetMap to suggest an outing location, and exact
              coordinates are saved by WingDex with your outing and photo metadata.
            </p>
          </div>
          <Switch
            id="geo-context-setting"
            checked={useGeoContext}
            onCheckedChange={(checked) => {
              setUseGeoContext(checked)
              localStorage.setItem('wingdex_useGeoContext', String(checked))
            }}
          />
        </div>
      </Card>

      {/* Account Management */}
      <Card className="p-4 space-y-4">
        <div className="space-y-2">
          <h3 className="font-semibold text-foreground">Account Management</h3>
          <p className="text-sm text-muted-foreground">
            Manage your data and account
          </p>
        </div>
        <div className="space-y-3">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                className="w-full justify-start"
              >
                <Database size={20} className="mr-2" />
                Load Demo Data
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Load demo data?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will replace all your current outings, observations,
                  and WingDex entries with demo data. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={async () => {
                    try {
                      data.clearAllData()

                      const formData = new FormData()
                      formData.append('file', new Blob([demoCsv], { type: 'text/csv' }), 'demo.csv')

                      const previewRes = await fetchWithLocalAuthRetry('/api/import/ebird-csv', {
                        method: 'POST',
                        credentials: 'include',
                        body: formData,
                      })
                      if (!previewRes.ok) {
                        const body = await previewRes.text().catch(() => '')
                        throw new Error(body || `Preview failed (${previewRes.status})`)
                      }

                      const { previews } = await previewRes.json() as {
                        previews: Array<{ previewId: string }>
                      }

                      const confirmRes = await fetchWithLocalAuthRetry('/api/import/ebird-csv/confirm', {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ previewIds: previews.map(p => p.previewId) }),
                      })
                      if (!confirmRes.ok) {
                        const body = await confirmRes.text().catch(() => '')
                        throw new Error(body || `Confirm failed (${confirmRes.status})`)
                      }

                      const { imported } = await confirmRes.json() as {
                        imported: { outings: number; newSpecies: number }
                      }

                      await data.refresh()
                      toast.success(`Demo data loaded: ${imported.outings} outings, ${imported.newSpecies} species`)
                    } catch (error) {
                      const detail = error instanceof Error ? error.message : 'Unknown error'
                      toast.error(`Failed to load demo data: ${detail}`)
                    }
                  }}
                >
                  Load Demo Data
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog open={deleteStep !== null} onOpenChange={open => { if (!open) setDeleteStep(null) }}>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                className="w-full justify-start text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setDeleteStep('choose')}
              >
                <Trash size={20} className="mr-2" />
                Delete Data...
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              {deleteStep === 'choose' && (
                <>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Permanently delete data{!user.isAnonymous ? ' or account' : ''}?</AlertDialogTitle>
                    <AlertDialogDescription asChild>
                      <div className="space-y-3">
                        <p>These actions are <strong className="text-foreground">permanent and irreversible</strong>.</p>
                      </div>
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <div className="space-y-2">
                    <AlertDialogAction
                      className="w-full bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={() => {
                        data.clearAllData()
                        toast.success('All data deleted')
                        setDeleteStep(null)
                      }}
                    >
                      Delete All Data
                    </AlertDialogAction>
                    {!user.isAnonymous && (
                      <Button
                        variant="destructive"
                        className="w-full"
                        onClick={() => setDeleteStep('confirm-account')}
                      >
                        Delete Account &amp; All Data
                      </Button>
                    )}
                  </div>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                  </AlertDialogFooter>
                </>
              )}
              {deleteStep === 'confirm-account' && (
                <>
                  <AlertDialogHeader>
                    <AlertDialogTitle className="text-destructive">Are you absolutely sure?</AlertDialogTitle>
                    <AlertDialogDescription asChild>
                      <div className="space-y-3">
                        <p>The following will be deleted immediately:</p>
                        <ul className="list-disc pl-5 space-y-1 text-sm text-left">
                          <li>All your outings and observations</li>
                          <li>Your entire WingDex species list</li>
                          <li>Your passkeys and login credentials</li>
                          <li>Your account and profile</li>
                        </ul>
                        <p className="font-medium text-destructive">There is no way to recover your data after this.</p>
                      </div>
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <Button variant="outline" disabled={isDeletingAccount} onClick={() => setDeleteStep('choose')}>Go back</Button>
                    <Button
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      disabled={isDeletingAccount}
                      onClick={async () => {
                        setIsDeletingAccount(true)
                        try {
                          const response = await fetch('/api/auth/delete-account', {
                            method: 'POST',
                            credentials: 'include',
                            headers: { traceparent: generateTraceparent() },
                          })
                          if (!response.ok) {
                            const message = await response.text().catch(() => '')
                            toast.error(message || 'Failed to delete account')
                            return
                          }
                          data.clearAllData()
                          setDeleteStep(null)
                          toast.success('Account deleted')
                          onSignedOut?.()
                        } catch {
                          toast.error('Failed to delete account')
                        } finally {
                          setIsDeletingAccount(false)
                        }
                      }}
                    >
                      {isDeletingAccount ? 'Deleting account...' : 'Delete my account forever'}
                    </Button>
                  </AlertDialogFooter>
                </>
              )}
            </AlertDialogContent>
          </AlertDialog>

          {!user.isAnonymous && (
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={async () => {
                try {
                  const result = await authClient.signOut()
                  if (result.error) {
                    toast.error(result.error.message || 'Failed to log out')
                    return
                  }
                } catch {
                  toast.error('Failed to log out')
                  return
                }
                toast.success('Logged out')
                onSignedOut?.()
              }}
            >
              <SignOut size={20} className="mr-2" />
              Log out
            </Button>
          )}
        </div>
      </Card>

    </div>
    </>
  )
}
