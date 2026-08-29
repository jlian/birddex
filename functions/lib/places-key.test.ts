import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { PLACES_KEY } from './places-key'

describe('the generated places key', () => {
  // These guard the one failure this file exists to prevent: the constant
  // disagreeing with the archive that was actually uploaded. The upload script
  // writes this file, so a stale value means someone hand-edited it or a
  // deploy dropped the regenerated copy.

  it('matches the shape the upload script enforces', () => {
    // r2-upload.mjs rejects any other shape, so a value that does not match
    // cannot have come from a real upload.
    expect(PLACES_KEY).toMatch(/^places-\d{8}\.pmtiles$/)
  })

  it('carries a plausible build date', () => {
    const stamp = PLACES_KEY.slice('places-'.length, 'places-'.length + 8)
    const year = Number(stamp.slice(0, 4))
    const month = Number(stamp.slice(4, 6))
    const day = Number(stamp.slice(6, 8))
    expect(year).toBeGreaterThanOrEqual(2026)
    expect(month).toBeGreaterThanOrEqual(1)
    expect(month).toBeLessThanOrEqual(12)
    expect(day).toBeGreaterThanOrEqual(1)
    expect(day).toBeLessThanOrEqual(31)
  })

  it('is still marked generated, so nobody edits it by hand', () => {
    // If this header is gone, the file was probably replaced by hand and the
    // next upload will silently overwrite whatever was written.
    const source = readFileSync(new URL('./places-key.ts', import.meta.url), 'utf8')
    expect(source).toContain('GENERATED FILE')
  })
})
