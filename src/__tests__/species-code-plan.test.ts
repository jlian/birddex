/**
 * Build the name -> eBird code plan the backfill script consumes.
 *
 * Not a test. It runs under vitest because resolveSpeciesCode lives in a
 * TypeScript module that imports taxonomy.json and taxonomy-extra.json, which
 * bare node cannot load. Running it here means the backfill uses the SAME
 * resolver as the import path rather than a second copy of the matching rules.
 *
 * Reads the distinct species names dumped from D1 and writes the resolved
 * mapping plus the unresolved tail.
 *
 *   npx vitest run src/__tests__/species-code-plan.test.ts
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'vitest'

import { resolveSpeciesCode } from '../../functions/lib/taxonomy'

const ROOT = resolve(__dirname, '../..')
const NAMES = resolve(ROOT, '.tmp/species-names.json')
const OUT = resolve(ROOT, '.tmp/species-code-plan.json')

describe('species code backfill plan', () => {
  it('resolves every distinct stored name it can', () => {
    if (!existsSync(NAMES)) {
      throw new Error(
        `${NAMES} not found. Dump the distinct names first:\n` +
        `  node scripts/backfill-species-code.mjs --dump-names`)
    }
    const names: string[] = JSON.parse(readFileSync(NAMES, 'utf8'))

    const map: Record<string, string> = {}
    const unresolved: string[] = []
    for (const name of names) {
      const code = resolveSpeciesCode(name)
      if (code) map[name] = code
      else unresolved.push(name)
    }

    mkdirSync(resolve(ROOT, '.tmp'), { recursive: true })
    writeFileSync(OUT, JSON.stringify({
      builtAt: new Date().toISOString(),
      total: names.length,
      count: Object.keys(map).length,
      unresolved,
      map,
    }, null, 2) + '\n')

    const pct = names.length
      ? ((Object.keys(map).length / names.length) * 100).toFixed(1)
      : '100.0'
    console.log(
      `plan: ${Object.keys(map).length}/${names.length} resolved (${pct}%), ` +
      `${unresolved.length} unresolved`)
    for (const n of unresolved) console.log(`  UNRESOLVED ${n}`)
  })
})
