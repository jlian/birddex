import { useEffect, useState } from 'react'
import { gunzipIfNeeded } from './gunzip'
import { parseRarity, rarityAt, RARITY_ASSET_URL, type RarityState } from './rarity'
import { getSpeciesIndexLookup } from './taxonomy-order'
import { TAXONOMY_SHA16 } from './taxonomy-hash'

export type { RarityState }

/**
 * Browser-side access to the rarity asset.
 *
 * Fetched eagerly wherever a list of birds renders, with no download gate. That
 * is only defensible because it is 1.38 MiB and served immutable, unlike the
 * 56.25 MiB model set behind ModelDownloadGate.
 *
 * Once resolved, every lookup is synchronous, so a row computes its own verdict
 * during render with no per-row state. Mirrors RarityStore on iOS.
 */
type Resolver = (
  species: string,
  lat: number | null | undefined,
  lon: number | null | undefined,
  month: number | null | undefined,
  taxonCode?: string,
) => RarityState

const NO_MARK: Resolver = () => 'none'

let resolverPromise: Promise<Resolver> | null = null
let resolved: Resolver | null = null

async function build(): Promise<Resolver> {
  try {
    const [raw, speciesIndex] = await Promise.all([
      fetch(RARITY_ASSET_URL)
        .then(r => {
          if (!r.ok) throw new Error('rarity asset HTTP ' + r.status)
          return r.arrayBuffer()
        })
        .then(b => gunzipIfNeeded(new Uint8Array(b))),
      getSpeciesIndexLookup(),
    ])
    // Checked, not skipped. Species are keyed by taxonomy row index, so a
    // taxonomy bumped without rebuilding the asset must fail closed rather
    // than apply every verdict to the wrong bird.
    const blob = parseRarity(raw, TAXONOMY_SHA16)
    return (species, lat, lon, month, taxonCode) => {
      if (lat == null || lon == null || month == null) return 'none'
      const idx = speciesIndex(species, taxonCode)
      if (idx < 0) return 'none'
      return rarityAt(blob, idx, lat, lon, month)
    }
  } catch {
    // A missing, truncated or mis-keyed asset must leave every row unmarked
    // rather than mark them wrongly, and must never break the page.
    return NO_MARK
  }
}

export function loadRarity(): Promise<Resolver> {
  resolverPromise ??= build().then(r => (resolved = r))
  return resolverPromise
}

/**
 * The resolver itself, for callers that need to look up MANY species in one
 * render. A hook cannot be called once per candidate, because the number of
 * candidates changes between photos and that breaks the rules of hooks.
 *
 * Returns a resolver that answers 'none' for everything until the asset lands.
 * Pass `enabled: false` where no row can carry a mark, so the life list does
 * not pull 1.38 MiB it will never read.
 */
export function useRarityResolver(enabled = true): Resolver {
  // Wrapped, because React treats a bare function as a LAZY INITIALIZER and
  // would call the resolver with no arguments, then store whatever came back.
  const [resolver, setResolver] = useState<Resolver | null>(() => resolved)

  useEffect(() => {
    if (resolver || !enabled) return
    let live = true
    void loadRarity().then(r => { if (live) setResolver(() => r) })
    return () => { live = false }
  }, [resolver, enabled])

  return enabled && resolver ? resolver : NO_MARK
}

/**
 * The verdict for one sighting. Returns 'none' until the asset resolves, so a
 * row renders unmarked and gains its mark when the data arrives.
 */
export function useRarity(
  species: string,
  lat: number | null | undefined,
  lon: number | null | undefined,
  month: number | null | undefined,
  taxonCode?: string,
): RarityState {
  const known = lat != null && lon != null && month != null
  return useRarityResolver(known)(species, lat, lon, month, taxonCode)
}

/**
 * The 1-12 month of a stored ISO timestamp, in its OWN timezone. Reading it
 * locally would move an evening outing into the wrong month.
 *
 * Anchored, so a value that merely STARTS like a date is rejected rather than
 * read as its leading month. Beyond that the month range is the only check,
 * matching DateFormatting.localMonth on iOS: these strings come from our own
 * API, and validating the calendar here would reject values that side accepts.
 */
const ISO_DATE = /^\d{4}-(\d{2})-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/

export function localMonth(timeStr: string | null | undefined): number | null {
  if (!timeStr) return null
  const m = ISO_DATE.exec(timeStr)
  if (!m) return null
  const month = Number(m[1])
  return month >= 1 && month <= 12 ? month : null
}
