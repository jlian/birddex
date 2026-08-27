/**
 * Pull a place extract from Wikidata, once, into a local NDJSON file.
 *
 * This is a BUILD step, not a runtime path. WDQS is a shared research endpoint
 * with a 60s timeout and heavy throttling, so it must never be called to serve a
 * request. The output feeds a D1 table the Worker queries locally.
 *
 * Paginated per class rather than one big query: an unbounded P279* traversal
 * over a large tree times out (body of water reliably does), while the same
 * traversal scoped to one class with LIMIT/OFFSET completes fine.
 *
 * Usage: npx tsx scripts/wikidata-places/pull.ts [--out places.ndjson]
 */
import { writeFileSync, appendFileSync, existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { PLACE_CLASSES } from './classes.ts'

const ENDPOINT = 'https://query.wikidata.org/sparql'
const UA = 'wingdex-places-extract/1.0 (https://wingdex.app; one-off build step)'
const PAGE = 5000
/** Be a good citizen on a shared endpoint. */
const DELAY_MS = 5000
/** Retries with backoff: WDQS returns 429/502/504 under load, and a whole class
 *  should not be lost to one transient failure. */
const RETRIES = 3

export interface PlaceRow {
  qid: string
  name: string
  lat: number
  lon: number
  cls: string
  /** Wikipedia language editions with an article. Nominatim uses inbound link
   *  counts for the same purpose; this is the closest free proxy. */
  links: number
}

function sparql(cls: string, offset: number): string {
  return `
SELECT ?place ?placeLabel ?coord ?links WHERE {
  ?place wdt:P31/wdt:P279* wd:${cls} ;
         wdt:P625 ?coord ;
         wikibase:sitelinks ?links .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY DESC(?links) ?place
LIMIT ${PAGE} OFFSET ${offset}`
}

function parsePoint(wkt: string): { lat: number; lon: number } | null {
  // "Point(-122.405 47.6587)" -- longitude first, which is the usual trap.
  const m = /Point\(([-\d.eE]+) ([-\d.eE]+)\)/.exec(wkt)
  if (!m) return null
  const lon = Number(m[1])
  const lat = Number(m[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  return { lat, lon }
}

async function fetchPage(cls: string, offset: number): Promise<{ rows: PlaceRow[]; raw: number }> {
  const url = `${ENDPOINT}?format=json&query=${encodeURIComponent(sparql(cls, offset))}`
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' } })
  if (!res.ok) throw new Error(`WDQS ${res.status} for ${cls} offset ${offset}`)
  const body = await res.json() as { results: { bindings: Record<string, { value: string }>[] } }

  const rows: PlaceRow[] = []
  for (const b of body.results.bindings) {
    const qid = b.place?.value?.split('/').pop()
    const name = b.placeLabel?.value
    const pt = b.coord?.value ? parsePoint(b.coord.value) : null
    if (!qid || !name || !pt) continue
    // An unlabelled item falls back to its QID, which is useless as an outing name.
    if (/^Q\d+$/.test(name)) continue
    rows.push({ qid, name, lat: pt.lat, lon: pt.lon, cls, links: Number(b.links?.value ?? 0) })
  }
  return { rows, raw: body.results.bindings.length }
}

async function main() {
  const outIdx = process.argv.indexOf('--out')
  const out = outIdx > -1 ? process.argv[outIdx + 1] : 'scripts/wikidata-places/places.ndjson'

  // Resume rather than restart. A full pull takes long enough, and is gentle
  // enough on a shared endpoint, that losing completed classes to one transient
  // 429 is worth avoiding. --fresh forces a clean run.
  //
  // Resume on COMPLETED classes only, and STAGE each class before publishing.
  //
  // Two failure modes have to be avoided at once, and fixing only one creates
  // the other:
  //
  // - Treating "any row exists" as done makes a class that gave up partway
  //   through get skipped forever, silently losing most of a category.
  // - Appending straight to the output makes a retry of an unfinished class
  //   re-append every page it already wrote, accumulating duplicate rows on
  //   each resume.
  //
  // So each class writes to its own staging file, and only a class that
  // reaches its final page is concatenated onto the output and recorded in the
  // marker. An interrupted class leaves a staging file that the next run
  // truncates and rebuilds from offset 0, which is correct because nothing
  // partial ever reached the output.
  const doneMarker = `${out}.done`
  const stageDir = `${out}.staging`
  const fresh = process.argv.includes('--fresh')
  const done = new Set<string>()
  if (fresh) {
    writeFileSync(out, '')
    writeFileSync(doneMarker, '')
    rmSync(stageDir, { recursive: true, force: true })
  } else if (existsSync(doneMarker)) {
    for (const line of readFileSync(doneMarker, 'utf8').split('\n')) {
      if (line.trim()) done.add(line.trim())
    }
    if (done.size > 0) console.log(`resuming; completed classes: ${[...done].join(', ')}`)
  }

  let total = 0
  mkdirSync(stageDir, { recursive: true })
  for (const { qid, label } of PLACE_CLASSES) {
    if (done.has(qid)) continue
    // Truncate any staging file left by an interrupted attempt at this class.
    // Nothing partial ever reached the output, so restarting at offset 0 is
    // correct and cannot duplicate rows.
    const stagePath = `${stageDir}/${qid}.ndjson`
    writeFileSync(stagePath, '')
    let offset = 0
    let forClass = 0
    // Only a class that reaches its final page is marked complete. A give-up
    // leaves it unmarked so the next run retries it.
    let complete = false
    for (;;) {
      let page: { rows: PlaceRow[]; raw: number } | null = null
      for (let attempt = 0; attempt <= RETRIES; attempt++) {
        try {
          page = await fetchPage(qid, offset)
          break
        } catch (err) {
          if (attempt === RETRIES) {
            console.error(`\n  ${label} (${qid}) gave up at offset ${offset}: ${String(err)}`)
          } else {
            // Exponential backoff: 10s, 20s, 40s.
            await new Promise(r => setTimeout(r, 10000 * 2 ** attempt))
          }
        }
      }
      if (!page) break
      if (page.raw === 0) { complete = true; break }
      if (page.rows.length > 0) {
        appendFileSync(stagePath, page.rows.map(r => JSON.stringify(r)).join('\n') + '\n')
      }
      forClass += page.rows.length
      offset += PAGE
      process.stdout.write(`\r  ${label.padEnd(18)} ${forClass}`)
      // Compare against what the SERVER returned. Rows are dropped locally for
      // missing labels or unparseable coordinates, so a short filtered page is
      // normal and does NOT mean the class is exhausted.
      if (page.raw < PAGE) { complete = true; break }
      await new Promise(r => setTimeout(r, DELAY_MS))
    }
    total += forClass
    if (complete) {
      // Publish the class as one append, THEN mark it. If the process dies
      // between the two, the next run redoes the class and overwrites its
      // staging file, which costs time but cannot corrupt the output.
      appendFileSync(out, readFileSync(stagePath))
      appendFileSync(doneMarker, `${qid}\n`)
      rmSync(stagePath, { force: true })
      process.stdout.write(`\r  ${label.padEnd(18)} ${forClass}\n`)
    } else {
      process.stdout.write(`\r  ${label.padEnd(18)} ${forClass} INCOMPLETE, discarded; will retry on the next run\n`)
    }
    await new Promise(r => setTimeout(r, DELAY_MS))
  }
  console.log(`\ntotal rows: ${total} -> ${out}`)
}

main().catch(err => { console.error(err); process.exit(1) })
