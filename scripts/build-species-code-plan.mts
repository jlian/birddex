/**
 * Build the name -> eBird code plan the backfill script consumes.
 *
 * NOT A TEST. This lived in src/__tests__ briefly, which was wrong: vitest.config.ts
 * includes src/**\/*.test.ts, so CI ran it on a clean checkout where the input file
 * does not exist and it failed the suite. It is an operational step, so it lives in
 * scripts/ and is run explicitly.
 *
 * It is .mts and run through vitest only because resolveSpeciesCode lives in a
 * TypeScript module that imports taxonomy.json and taxonomy-extra.json, which bare
 * node cannot load. Running it through the project's own bundler means the backfill
 * uses the SAME resolver as the import path rather than a second copy of the
 * matching rules that would drift.
 *
 *   node scripts/backfill-species-code.mjs --dump-names
 *   npx vitest run --config vitest.plan.config.ts
 *   node scripts/backfill-species-code.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'vitest'

import { resolveSpeciesIdentity } from '../functions/lib/species-code-resolve'

const ROOT = resolve(__dirname, '..')
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

    const map: Record<string, { speciesCode: string; taxonCode: string }> = {}
    const unresolved: string[] = []
    for (const name of names) {
      const identity = resolveSpeciesIdentity(name)
      if (identity) map[name] = identity
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
