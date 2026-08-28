import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Preview must never bind the production archive bucket.
 *
 * Cloudflare has no runtime read-only R2 binding, so a binding grants `put` and
 * `delete`. CI deploys PULL REQUEST code with the preview environment, in
 * `ci.yml` (`versions upload --env preview`) and `release.yml`
 * (`deploy --env preview`). A preview bound to production could therefore
 * delete the only production archive and take live reverse geocoding down.
 *
 * `ReadonlyR2Bucket` does not help: `Pick<R2Bucket, 'get'>` is compile-time
 * only and constrains our code, not a compromised or careless preview.
 */
describe('preview R2 isolation', () => {
  const toml = readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8')

  /** The bucket_name in a given `[[...r2_buckets]]` block. */
  const bucketFor = (header: string): string | undefined => {
    const start = toml.indexOf(header)
    if (start === -1) return undefined
    const block = toml.slice(start, start + 400)
    return /bucket_name\s*=\s*"([^"]+)"/.exec(block)?.[1]
  }

  it('binds production to the production bucket', () => {
    expect(bucketFor('[[r2_buckets]]')).toBe('wingdex-places')
  })

  it('binds preview to a DIFFERENT bucket', () => {
    const preview = bucketFor('[[env.preview.r2_buckets]]')
    expect(preview).toBe('wingdex-places-preview')
    expect(preview).not.toBe('wingdex-places')
  })

  it('still declares a preview binding at all', () => {
    // Wrangler environments do not inherit top-level bindings, so deleting this
    // block does not fall back to production, it leaves env.PLACES undefined
    // and every reverse-geocode request answers 503.
    expect(toml).toContain('[[env.preview.r2_buckets]]')
    expect(bucketFor('[[env.preview.r2_buckets]]')).toBeDefined()
  })

  it('uses the real preview bucket during mixed-mode local CI', () => {
    const start = toml.indexOf('[[env.preview.r2_buckets]]')
    const block = toml.slice(start, start + 400)
    expect(block).toMatch(/remote\s*=\s*true/)
  })
})
