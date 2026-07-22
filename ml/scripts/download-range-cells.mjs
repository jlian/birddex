#!/usr/bin/env node
/**
 * Download ONLY the range-prior cells covering the benchmark locations
 * into .tmp/range-priors/cells/. Mirrors upload-range-priors-prod.mjs auth.
 * Never logs credential values.
 */
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { latLonToCell, nearestNeighborCell, lonLatToEqualEarth } from '../../../functions/lib/range-adjust.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..', '..')
const cellsDir = resolve(ROOT, '.tmp/range-priors/cells')
mkdirSync(cellsDir, { recursive: true })

function readDevVars() {
  const p = resolve(ROOT, '.dev.vars')
  if (!existsSync(p)) return {}
  const v = {}
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq > 0) v[t.slice(0, eq)] = t.slice(eq + 1)
  }
  return v
}
const dv = readDevVars()
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || dv.CF_ACCOUNT_ID
const accessKeyId = process.env.R2_ACCESS_KEY_ID || dv.R2_ACCESS_KEY_ID
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || dv.R2_SECRET_ACCESS_KEY
if (!CF_ACCOUNT_ID || !accessKeyId || !secretAccessKey) {
  console.error('Missing CF_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY')
  process.exit(1)
}

const LOCS = [
  [47.6543,-122.2952],[47.6399,-122.4039],[47.7117,-122.3771],[48.3918,-122.4885],
  [36.6002,-121.8947],[47.6399,-122.2958],[48.9784,-122.7913],[47.6062,-122.3421],
  [47.6600,-122.4287],[41.9632,-87.6342],[42.0089,-87.8310],[20.7148,-156.2502],
  [52.3581,4.8826],[45.8097,9.0846],[25.7,118.24],[24.998,121.581],[40.0,-100.0],
  [48.3204,-122.8352],
]
const cells = new Set()
for (const [lat,lon] of LOCS) {
  const c = latLonToCell(lat,lon); if (!c) continue
  // pull the full 3x3 ring so the expanded (8-neighbor) range lookup has all
  // adjacent cells available, not just the single closest edge.
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) cells.add(`${c.row+dr}-${c.col+dc}`)
  const {x,y} = lonLatToEqualEarth(lon,lat)
  const n = nearestNeighborCell(x,y,c.row,c.col)
  if (n) cells.add(`${n.row}-${n.col}`)
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
})
const BUCKET = 'wingdex-range-priors'

let ok = 0, miss = 0, err = 0
for (const cell of cells) {
  const key = `range-priors/${cell}.bin.gz`
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
    const buf = Buffer.from(await r.Body.transformToByteArray())
    writeFileSync(resolve(cellsDir, `${cell}.bin.gz`), buf)
    ok++
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) { miss++ }
    else { err++; if (err <= 3) console.error(`  err ${cell}: ${e.name}`) }
  }
}
console.log(`cells requested=${cells.size} downloaded=${ok} notFound(ocean/empty)=${miss} errors=${err}`)
console.log(`written to ${cellsDir}`)
