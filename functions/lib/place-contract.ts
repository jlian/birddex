/**
 * Emit the birding-place contract as JSON, read FROM the live implementation.
 *
 * `scoreOf()` and `kindOf()` in `place-rank.ts` decide what counts as a birding
 * place. The offline search build needs the SAME answer in Python, and the
 * first attempt hand-copied the rules. Review caught that copy already
 * disagreeing: it scored `museum` 26 instead of 19, `city` 20 instead of 14,
 * dropped whole fallback tiers, and emitted `kind` values that did not exist.
 * A corpus built on those rules is not a measurement of the shipped contract.
 *
 * Python cannot import TypeScript, so rather than restate the rules this
 * IMPORTS the real functions and exhaustively probes them. Every tag value the
 * module mentions is fed through `scoreOf`/`kindOf`, so the export cannot miss
 * a branch, and a rule change flows into the next build automatically.
 *
 * Run with: npx vitest run --config vitest.functions.config.ts \
 *   functions/lib/place-rank-contract.test.ts
 * or via `npm run build:place-contract`.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { kindOf, scoreOf } from './place-rank'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')

/** The tag keys the contract inspects. */
const KEYS = ['tourism', 'leisure', 'natural', 'boundary', 'landuse', 'place'] as const

/**
 * Harvest every quoted lowercase literal from the source, so the probe covers
 * values this file does not know about. Reading the source for the VALUE LIST
 * is safe in a way that reading it for the RULES is not: a missed value shows
 * up as a missing corpus row, while a missed rule silently changes ranking.
 */
function candidateValues(): string[] {
  const source = readFileSync(resolve(here, 'place-rank.ts'), 'utf8')
  const found = new Set<string>()
  for (const match of source.matchAll(/'([a-z][a-z_]*)'/g)) found.add(match[1])
  return [...found].sort()
}

export interface PlaceContract {
  score: Record<string, Record<string, number>>
  kind: Record<string, Record<string, string>>
}

export function buildContract(): PlaceContract {
  const values = candidateValues()
  const score: PlaceContract['score'] = {}
  const kind: PlaceContract['kind'] = {}
  for (const key of KEYS) {
    score[key] = {}
    kind[key] = {}
    for (const value of values) {
      const props = { [key]: value }
      const s = scoreOf(props)
      // Zero means "not a birding place", which is the default, so recording
      // it would only bloat the artifact.
      if (s > 0) {
        score[key][value] = s
        kind[key][value] = kindOf(props)
      }
    }
  }
  return { score, kind }
}

export function contractPath(): string {
  return resolve(repoRoot, 'scripts/osm-places/place-contract.json')
}

export function writeContract(): PlaceContract {
  const contract = buildContract()
  const path = contractPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(contract, null, 2)}\n`)
  return contract
}
