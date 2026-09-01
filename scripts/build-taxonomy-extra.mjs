#!/usr/bin/env node
/**
 * Build src/lib/taxonomy-extra.json, the display sidecar for eBird taxa that
 * are deliberately NOT in the classifier.
 *
 * WHY THIS EXISTS
 * ---------------
 * src/lib/taxonomy.json does two unrelated jobs:
 *
 *   1. Classifier index space. bird-id-local.ts asserts
 *      nSpecies === taxonomy.length, and ROW POSITION keys the int8 matrix and
 *      both prior blobs. It must stay exactly the shipped species count.
 *   2. Display dictionary. loadOrderMap() builds name-keyed maps for sort
 *      order, eBird code, wiki title and BirdLife id. Position is irrelevant.
 *
 * Job 2 wants to grow, job 1 must not. So the extra taxa live here instead.
 * Nothing in this file is ever fed to the classifier.
 *
 * WHAT GOES IN IT
 * ---------------
 * Every eBird taxon whose species code is NOT already in taxonomy.json:
 *
 *   spuh        "Gull sp."                     722
 *   slash       "Greater/Lesser Scaup"        1035
 *   hybrid      "Mallard x American Black"     792
 *   issf        subspecies groups             3952
 *   form/intergrade                            198
 *   domestic    "Domestic Chicken"              25
 *   species     the extinct species dropped     173
 *
 * All of these can appear in a real eBird export, so all of them can land in
 * observation.speciesName and need a details page.
 *
 * SOURCING: ONE HTTP REQUEST
 * --------------------------
 * The full eBird taxonomy is a single public CSV, no API key. Fetching it once
 * gives code, category, taxonomic order and the REPORT_AS parent for every
 * taxon, so there is no per-species lookup to do. Do NOT loop over taxa
 * hitting the eBird API; it is unnecessary and rude.
 *
 * Wikipedia titles and thumbnails are NOT resolved here. That is a separate
 * step (hydrate-wiki-titles.mjs) which already bulk-matches via one Wikidata
 * SPARQL query and batches the MediaWiki pageimages API 50 titles at a time.
 *
 * Usage:
 *   node scripts/build-taxonomy-extra.mjs [--csv .tmp/ebird-taxonomy-full.csv]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import Papa from 'papaparse'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TAXONOMY_PATH = resolve(__dirname, '../src/lib/taxonomy.json')
const OUT_PATH = resolve(__dirname, '../src/lib/taxonomy-extra.json')
const CACHE_PATH = resolve(__dirname, '../.tmp/ebird-taxonomy-full.csv')

// Public eBird taxonomy, every category. No API key. cat= is omitted on
// purpose: fetch-ebird-codes.mjs passes cat=species because it only wants the
// classifier set, and this script wants everything else.
const EBIRD_CSV_URL = 'https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=csv'

async function loadEbirdCsv(explicit) {
  const path = explicit || CACHE_PATH
  if (existsSync(path)) {
    console.log(`Using cached eBird taxonomy: ${path}`)
    return readFileSync(path, 'utf8')
  }
  console.log('Fetching the full eBird taxonomy (one request)...')
  const res = await fetch(EBIRD_CSV_URL)
  if (!res.ok) throw new Error(`eBird taxonomy fetch failed: ${res.status}`)
  const text = await res.text()
  // .tmp does not exist on a fresh checkout, so the cache write would ENOENT
  // before the sidecar could be built.
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  console.log(`  cached to ${path}`)
  return text
}

function main(csvText) {
  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: 'greedy' })
  if (parsed.errors.length > 0) {
    throw new Error(`eBird taxonomy CSV has ${parsed.errors.length} parse error(s): ${parsed.errors[0].message}`)
  }

  const requiredFields = ['SPECIES_CODE', 'COMMON_NAME', 'SCIENTIFIC_NAME', 'CATEGORY', 'TAXON_ORDER', 'REPORT_AS']
  const fields = new Set(parsed.meta.fields ?? [])
  const missingFields = requiredFields.filter(field => !fields.has(field))
  if (missingFields.length > 0) {
    throw new Error(`eBird taxonomy CSV is missing required columns: ${missingFields.join(', ')}`)
  }

  const rows = parsed.data.filter(r => r.SPECIES_CODE)
  if (rows.length === 0) {
    throw new Error('eBird taxonomy CSV contains no coded rows')
  }

  const taxonomy = JSON.parse(readFileSync(TAXONOMY_PATH, 'utf8'))
  const classifierCodes = new Set(taxonomy.map(r => r[2]))

  if (classifierCodes.size !== taxonomy.length) {
    throw new Error(
      `taxonomy.json has ${taxonomy.length} rows but ${classifierCodes.size} ` +
      `unique codes; the code is meant to be a unique key`)
  }

  const extra = []
  const byCategory = {}
  for (const r of rows) {
    if (classifierCodes.has(r.SPECIES_CODE)) continue
    byCategory[r.CATEGORY] = (byCategory[r.CATEGORY] || 0) + 1

    // REPORT_AS names the species eBird rolls this taxon up into. Kept so the
    // UI can offer "counts toward X", and as a fallback ordering anchor.
    // Empty for spuh/slash/hybrid that span multiple species, and for the
    // extinct species, which are species in their own right.
    const parent = r.REPORT_AS?.trim() || ''

    extra.push([
      r.SPECIES_CODE,
      r.COMMON_NAME,
      r.SCIENTIFIC_NAME,
      r.CATEGORY,
      Number(r.TAXON_ORDER),
      parent,
    ])
  }

  // eBird's TAXON_ORDER is a float ordering across the WHOLE taxonomy, so it
  // orders these entries correctly RELATIVE TO EACH OTHER. It does not
  // interleave them with the classifier species: taxonomy-order.ts offsets
  // them past the classifier rows on purpose, so sidecar taxa sort after every
  // real species rather than next to their relatives. Interleaving would mean
  // keying classifier order off TAXON_ORDER too, which is a larger change.
  //
  // It is a sort hint only: it renumbers whenever eBird inserts or splits a
  // taxon, so it must never be used as a key.
  extra.sort((a, b) => a[4] - b[4])

  const out = {
    note:
      'Display-only sidecar for eBird taxa that are NOT in the classifier. ' +
      'Never fed to the model: taxonomy.json row position keys the int8 matrix ' +
      'and both prior blobs, so that file must not grow. Entries are ' +
      '[code, common, scientific, category, taxonOrder, reportAsCode]. ' +
      'taxonOrder is a sort hint from eBird and renumbers on their revisions; ' +
      'it is not a stable key. Built by scripts/build-taxonomy-extra.mjs.',
    ebird_taxonomy_taxa: rows.length,
    classifier_species: taxonomy.length,
    count: extra.length,
    categories: byCategory,
    entries: extra,
  }

  writeFileSync(OUT_PATH, JSON.stringify(out, null, 0) + '\n')

  const kb = (JSON.stringify(out).length / 1024).toFixed(0)
  console.log(`\nWrote ${OUT_PATH}`)
  console.log(`  eBird taxa      : ${rows.length}`)
  console.log(`  classifier      : ${taxonomy.length} (untouched)`)
  console.log(`  sidecar entries : ${extra.length}  (~${kb} KB)`)
  for (const [cat, n] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`      ${cat.padEnd(12)} ${n}`)
  }
}

const explicit = process.argv.includes('--csv')
  ? process.argv[process.argv.indexOf('--csv') + 1]
  : null
loadEbirdCsv(explicit).then(main).catch(err => {
  console.error(err.message)
  process.exit(1)
})
