import type { RarityState } from '@/lib/rarity'

/**
 * The rarity mark: one small concentric glyph, three readings.
 *
 *   core dot only   off its range      place is a point
 *   ring only       out of season      time is a cycle
 *   dot in ring     both               wrong place AND wrong month
 *
 * Composed rather than three separate icons, so the vocabulary is learnable in
 * one look and the rarest state is also the visually heaviest. Amber, not red:
 * red reads as an error, and orange is eBird's "this needs documenting" flag.
 * Colour never carries the meaning on its own; the form does, and every state
 * has a title for assistive technology.
 *
 * Kept visually identical to RarityMark.swift. All three states occupy the same
 * box so marks line up down a list.
 */

export const RARITY_LABELS: Record<Exclude<RarityState, 'none'>, string> = {
  outOfSeason: 'Out of season',
  offRange: 'Off range',
  both: 'Rarely seen here',
}

const A11Y_LABELS: Record<Exclude<RarityState, 'none'>, string> = {
  outOfSeason: 'Out of season for this area',
  offRange: 'Off its usual range',
  both: 'Rarely recorded in this area',
}

export function RarityMark({ state, className = '' }: { state: RarityState; className?: string }) {
  if (state === 'none') return null

  const ring = state === 'outOfSeason' || state === 'both'
  const core = state === 'offRange' || state === 'both'
  // The standalone dot is wider than the concentric core so it carries at least
  // as much ink as the hollow ring: off range is the rarer of the two verdicts
  // and must not read lighter.
  const coreRadius = state === 'both' ? 2.1 : 3.5

  return (
    <svg
      viewBox="0 0 10 10"
      className={`inline-block size-[0.7em] shrink-0 text-amber-700 dark:text-amber-400 ${className}`}
      role="img"
      aria-label={A11Y_LABELS[state]}
    >
      <title>{A11Y_LABELS[state]}</title>
      {ring && <circle cx="5" cy="5" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />}
      {core && <circle cx="5" cy="5" r={coreRadius} fill="currentColor" />}
    </svg>
  )
}
