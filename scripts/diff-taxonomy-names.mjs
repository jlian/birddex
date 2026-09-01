#!/usr/bin/env node
/**
 * Report how the eBird code to common and scientific names changed, so a taxonomy
 * update can be classified before it ships.
 *
 * Adds and removals are safe. A RENAME is not: dex groups are keyed by the
 * display name today (issue #306), so a client still writing the old spelling
 * after the server adopts a new one forks the user's life list into two
 * entries. See src/lib/taxonomy-names-hash.ts for the full rule.
 *
 * Usage, comparing the working tree against the revision you are merging into:
 *
 *   node scripts/diff-taxonomy-names.mjs origin/main
 *   node scripts/diff-taxonomy-names.mjs $(git merge-base HEAD origin/main)
 *
 * The base ref is required and HEAD is refused, because after the taxonomy is
 * committed HEAD holds the same file and every rename compares clean.
 *
 * Exit status is 0 when nothing was renamed, 1 when something was, so it can
 * gate a release step.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const TAXONOMY = 'src/lib/taxonomy.json'

// A base revision is REQUIRED, and deliberately has no default.
//
// Defaulting to HEAD made this a no-op exactly when it mattered: once the
// taxonomy change is committed, HEAD and the working tree hold the same file,
// so a rename compares against itself and exits 0. The companion hash test
// passes in that same commit too, because its constant was updated alongside.
// A gate that only fires before you commit is not a gate.
const baseRef = process.argv[2]
if (!baseRef) {
  console.error(
    'Usage: node scripts/diff-taxonomy-names.mjs <base-ref>\n\n' +
    'Compare the working tree taxonomy against the taxonomy a base revision\n' +
    'shipped. Use the branch you are merging into, not HEAD:\n\n' +
    '  node scripts/diff-taxonomy-names.mjs origin/main\n' +
    '  node scripts/diff-taxonomy-names.mjs $(git merge-base HEAD origin/main)\n\n' +
    'HEAD is refused: after the taxonomy commit it compares the file with\n' +
    'itself and always reports no renames.')
  process.exit(2)
}
let resolvedBase
try {
  resolvedBase = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`], {
    encoding: 'utf8',
  }).trim()
} catch {
  console.error(`Could not resolve base ref ${baseRef}.`)
  process.exit(2)
}
const resolvedHead = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
  encoding: 'utf8',
}).trim()
if (resolvedBase === resolvedHead) {
  console.error(
    `Refusing base ref ${baseRef}: it resolves to HEAD, so it compares the\n` +
    'taxonomy file against itself and can never report a rename.\n' +
    'Pass the branch you are merging into, e.g. origin/main.')
  process.exit(2)
}

// Comparing against a DIFFERENT commit that happens to carry the SAME taxonomy
// is just as useless, and far easier to do by accident: every commit on this
// branch after the taxonomy landed holds an identical blob, so `HEAD~1` or a
// merge-base computed after the fact reports a clean run while checking
// nothing.
//
// Compare the blob rather than the commit. That is the invariant the gate
// actually depends on: the base must have shipped a different taxonomy.
function taxonomyBlob(rev) {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${rev}:${TAXONOMY}`], {
      encoding: 'utf8',
    }).trim()
  } catch {
    return ''
  }
}
const baseBlob = taxonomyBlob(resolvedBase)
const headBlob = taxonomyBlob('HEAD')
if (baseBlob && baseBlob === headBlob) {
  console.error(
    `Refusing base ref ${baseRef}: it carries the same ${TAXONOMY} as HEAD\n` +
    `(blob ${baseBlob.slice(0, 12)}), so every name compares equal and no\n` +
    'rename can be reported. Pass a revision from before the taxonomy\n' +
    'changed, e.g. origin/main.')
  process.exit(2)
}

/** code -> { common, scientific }, for every row that carries a code. */
function mapping(rows) {
  const out = new Map()
  for (const row of rows) {
    const code = row[2]
    if (code) out.set(code, { common: row[0], scientific: row[1] })
  }
  return out
}

function readBase() {
  try {
    const raw = execFileSync('git', ['show', `${resolvedBase}:${TAXONOMY}`], {
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
const commonRenamed = []
const scientificRenamed = []

for (const [code, names] of after) {
  const oldNames = before.get(code)
  if (!oldNames) {
    added.push(`${code}  ${names.common} (${names.scientific})`)
    continue
  }
  if (oldNames.common !== names.common) {
    commonRenamed.push(`${code}  ${oldNames.common}  ->  ${names.common}`)
  }
  if (oldNames.scientific !== names.scientific) {
    scientificRenamed.push(`${code}  ${oldNames.scientific}  ->  ${names.scientific}`)
  }
}
for (const [code, names] of before) {
  if (!after.has(code)) removed.push(`${code}  ${names.common} (${names.scientific})`)
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
show('COMMON NAME RENAMED', commonRenamed)
show('SCIENTIFIC NAME RENAMED', scientificRenamed)

if (commonRenamed.length === 0 && scientificRenamed.length === 0) {
  console.log('\nNo renames. Safe to ship on the current name-keyed dex.')
  process.exit(0)
}

console.error(
  '\nNAME RENAMES PRESENT. Dex groups are keyed by display name today (issue #306),\n' +
  'so a shipped client still writing an old spelling will fork the life list\n' +
  'into duplicate entries. Land the code-keying migration first, or in the\n' +
  'same release, before shipping any client against this taxonomy.')
process.exit(1)
