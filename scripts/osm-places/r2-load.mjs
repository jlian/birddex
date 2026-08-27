/**
 * Load a PMTiles archive into the LOCAL miniflare R2 for `wrangler dev`.
 *
 * Why not `wrangler r2 object put`: it reads the whole object into memory, and
 * a 5.6 GB buffer will not fit. Miniflare's on-disk layout is simple enough to
 * write directly: the payload is a content-addressed blob file, and one row in
 * the bucket's sqlite names it. Streaming the copy keeps memory flat.
 *
 * Keys are dated, so a load never overwrites a previous archive in place. That
 * matters because the PMTiles header and directory caches are keyed on the
 * archive key: replacing an object under a stable key would leave a warm
 * isolate reading old directories against new tile bytes.
 */
import { createReadStream, createWriteStream, statSync, mkdirSync, readdirSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const [, , SRC, KEY] = process.argv
if (!SRC || !KEY) {
  console.error('usage: node r2-load.mjs <file.pmtiles> <key>')
  process.exit(1)
}

const ROOT = '.wrangler/state/v3/r2'
const BUCKET = 'wingdex-places'

/**
 * Miniflare names each bucket's sqlite file after a hash of the bucket name,
 * and that hash is neither documented nor stable across versions. Discover it
 * rather than hardcoding, so this cannot silently write to the wrong bucket or
 * fail on a machine whose local state came from a different wrangler.
 */
function findBucketDb() {
  const dir = path.join(ROOT, 'miniflare-R2BucketObject')
  const files = readdirSync(dir).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')
  if (files.length === 0) {
    throw new Error(`no bucket sqlite in ${dir}; run \`wrangler dev\` once to create local R2 state`)
  }
  if (files.length > 1) {
    throw new Error(`several bucket sqlite files in ${dir}, cannot tell which is ${BUCKET}: ${files.join(', ')}`)
  }
  return path.join(dir, files[0])
}

const DB = findBucketDb()

const size = statSync(SRC).size

// Miniflare blob ids are 32 bytes of hex plus a 16-hex suffix; the exact shape
// does not matter to the reader, only that the row and the filename agree.
const blobId = randomBytes(32).toString('hex') + randomBytes(8).toString('hex')
const blobDir = path.join(ROOT, BUCKET, 'blobs')
mkdirSync(blobDir, { recursive: true })
const blobPath = path.join(blobDir, blobId)

console.log(`copying ${(size / 1e9).toFixed(2)} GB -> ${blobPath}`)
const md5 = createHash('md5')
const rs = createReadStream(SRC)
rs.on('data', (c) => md5.update(c))
await pipeline(rs, createWriteStream(blobPath))
const etag = md5.digest('hex')
console.log(`etag ${etag}`)

// Escape for a SQL string literal. This is a local dev tool rather than a
// server, but an unescaped key containing an apostrophe would corrupt the
// bucket database instead of failing cleanly, and object keys are arbitrary.
const q = (s) => `'${String(s).replace(/'/g, "''")}'`

const sql = `
DELETE FROM _mf_objects WHERE key = ${q(KEY)};
INSERT INTO _mf_objects (key, blob_id, version, size, etag, uploaded, checksums, http_metadata, custom_metadata)
VALUES (${q(KEY)}, ${q(blobId)}, ${q(randomBytes(16).toString('hex'))}, ${size}, ${q(etag)}, ${Date.now()}, '{}', '{}', '{}');
SELECT key, size FROM _mf_objects;
`
console.log(execFileSync('sqlite3', [DB], { input: sql }).toString())
