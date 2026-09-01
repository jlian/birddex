#!/usr/bin/env node
/** Compare coded taxonomy names against a revision that shipped an older blob. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const TAXONOMY = 'src/lib/taxonomy.json'
const baseRef = process.argv[2]
if (!baseRef) {
  console.error('Usage: node scripts/diff-taxonomy-names.mjs <base-ref>')
  process.exit(2)
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim()
}

let resolvedBase
try {
  resolvedBase = git('rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`)
} catch {
  console.error(`Could not resolve base ref ${baseRef}.`)
  process.exit(2)
}

const resolvedHead = git('rev-parse', '--verify', 'HEAD^{commit}')
if (resolvedBase === resolvedHead) {
  console.error(`Refusing ${baseRef}: it resolves to HEAD and cannot reveal a rename.`)
  process.exit(2)
}

function blob(revision) {
  try {
    return git('rev-parse', '--verify', '--end-of-options', `${revision}:${TAXONOMY}`)
  } catch {
    return ''
  }
}

const baseBlob = blob(resolvedBase)
const headBlob = blob('HEAD')
if (baseBlob && baseBlob === headBlob) {
  console.error(`Refusing ${baseRef}: it carries the same ${TAXONOMY} blob as HEAD.`)
  process.exit(2)
}

function mapping(rows) {
  const result = new Map()
  for (const row of rows) {
    if (row[2]) result.set(row[2], { common: row[0], scientific: row[1] })
  }
  return result
}

let before
try {
  before = mapping(JSON.parse(git('show', `${resolvedBase}:${TAXONOMY}`)))
} catch {
  console.error(`Could not read ${TAXONOMY} at ${baseRef}.`)
  process.exit(2)
}
const after = mapping(JSON.parse(readFileSync(TAXONOMY, 'utf8')))
const added = []
const removed = []
const commonRenamed = []
const scientificRenamed = []

for (const [code, names] of after) {
  const old = before.get(code)
  if (!old) added.push(`${code}  ${names.common} (${names.scientific})`)
  else {
    if (old.common !== names.common) commonRenamed.push(`${code}  ${old.common}  ->  ${names.common}`)
    if (old.scientific !== names.scientific) scientificRenamed.push(`${code}  ${old.scientific}  ->  ${names.scientific}`)
  }
}
for (const [code, names] of before) {
  if (!after.has(code)) removed.push(`${code}  ${names.common} (${names.scientific})`)
}

function show(label, rows) {
  console.log(`\n${label}: ${rows.length}`)
  for (const row of rows.slice(0, 40)) console.log(`  ${row}`)
  if (rows.length > 40) console.log(`  ... and ${rows.length - 40} more`)
}

console.log(`Comparing ${TAXONOMY} against ${baseRef}`)
show('Added', added)
show('Removed', removed)
show('COMMON NAME RENAMED', commonRenamed)
show('SCIENTIFIC NAME RENAMED', scientificRenamed)

if (commonRenamed.length || scientificRenamed.length) process.exit(1)
console.log('\nNo renames.')
