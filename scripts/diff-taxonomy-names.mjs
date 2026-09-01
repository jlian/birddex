#!/usr/bin/env node
/**
 * Report how the eBird code to common-name mapping changed, so a taxonomy
 * update can be classified before it ships.
 *
 * Adds and removals are safe. A RENAME is not: dex groups are keyed by the
 * display name today (issue #306), so a client still writing the old spelling
 * after the server adopts a new one forks the user's life list into two
 * entries. See src/lib/taxonomy-names-hash.ts for the full rule.
 *
 * Usage, comparing the working tree against a git revision:
 *
 *   node scripts/diff-taxonomy-names.mjs            # against HEAD
 *   node scripts/diff-taxonomy-names.mjs origin/main
 *
 * Exit status is 0 when nothing was renamed, 1 when something was, so it can
 * gate a release step.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const TAXONOMY = 'src/lib/taxonomy.json'
const baseRef = process.argv[2] ?? 'HEAD'

/** code -> common name, for every row that carries a code. */
function mapping(rows) {
  const out = new Map()
  for (const row of rows) {
    const code = row[2]
    if (code) out.set(code, row[0])
  }
  return out
}

function readBase() {
  try {
    const raw = execFileSync('git', ['show', `${baseRef}:${TAXONOMY}`], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    })
    return mapping(JSON.parse(raw))
  } catch {
    console.error(`Could not read ${TAXONOMY} at ${baseRef}.`)
    process.exit(2)
  }
}

const before = readBase()
const after = mapping(JSON.parse(readFileSync(TAXONOMY, 'utf8')))

const added = []
const removed = []
const renamed = []

for (const [code, name] of after) {
  if (!before.has(code)) added.push(`${code}  ${name}`)
  else if (before.get(code) !== name) renamed.push(`${code}  ${before.get(code)}  ->  ${name}`)
}
for (const [code, name] of before) {
  if (!after.has(code)) removed.push(`${code}  ${name}`)
}

const show = (label, list) => {
  console.log(`\n${label}: ${list.length}`)
  for (const line of list.slice(0, 40)) console.log(`  ${line}`)
  if (list.length > 40) console.log(`  ... and ${list.length - 40} more`)
}

console.log(`Comparing ${TAXONOMY} against ${baseRef}`)
console.log(`  before: ${before.size} coded species`)
console.log(`  after : ${after.size} coded species`)
show('Added', added)
show('Removed', removed)
show('RENAMED', renamed)

if (renamed.length === 0) {
  console.log('\nNo renames. Safe to ship on the current name-keyed dex.')
  process.exit(0)
}

console.error(
  '\nRENAMES PRESENT. Dex groups are keyed by display name today (issue #306),\n' +
  'so a shipped client still writing an old spelling will fork the life list\n' +
  'into duplicate entries. Land the code-keying migration first, or in the\n' +
  'same release, before shipping any client against this taxonomy.')
process.exit(1)
