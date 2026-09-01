import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { TAXONOMY_NAMES_SHA16 } from '@/lib/taxonomy-names-hash'

/**
 * A deliberately narrow guard, separate from the taxonomy-hash test.
 *
 * That one fires on ANY change to taxonomy.json. This one fires only when a
 * species is added, removed or renamed, which is the subset that can fork a
 * user's dex: groups are keyed by display name today (issue #306), so a client
 * writing an old spelling after the server adopts a new one creates a second
 * entry for the same bird.
 *
 * When this fails, run scripts/diff-taxonomy-names.mjs and read
 * src/lib/taxonomy-names-hash.ts before updating the constant.
 */
describe('taxonomy name gate', () => {
  it('matches the current code to common and scientific name mapping', () => {
    const rows = JSON.parse(readFileSync('src/lib/taxonomy.json', 'utf8')) as unknown[][]
    const pairs: string[] = []
    for (const row of rows) {
      const code = row[2] as string | undefined
      if (code) pairs.push(`${code}\t${row[0] as string}\t${row[1] as string}`)
    }
    pairs.sort()
    const actual = createHash('sha256').update(pairs.join('\n')).digest('hex').slice(0, 16)

    expect(
      TAXONOMY_NAMES_SHA16,
      'Species were added, removed or renamed. Run `node scripts/diff-taxonomy-names.mjs`. ' +
      'Adds and removals are safe to ship. A RENAME requires the code-keying migration ' +
      '(issue #306) to land first, or no client may ship against this taxonomy.',
    ).toBe(actual)
  })

  it('has one name per code, so the mapping is a function', () => {
    const rows = JSON.parse(readFileSync('src/lib/taxonomy.json', 'utf8')) as unknown[][]
    const seen = new Set<string>()
    for (const row of rows) {
      const code = row[2] as string | undefined
      if (!code) continue
      expect(seen.has(code), `duplicate code ${code}`).toBe(false)
      seen.add(code)
    }
    expect(seen.size).toBeGreaterThan(10_000)
  })
})
