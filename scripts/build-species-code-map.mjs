#!/usr/bin/env node
/** Build the codes-only name lookup used by server write paths. */
import { readFileSync, writeFileSync } from 'node:fs'

const taxonomy = JSON.parse(readFileSync('src/lib/taxonomy.json', 'utf8'))
const extra = JSON.parse(readFileSync('src/lib/taxonomy-extra.json', 'utf8'))
const map = Object.create(null)

function add(name, taxonCode, speciesCode) {
  const key = String(name || '').trim().toLowerCase()
  if (key && !map[key]) map[key] = [taxonCode, speciesCode]
}

// Classifier names win every collision with the display sidecar.
for (const [common, scientific, code] of taxonomy) {
  if (!code) continue
  add(common, code, code)
  add(scientific, code, code)
}
for (const [code, common, scientific, , , reportAsCode] of extra.entries) {
  add(common, code, reportAsCode || code)
  add(scientific, code, reportAsCode || code)
}

const ordered = Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)))
writeFileSync('functions/lib/species-code-map.json', JSON.stringify(ordered) + '\n')
console.log(`Wrote functions/lib/species-code-map.json with ${Object.keys(ordered).length} names`)
