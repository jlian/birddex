import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TAXONOMY_NAMES_SHA16 } from '@/lib/taxonomy-names-hash'

function nameHash(rows: unknown[][]): string {
  const pairs = rows.flatMap(row => {
    const code = row[2] as string | undefined
    return code ? [JSON.stringify([code, row[0], row[1]])] : []
  })
  pairs.sort()
  return createHash('sha256').update(pairs.join('\n')).digest('hex').slice(0, 16)
}

describe('taxonomy name gate', () => {
  it('matches the current code to common and scientific name mapping', () => {
    const rows = JSON.parse(readFileSync('src/lib/taxonomy.json', 'utf8')) as unknown[][]
    expect(
      TAXONOMY_NAMES_SHA16,
      'Taxonomy names changed. Run `node scripts/diff-taxonomy-names.mjs <base-ref>` before updating the hash.',
    ).toBe(nameHash(rows))
  })

  it('has one name per code', () => {
    const rows = JSON.parse(readFileSync('src/lib/taxonomy.json', 'utf8')) as unknown[][]
    const codes = rows.map(row => row[2] as string | undefined).filter(Boolean)
    expect(new Set(codes).size).toBe(codes.length)
    expect(codes.length).toBeGreaterThan(10_000)
  })
})
