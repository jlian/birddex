import { describe, it, expect, beforeEach, vi } from 'vitest'
import { shouldPromptForCrop, CONFIDENCE_PROMPT_THRESHOLD } from '@/lib/bird-id-local-adapter'

/**
 * The crop prompt gate.
 *
 * Two things worth locking down. The threshold decides how often the app
 * interrupts: at 0.7 the post-rerank gate keeps 94.9% of photos at 97.91%
 * accuracy, so about 5% of uploads get asked. And the loop guard exists because
 * confidence tracks SPECIES AMBIGUITY, not framing (Pearson 0.051 against
 * relative bird area), so cropping often does not raise it and a second prompt
 * would never resolve.
 */
describe('crop prompt gate', () => {
  const withConfidence = (c: number) => ({
    candidates: [{ species: 'Mallard', confidence: c }],
  })

  it('does not prompt when the model is confident', () => {
    expect(shouldPromptForCrop(withConfidence(0.95), false)).toBe(false)
  })

  it('does not prompt just above the threshold', () => {
    expect(shouldPromptForCrop(withConfidence(CONFIDENCE_PROMPT_THRESHOLD + 0.01), false)).toBe(false)
  })

  it('prompts just below the threshold', () => {
    expect(shouldPromptForCrop(withConfidence(CONFIDENCE_PROMPT_THRESHOLD - 0.01), false)).toBe(true)
  })

  it('prompts when confidence is very low', () => {
    expect(shouldPromptForCrop(withConfidence(0.1), false)).toBe(true)
  })

  it('NEVER prompts twice, even if confidence is still low', () => {
    // The loop guard. Without this the app asks, gets the same answer, and
    // asks again forever.
    expect(shouldPromptForCrop(withConfidence(0.1), true)).toBe(false)
  })

  it('does not prompt after a crop that worked', () => {
    expect(shouldPromptForCrop(withConfidence(0.99), true)).toBe(false)
  })

  it('prompts when there are no candidates at all', () => {
    // A classifier always returns 25 candidates, so an empty list means
    // something upstream broke. Asking is the safe response.
    expect(shouldPromptForCrop({ candidates: [] }, false)).toBe(true)
  })

  it('does not loop even when candidates are empty', () => {
    expect(shouldPromptForCrop({ candidates: [] }, true)).toBe(false)
  })
})
