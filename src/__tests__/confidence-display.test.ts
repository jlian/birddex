import { describe, expect, it } from 'vitest'
import { formatConfidence, CONFIDENCE_PROMPT_THRESHOLD } from '@/lib/bird-id-local-adapter'

/**
 * Confidence display.
 *
 * The PR review asked whether the 0% splits were real. They are not: across 400
 * labelled held-out photos no candidate was ever exactly zero, but 91% of the
 * 2nd-to-5th candidates fell below 0.5% and rounded to a flat "0%". The median
 * second candidate is 0.035%.
 */
describe('formatConfidence', () => {
  it('never renders a real value as 0%', () => {
    for (const p of [0.0000001, 0.00035, 0.001, 0.004, 0.00499]) {
      expect(formatConfidence(p)).toBe('<0.5%')
    }
  })

  it('switches to a rounded percentage exactly where rounding stops giving 0', () => {
    expect(formatConfidence(0.005)).toBe('1%')
    expect(formatConfidence(0.0049)).toBe('<0.5%')
  })

  it('rounds normally above the bound', () => {
    expect(formatConfidence(0.5)).toBe('50%')
    expect(formatConfidence(0.9963)).toBe('100%')
    expect(formatConfidence(1)).toBe('100%')
  })

  it('does not render NaN or negatives as a percentage', () => {
    expect(formatConfidence(Number.NaN)).toBe('-')
    expect(formatConfidence(-1)).toBe('-')
  })
})

describe('crop prompt threshold', () => {
  /**
   * Raised from 0.7 to 0.8 after measuring against Imagenette dogs: 0.8 rejects
   * 76% of dog photos against 70% at 0.7, for 2 points of bird coverage.
   */
  it('is 0.8', () => {
    expect(CONFIDENCE_PROMPT_THRESHOLD).toBe(0.8)
  })
})
