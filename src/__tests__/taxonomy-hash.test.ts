import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { TAXONOMY_SHA16 } from '@/lib/taxonomy-hash'

/**
 * The taxonomy hash is a constant in three places: this module, the Swift
 * engine, and the header of every shipped asset. Species are keyed by ROW INDEX
 * into taxonomy.json, so if the file changes while a constant does not, both
 * parsers happily match the stale hash and resolve every index through the new
 * taxonomy, applying verdicts to the wrong birds.
 *
 * Nothing else ties the constant to the actual bytes. This does.
 */
describe('taxonomy hash', () => {
  const actual = createHash('sha256')
    .update(readFileSync('src/lib/taxonomy.json'))
    .digest('hex')
    .slice(0, 16)

  it('matches the bytes of taxonomy.json', () => {
    expect(TAXONOMY_SHA16).toBe(actual)
  })

  it('matches the iOS constant, which is a second copy of the same value', () => {
    const swift = readFileSync('ios/WingDex/Services/BirdID/BirdIdEngine.swift', 'utf8')
    const found = /taxonomySha16\s*=\s*"([0-9a-f]{16})"/.exec(swift)
    expect(found?.[1]).toBe(actual)
  })

  it('matches the hash both shipped assets are keyed by', () => {
    for (const meta of [
      'public/priors/occurrence.d0abc168.bin.gz.meta.json',
      'public/priors/rarity.410e7b98.bin.gz.meta.json',
    ]) {
      const parsed = JSON.parse(readFileSync(meta, 'utf8'))
      expect(parsed.taxonomy_sha256_8, meta).toBe(actual)
    }
  })
})
