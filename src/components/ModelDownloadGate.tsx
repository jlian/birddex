/**
 * Model download gate.
 *
 * The model is 61.66 MiB. Three rules follow from that:
 *
 *  1. NEVER at page load. Most visits never identify a bird, and pulling 62 MiB
 *     to look at a life list would be indefensible.
 *  2. NEVER silently mid-identification. Discovering a 62 MiB download after
 *     picking a photo feels like the app broke.
 *  3. Once only. The Cache API keeps it, so this screen appears on first use
 *     and never again unless the user clears it.
 *
 * So: ask before the first identification, show real progress, and get out of
 * the way forever after.
 */

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  MODEL_ASSETS,
  MODEL_BYTES,
  modelReady,
  preloadModel,
} from '@/lib/bird-id-local-adapter'
import type { AssetProgress } from '@/lib/model-cache'

const MIB = 1048576

export function ModelDownloadGate({ onReady }: { onReady: () => void }) {
  const [checking, setChecking] = useState(true)
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState<AssetProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    modelReady().then(ready => {
      if (cancelled) return
      setChecking(false)
      // Already cached, so skip the screen entirely. This is the path almost
      // every session takes.
      if (ready) onReady()
    })
    return () => { cancelled = true }
  }, [onReady])

  const start = async () => {
    setDownloading(true)
    setError(null)
    try {
      await preloadModel(MODEL_ASSETS, p => setProgress(p))
      onReady()
    } catch (e) {
      // Leave the button available. A failed download is usually a dropped
      // connection, and the cache keeps whatever already arrived, so retrying
      // resumes rather than restarting.
      setError(e instanceof Error ? e.message : String(e))
      setDownloading(false)
    }
  }

  if (checking) return null

  const pct = progress && progress.total > 0
    ? Math.min(100, Math.round((progress.loaded / progress.total) * 100))
    : 0

  return (
    <div className="flex flex-col gap-4 p-6 text-center">
      <div>
        <h3 className="text-lg font-medium">Download the bird model</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          {(MODEL_BYTES / MIB).toFixed(0)} MB, once. After this, identification
          runs entirely on your device, works offline, and no photo ever leaves
          your phone.
        </p>
      </div>

      {downloading ? (
        <div className="flex flex-col gap-2">
          <Progress value={pct} />
          <p className="text-muted-foreground text-xs">
            {progress && progress.total > 0
              ? `${(progress.loaded / MIB).toFixed(1)} of ${(progress.total / MIB).toFixed(1)} MB`
              : "Starting..."}
          </p>
        </div>
      ) : (
        <Button onClick={start}>Download and continue</Button>
      )}

      {error && (
        <p className="text-destructive text-sm">
          Download failed: {error}. Tap to retry, it picks up where it stopped.
        </p>
      )}
    </div>
  )
}
