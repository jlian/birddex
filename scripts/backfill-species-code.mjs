#!/usr/bin/env node
/**
 * Backfill observation speciesCode/taxonCode and dex_meta.speciesCode (#306).
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
 * RUNNING THIS AGAINST A REMOTE D1
 * --------------------------------
 * Nothing here targets remote by default and there is no --remote flag, on
 * purpose. Set D1_REMOTE=1 deliberately, and only after the local run looks
 * right. The order that matters:
 *
 *   1. apply migration 0014 to the remote database
 *        wrangler d1 migrations apply wingdex-db --remote
 *   2. dump the distinct names FROM THAT DATABASE, not from local
 *        D1_REMOTE=1 D1_DATABASE=DB D1_ENV=preview \
 *          node scripts/backfill-species-code.mjs --dump-names
 *   3. build the plan against those names
 *        npx vitest run --config vitest.plan.config.ts
 *   4. DRY RUN first and read the unresolved tail
 *        D1_REMOTE=1 D1_DATABASE=DB D1_ENV=preview \
 *          node scripts/backfill-species-code.mjs
 *   5. only then write
 *        D1_REMOTE=1 D1_DATABASE=DB D1_ENV=preview \
 *          node scripts/backfill-species-code.mjs --apply --strict 5
 *
 * Step 2 matters: production holds names local data does not, so a plan built
 * from a local dump would silently leave those rows NULL. Step 4 matters
 * because the unresolved tail is the signal that the resolver regressed, and
 * --strict turns that into a failure rather than a line of output nobody reads.
 *
 * The write is a single json_each UPDATE per table, so it is one round trip
 * rather than one per species. It is still not a transaction across both
 * tables: if observation succeeds and dex_meta fails, re-running is safe
 * because every UPDATE is guarded by `speciesCode IS NULL`, so it only fills
 * gaps and never overwrites.
 *
 * The release workflow runs this after migrations and before deployment. That
 * ordering is required once new writes carry codes: otherwise an old NULL-code
 * row and a new coded row for the same taxon form separate dex groups, and the
 * old group's metadata remains attached to its name key.
 *
 * Usage:
 *   npx vitest run --config vitest.plan.config.ts   # writes the plan
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

const DB = process.env.D1_DATABASE || 'wingdex-db'
const D1_ENV = process.env.D1_ENV
const STATE = `${process.env.HOME}/.cache/wingdex/wrangler-state`

const apply = process.argv.includes('--apply')
const dumpNames = process.argv.includes('--dump-names')
const remote = process.env.D1_REMOTE === '1'
const strictIdx = process.argv.indexOf('--strict')
let strictMax = null
if (strictIdx >= 0) {
  // Validate before touching the database. `--strict foo` or a bare `--strict`
  // yields NaN, and every comparison against NaN is false, so the operator
  // would believe the safety check was active while the apply proceeded.
  const raw = process.argv[strictIdx + 1]
  strictMax = Number(raw)
  if (raw === undefined || raw.startsWith('--') || !Number.isInteger(strictMax) ||
      strictMax < 0) {
    console.error(
      `--strict needs a non-negative integer, got ${raw === undefined ? '(nothing)' : JSON.stringify(raw)}`)
    process.exit(1)
  }
}

function d1(sql) {
  const args = [
    'wrangler', 'd1', 'execute', DB,
    remote ? '--remote' : '--local',
    ...(D1_ENV ? ['--env', D1_ENV] : []),
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
  console.log('next: npx vitest run --config vitest.plan.config.ts')
  process.exit(0)
}

let plan
try {
  plan = JSON.parse(readFileSync(PLAN, 'utf8'))
} catch {
  console.error(
    `No plan at ${PLAN}.\n` +
    `Run: node scripts/backfill-species-code.mjs --dump-names\n` +
    `then: npx vitest run --config vitest.plan.config.ts`)
  process.exit(1)
}
const resolveIdentity = name => {
  const value = plan.map[name]
  if (!value) return null
  return typeof value === 'string'
    ? { speciesCode: value, taxonCode: value }
    : value
}

console.log(`target: ${remote ? 'REMOTE' : 'local'} ${DB}`)
console.log(`plan  : ${plan.count} names resolved, built ${plan.builtAt}`)
if (remote && !apply) console.log('(dry run)')

// PREFLIGHT: resolve and validate EVERY table before writing ANY of them.
//
// Validating inside the write loop meant `observation` could already be
// modified before `dex_meta` tripped the threshold, which contradicts an error
// message telling the operator to investigate before writing. Separating the
// passes makes --strict a real gate rather than a partial one.
const TABLES = ['observation', 'dex_meta']
const plans = []
let strictViolation = null

for (const table of TABLES) {
  const rows = d1(
    `SELECT DISTINCT speciesName FROM ${table} WHERE speciesName IS NOT NULL`)
  const names = rows.map(r => r.speciesName).filter(Boolean)

  const resolved = new Map()
  const unresolved = []
  for (const name of names) {
    const identity = resolveIdentity(name)
    if (identity) resolved.set(name, identity)
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
    strictViolation = strictViolation ?? { table, count: unresolved.length }
  }
  plans.push({ table, resolved })
}

if (strictViolation) {
  console.error(
    `\nERROR: ${strictViolation.count} unresolved names in ` +
    `${strictViolation.table} exceeds --strict ${strictMax}. A large tail ` +
    `means the resolver regressed, not that the data is unusual; investigate ` +
    `before writing. Nothing has been written.`)
  process.exit(1)
}

if (!apply) {
  console.log('\nDRY RUN. Re-run with --apply to write.')
  process.exit(0)
}

for (const { table, resolved } of plans) {

  // ONE statement, not one per species.
  //
  // The first version issued a separate UPDATE per distinct code, which meant
  // 71 sequential `npx wrangler` invocations and about 30 minutes locally. That
  // is merely slow against a local file, but against a remote D1 it is 71
  // round trips that are NOT in a transaction, so an interruption halfway
  // leaves the table half-coded with no record of where it stopped.
  //
  // json_each is the same mechanism the import path already uses for bulk
  // inserts, so this is one prepared statement carrying the whole mapping.
  const pairs = [...resolved].map(([speciesName, identity]) => ({ speciesName, ...identity }))
  const json = sqlQuote(JSON.stringify(pairs))
  const hasGroupKey = table === 'dex_meta' && d1('PRAGMA table_info(dex_meta)')
    .some(column => column.name === 'groupKey')
  const taxonAssignment = table === 'observation'
    ? `, taxonCode = COALESCE(taxonCode, (` +
      `  SELECT json_extract(value, '$.taxonCode') FROM json_each(${json})` +
      `  WHERE json_extract(value, '$.speciesName') = ${table}.speciesName` +
      `))`
    : ''
  const sql =
    `UPDATE ${table} SET speciesCode = COALESCE(speciesCode, (` +
    `  SELECT json_extract(value, '$.speciesCode') FROM json_each(${json})` +
    `  WHERE json_extract(value, '$.speciesName') = ${table}.speciesName` +
    `))${taxonAssignment} WHERE speciesName IN (` +
    `  SELECT json_extract(value, '$.speciesName') ` +
    `  FROM json_each(${json})` +
    `)`
  d1(sql)
  console.log(`  wrote      : ${resolved.size} mappings in 1 statement`)

  if (hasGroupKey) {
    // Migration 0016 may run before this backfill, leaving resolved metadata
    // under name:<label>. Copy and merge those rows into their code-keyed
    // destination before deleting the old keys. If the process stops between
    // statements, the visible destination already exists and a rerun is safe.
    const rekeySql = `
      WITH mapped AS (
        SELECT
          dm.userId,
          dm.groupKey,
          dm.speciesName,
          json_extract(mapping.value, '$.speciesCode') AS speciesCode,
          dm.addedDate,
          dm.bestPhotoId,
          dm.notes
        FROM dex_meta dm
        JOIN json_each(${json}) mapping
          ON json_extract(mapping.value, '$.speciesName') = dm.speciesName
        WHERE dm.groupKey <> 'code:' || json_extract(mapping.value, '$.speciesCode')
      ), deduped_notes AS (
        SELECT DISTINCT userId, speciesCode, notes
        FROM mapped
        WHERE notes <> ''
      ), grouped_notes AS (
        SELECT
          userId,
          speciesCode,
          GROUP_CONCAT(notes, char(10) || char(10)) AS notes
        FROM deduped_notes
        GROUP BY userId, speciesCode
      ), grouped AS (
        SELECT
          userId,
          'code:' || speciesCode AS groupKey,
          MIN(speciesName) AS speciesName,
          speciesCode,
          MIN(addedDate) AS addedDate,
          MIN(bestPhotoId) AS bestPhotoId,
          COALESCE((
            SELECT notes FROM grouped_notes
            WHERE grouped_notes.userId = mapped.userId
              AND grouped_notes.speciesCode = mapped.speciesCode
          ), '') AS notes
        FROM mapped
        GROUP BY userId, speciesCode
      )
      INSERT INTO dex_meta (
        userId, groupKey, speciesName, speciesCode, addedDate, bestPhotoId, notes
      )
      SELECT userId, groupKey, speciesName, speciesCode, addedDate, bestPhotoId, notes
      FROM grouped
      WHERE 1
      ON CONFLICT(userId, groupKey) DO UPDATE SET
        speciesName = MIN(dex_meta.speciesName, excluded.speciesName),
        speciesCode = excluded.speciesCode,
        addedDate = CASE
          WHEN dex_meta.addedDate IS NULL THEN excluded.addedDate
          WHEN excluded.addedDate IS NULL THEN dex_meta.addedDate
          ELSE MIN(dex_meta.addedDate, excluded.addedDate)
        END,
        bestPhotoId = COALESCE(dex_meta.bestPhotoId, excluded.bestPhotoId),
        notes = CASE
          WHEN excluded.notes = '' THEN dex_meta.notes
          WHEN dex_meta.notes = '' THEN excluded.notes
          WHEN dex_meta.notes = excluded.notes OR instr(
            char(10) || char(10) || dex_meta.notes || char(10) || char(10),
            char(10) || char(10) || excluded.notes || char(10) || char(10)
          ) > 0
            THEN dex_meta.notes
          ELSE dex_meta.notes || char(10) || char(10) || excluded.notes
        END
    `
    d1(rekeySql)
    d1(`
      DELETE FROM dex_meta
      WHERE EXISTS (
        SELECT 1 FROM json_each(${json}) mapping
        WHERE json_extract(mapping.value, '$.speciesName') = dex_meta.speciesName
          AND dex_meta.groupKey <> 'code:' || json_extract(mapping.value, '$.speciesCode')
      )
    `)
    console.log('  re-keyed    : grouped metadata under code identities')
  }

  const after = d1(
    `SELECT COUNT(*) AS total, COUNT(speciesCode) AS coded` +
    `${table === 'observation' ? ', COUNT(taxonCode) AS taxonCoded' : ''} FROM ${table}`)[0]
  const taxonSummary = table === 'observation'
    ? `; ${after.taxonCoded}/${after.total} carry an exact taxon code`
    : ''
  console.log(`  verified   : ${after.coded}/${after.total} rows carry a grouping code${taxonSummary}`)
}
