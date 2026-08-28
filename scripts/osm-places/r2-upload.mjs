/**
 * Upload a large PMTiles archive to production R2 over the S3 API.
 *
 * `wrangler r2 object put` refuses anything above 300 MiB and wrangler exposes
 * no multipart subcommands, so a 1.5 GB archive cannot go up that way. R2 is
 * S3-compatible, and `@aws-sdk/client-s3` is already a dependency of this repo,
 * so the multipart upload uses that.
 *
 * Credentials come from the environment (R2_ACCESS_KEY_ID,
 * R2_SECRET_ACCESS_KEY, CF_ACCOUNT_ID) and are never logged. Run it with the
 * values sourced from .r2.vars rather than passing them as arguments, so they
 * do not land in shell history, the process list, or Wrangler's Worker env.
 *
 * Parts are 100 MiB. R2 requires every part except the last to be the same
 * size, and 100 MiB keeps the part count low while staying far under the 5 GiB
 * per-part ceiling. Each part is streamed from disk, so memory stays flat
 * regardless of archive size.
 */
import { closeSync, createReadStream, openSync, readSync, statSync } from 'node:fs'
import { PMTiles, ResolvedValueCache, TileType, bytesToHeader } from 'pmtiles'
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'

const [, , SRC, KEY] = process.argv
const BUCKET = process.env.R2_BUCKET || 'wingdex-places'

if (!SRC || !KEY) {
  console.error('usage: node r2-upload.mjs <file.pmtiles> places-YYYYMMDD.pmtiles')
  process.exit(1)
}

if (KEY.length !== 23 || !/^places-\d{8}\.pmtiles$/.test(KEY)) {
  console.error('key must be ASCII and match places-YYYYMMDD.pmtiles')
  process.exit(1)
}

const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CF_ACCOUNT_ID } = process.env
if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !CF_ACCOUNT_ID) {
  console.error('missing R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY or CF_ACCOUNT_ID in the environment')
  process.exit(1)
}

const PART_SIZE = 100 * 1024 * 1024
const size = statSync(SRC).size
const partCount = Math.ceil(size / PART_SIZE)
const HEADER_SIZE = 127
const header = Buffer.alloc(HEADER_SIZE)
const fd = openSync(SRC, 'r')
try {
  readSync(fd, header, 0, header.length, 0)
} finally {
  closeSync(fd)
}
function validateHeader(bytes, objectSize, label) {
  if (bytes.length !== HEADER_SIZE || bytes.subarray(0, 7).toString('ascii') !== 'PMTiles') {
    throw new Error(`${label} is not a PMTiles archive`)
  }
  const parsed = bytesToHeader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  if (parsed.specVersion !== 3) {
    throw new Error(`${label} uses unsupported PMTiles spec version ${parsed.specVersion}`)
  }
  if (parsed.tileType !== TileType.Mvt) {
    throw new Error(`${label} does not contain MVT vector tiles`)
  }
  if (parsed.minZoom > 12 || parsed.maxZoom < 12) {
    throw new Error(`${label} does not contain zoom 12`)
  }
  for (const [name, offset, length] of [
    ['root directory', parsed.rootDirectoryOffset, parsed.rootDirectoryLength],
    ['JSON metadata', parsed.jsonMetadataOffset, parsed.jsonMetadataLength],
    ['leaf directories', parsed.leafDirectoryOffset, parsed.leafDirectoryLength],
    ['tile data', parsed.tileDataOffset, parsed.tileDataLength],
  ]) {
    if (length === undefined || offset < HEADER_SIZE || length < 0 || offset + length > objectSize) {
      throw new Error(`${label} has an invalid ${name} range`)
    }
  }
  return parsed
}
try {
  validateHeader(header, size, 'source')
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

const archiveFd = openSync(SRC, 'r')
try {
  const source = {
    getKey: () => SRC,
    getBytes: async (offset, length) => {
      const bytes = Buffer.alloc(length)
      const count = readSync(archiveFd, bytes, 0, length, offset)
      if (count !== length) throw new Error(`source ended while reading bytes ${offset}-${offset + length - 1}`)
      return { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
    },
  }
  const metadata = await new PMTiles(source, new ResolvedValueCache()).getMetadata()
  const layers = metadata && typeof metadata === 'object' && 'vector_layers' in metadata
    ? metadata.vector_layers
    : undefined
  const layerIds = new Set(Array.isArray(layers)
    ? layers.flatMap(layer => layer && typeof layer === 'object' && 'id' in layer && typeof layer.id === 'string'
      ? [layer.id]
      : [])
    : [])
  for (const required of ['parks', 'admin']) {
    if (!layerIds.has(required)) throw new Error(`source metadata is missing the ${required} vector layer`)
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  closeSync(archiveFd)
}
if (process.exitCode) process.exit(process.exitCode)

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
})

console.log(`${SRC} -> ${BUCKET}/${JSON.stringify(KEY)}`)
console.log(`${(size / 1073741824).toFixed(2)} GiB in ${partCount} parts of ${PART_SIZE / 1048576} MiB`)

try {
  await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: KEY }))
  console.error(`refusing to replace immutable archive ${JSON.stringify(KEY)}; use a new dated key`)
  process.exit(1)
} catch (error) {
  if (error.$metadata?.httpStatusCode !== 404) throw error
}

