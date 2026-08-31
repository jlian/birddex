#!/usr/bin/env node
/**
 * Backfill observation.speciesCode and dex_meta.speciesCode (#306).
 *
 * WHY THIS IS A SCRIPT AND NOT PART OF THE MIGRATION
 * --------------------------------------------------
 * Resolving a stored speciesName to an eBird code needs the taxonomy AND the
 * display sidecar, with a matching chain that tries the scientific name, then
 * its binomial, then the common name. That is not expressible in SQLite, and
 * encoding an 11k-row lookup as a CASE would be unreadable and stale the moment
 * the taxonomy moves. Running it here means there is ONE implementation of the
 * rule, shared with the import path.
 *
 * WHY IT REPORTS RATHER THAN SILENTLY LEAVING NULLS
 * -------------------------------------------------
 * The code cannot be total: eBird exports carry spuh, slash, hybrid and
 * domestic taxa, and parseEBirdCSV stores whatever the CSV said. A row that
 * resolves to nothing is expected and keeps grouping by name. But an
 * unexpectedly LARGE unresolved set means the resolver regressed, and the
 * failure is silent -- a split dex nobody notices for months. So the tail is
 * printed, with every distinct unresolved name, and --strict fails the run if
 * it exceeds a threshold.
 *
 * Usage:
 *   npx vitest run src/__tests__/species-code-plan.test.ts   # writes the plan
 *   node scripts/backfill-species-code.mjs
 *   node scripts/backfill-species-code.mjs --apply
 *   node scripts/backfill-species-code.mjs --apply --strict 5
 *
 * The name -> code mapping is produced by the plan step rather than imported
 * here, because resolveSpeciesCode lives in a TypeScript module that imports
 * JSON, which bare node cannot load. Running it under vitest reuses the
 * resolver the import path uses instead of duplicating the matching rules.
 *
 * --apply is required to write. Without it this is a dry run that reports
 * coverage and changes nothing. There is deliberately no --remote flag: point
 * it at a remote database only after the local run looks right, by setting
 * D1_REMOTE=1 explicitly.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const DB = 'wingdex-db'
const STATE = `${process.env.HOME}/.cache/wingdex/wrangler-state`

const apply = process.argv.includes('--apply')
const dumpNames = process.argv.includes('--dump-names')
const remote = process.env.D1_REMOTE === '1'
const strictIdx = process.argv.indexOf('--strict')
const strictMax = strictIdx >= 0 ? Number(process.argv[strictIdx + 1]) : null

function d1(sql) {
  const args = [
    'wrangler', 'd1', 'execute', DB,
    remote ? '--remote' : '--local',
    ...(remote ? [] : ['--persist-to', STATE]),
    '--json', '--command', sql,
  ]
  const out = execFileSync('npx', args, {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  // wrangler prefixes human chatter before the JSON array.
  const start = out.indexOf('[')
  const parsed = JSON.parse(out.slice(start))
  return parsed[0]?.results ?? []
}

function sqlQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

const PLAN = resolve(ROOT, '.tmp/species-code-plan.json')
const NAMES = resolve(ROOT, '.tmp/species-names.json')

if (dumpNames) {
  const seen = new Set()
  for (const table of ['observation', 'dex_meta']) {
    for (const r of d1(
      `SELECT DISTINCT speciesName FROM ${table} WHERE speciesName IS NOT NULL`)) {
      if (r.speciesName) seen.add(r.speciesName)
    }
  }
  mkdirSync(resolve(ROOT, '.tmp'), { recursive: true })
  writeFileSync(NAMES, JSON.stringify([...seen], null, 2) + '\n')
  console.log(`wrote ${NAMES}: ${seen.size} distinct names`)
  console.log('next: npx vitest run src/__tests__/species-code-plan.test.ts')
  process.exit(0)
}

let plan
try {
  plan = JSON.parse(readFileSync(PLAN, 'utf8'))
} catch {
  console.error(
    `No plan at ${PLAN}.\n` +
    `Run: node scripts/backfill-species-code.mjs --dump-names\n` +
    `then: npx vitest run src/__tests__/species-code-plan.test.ts`)
  process.exit(1)
}
const resolveSpeciesCode = name => plan.map[name] ?? ''

console.log(`target: ${remote ? 'REMOTE' : 'local'} ${DB}`)
console.log(`plan  : ${plan.count} names resolved, built ${plan.builtAt}`)
if (remote && !apply) console.log('(dry run)')

for (const table of ['observation', 'dex_meta']) {
  const rows = d1(
    `SELECT DISTINCT speciesName FROM ${table} WHERE speciesName IS NOT NULL`)
  const names = rows.map(r => r.speciesName).filter(Boolean)

  const resolved = new Map()
  const unresolved = []
  for (const name of names) {
    const code = resolveSpeciesCode(name)
    if (code) resolved.set(name, code)
    else unresolved.push(name)
  }

  const pct = names.length
    ? ((resolved.size / names.length) * 100).toFixed(1)
    : '100.0'
  console.log(`\n${table}: ${names.length} distinct species names`)
  console.log(`  resolved   : ${resolved.size} (${pct}%)`)
  console.log(`  unresolved : ${unresolved.length}`)
  for (const name of unresolved) console.log(`      ${name}`)

  if (strictMax !== null && unresolved.length > strictMax) {
    console.error(
      `\nERROR: ${unresolved.length} unresolved names in ${table} exceeds ` +
      `--strict ${strictMax}. A large tail means the resolver regressed, not ` +
      `that the data is unusual; investigate before writing.`)
    process.exit(1)
  }

  if (!apply) continue

  // One UPDATE per distinct code, not per row: a few hundred statements rather
  // than one per observation.
  const byCode = new Map()
  for (const [name, code] of resolved) {
    if (!byCode.has(code)) byCode.set(code, [])
    byCode.get(code).push(name)
  }

  let written = 0
  for (const [code, group] of byCode) {
    const list = group.map(sqlQuote).join(', ')
    const res = d1(
      `UPDATE ${table} SET speciesCode = ${sqlQuote(code)} ` +
      `WHERE speciesName IN (${list}) AND speciesCode IS NULL`)
    written += 1
    void res
  }
  console.log(`  wrote      : ${byCode.size} code groups (${written} statements)`)
}

if (!apply) {
  console.log('\nDRY RUN. Re-run with --apply to write.')
}
