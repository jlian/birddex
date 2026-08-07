import type { ObservationStatus } from '@/lib/types'

// ─── Types ──────────────────────────────────────────────────

export type FlowStep =
  | 'upload'
  | 'extracting'
  | 'review'
  | 'model-download'
  | 'photo-manual-crop'
  | 'photo-processing'
  | 'photo-confirm'
  | 'complete'
  | 'summary'

export interface PhotoResult {
  photoId: string
  species: string
  confidence: number
  status: ObservationStatus
  count: number
}

// ─── Pure helpers ───────────────────────────────────────────

/**
 * Whether the wizard is in a state where closing would lose progress.
 */
export function needsCloseConfirmation(step: FlowStep): boolean {
  return step !== 'upload' && step !== 'complete' && step !== 'summary'
}

/**
 * Guard against advanceToNextPhoto being called with a MouseEvent
 * (from an onClick handler) instead of a results array.
 */
export function resolvePhotoResults(
  results: unknown,
  fallback: PhotoResult[],
): PhotoResult[] {
  return Array.isArray(results) ? results : fallback
}

/**
 * Filter results down to confirmed / possible observations.
 */
export function filterConfirmedResults(
  allResults: PhotoResult[],
): PhotoResult[] {
  return allResults.filter(
    r => r.status === 'confirmed' || r.status === 'possible',
  )
}

/**
 * Extract a user-friendly error message, with special handling
 * for rate-limit (429) errors from the AI service.
 */
export function friendlyErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Species identification failed'
  }
  const msg = error.message
  if (msg.includes('429') || msg.includes('rate')) {
    return 'AI rate limit reached. Please wait a minute before trying again.'
  }
  return msg
}

/**
 * Normalize reverse-geocoded location text for prompt context.
 */
export function normalizeLocationName(locationName: string): string {
  const trimmed = locationName.trim()
  if (!trimmed || trimmed === 'Unknown Location') {
    return ''
  }

  const parts = trimmed
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)

  if (parts.length >= 3) {
    const first = parts[0].toLowerCase()
    const isGranularLead = /(\btrail\b|\bpath\b|\bparking\b|\bparking lot\b|\bviewpoint\b|\blookout\b|\bboat ramp\b|\bdock\b|\bpier\b|\baccess\b|\bentrance\b|\broad\b|\bstreet\b|\bavenue\b|\bave\b|\bboulevard\b|\bblvd\b|\bdrive\b|\bdr\b|\blane\b|\bln\b|\bway\b|\bhighway\b|\bhwy\b|\bexit\b)/.test(first)

    if (isGranularLead) {
      // Prefer broader city/state context for AI prompts
      return `${parts[1]}, ${parts[2]}`
    }
  }

  return trimmed
}

/**
 * Resolve which location name should be passed to AI for this inference call.
 */
export function resolveInferenceLocationName(
  useGeoContext: boolean,
  lastLocationName: string,
  locationNameOverride?: string,
): string | undefined {
  if (!useGeoContext) {
    return undefined
  }
  const resolved = locationNameOverride ?? lastLocationName
  return resolved || undefined
}