const created = await s3.send(new CreateMultipartUploadCommand({
  Bucket: BUCKET,
  Key: KEY,
  ContentType: 'application/octet-stream',
}))
const UploadId = created.UploadId
console.log('multipart upload created')

const started = Date.now()
let completedETag
try {
  const parts = []
  for (let i = 0; i < partCount; i++) {
    const start = i * PART_SIZE
    const end = Math.min(start + PART_SIZE, size) - 1
    // ContentLength must be explicit: the SDK cannot infer a stream's length,
    // and R2 rejects a part sent with chunked encoding.
    const res = await s3.send(new UploadPartCommand({
      Bucket: BUCKET,
      Key: KEY,
      UploadId,
      PartNumber: i + 1,
      Body: createReadStream(SRC, { start, end }),
      ContentLength: end - start + 1,
    }))
    parts.push({ PartNumber: i + 1, ETag: res.ETag })
    const done = ((i + 1) / partCount * 100).toFixed(0)
    const mbps = ((end + 1) / 1048576 / ((Date.now() - started) / 1000)).toFixed(1)
    console.log(`  part ${i + 1}/${partCount} ok (${done}%, ${mbps} MB/s)`)
  }

  const completed = await s3.send(new CompleteMultipartUploadCommand({
    Bucket: BUCKET,
    Key: KEY,
    UploadId,
    MultipartUpload: { Parts: parts },
  }))
  completedETag = completed.ETag
  console.log(`completed in ${Math.round((Date.now() - started) / 1000)}s`)
} catch (error) {
  // An abandoned multipart upload keeps billable parts around, so clean up
  // rather than leaving them to a lifecycle rule.
  console.error('upload failed, aborting the multipart upload')
  await s3.send(new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: KEY, UploadId }))
    .catch(() => console.error('abort also failed; check for orphaned parts'))
  throw error
}

// Verify by reading back what R2 actually stored, rather than trusting the
// completion response.
try {
  const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: KEY }))
  console.log(`verified: ${head.ContentLength} bytes on R2`)
  if (head.ContentLength !== size) {
    throw new Error(`SIZE MISMATCH: local ${size}, remote ${head.ContentLength}`)
  }
  const remoteHeader = await s3.send(new GetObjectCommand({
    Bucket: BUCKET,
    Key: KEY,
    Range: `bytes=0-${HEADER_SIZE - 1}`,
  }))
  const remoteBytes = Buffer.from(await remoteHeader.Body.transformToByteArray())
  validateHeader(remoteBytes, Number(head.ContentLength), 'remote object')
  if (!remoteBytes.equals(header)) {
    throw new Error('HEADER MISMATCH: remote PMTiles header differs from the local archive')
  }
  console.log('size and PMTiles v3 header match the local archive')
} catch (error) {
  console.error(error.message)
  // Only remove the object this invocation just completed. The ETag check
  // avoids deleting a later object if an administrator replaced it manually.
  const current = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: KEY })).catch(() => null)
  if (completedETag && current?.ETag === completedETag) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: KEY }))
    console.error(`removed failed upload ${JSON.stringify(KEY)}`)
  } else {
    console.error(`could not safely remove ${JSON.stringify(KEY)}; inspect it before reusing this dated key`)
  }
  process.exit(1)
}
