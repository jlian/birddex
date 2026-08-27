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
 * values sourced from .dev.vars rather than passing them as arguments, so they
 * do not land in shell history or the process list.
 *
 * Parts are 100 MiB. R2 requires every part except the last to be the same
 * size, and 100 MiB keeps the part count low while staying far under the 5 GiB
 * per-part ceiling. Each part is streamed from disk, so memory stays flat
 * regardless of archive size.
 */
import { createReadStream, statSync } from 'node:fs'
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3'

const [, , SRC, KEY] = process.argv
const BUCKET = process.env.R2_BUCKET || 'wingdex-places'

if (!SRC || !KEY) {
  console.error('usage: node r2-upload.mjs <file.pmtiles> <key>')
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

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
})

console.log(`${SRC} -> ${BUCKET}/${KEY}`)
console.log(`${(size / 1073741824).toFixed(2)} GiB in ${partCount} parts of ${PART_SIZE / 1048576} MiB`)

const created = await s3.send(new CreateMultipartUploadCommand({
  Bucket: BUCKET,
  Key: KEY,
  ContentType: 'application/octet-stream',
}))
const UploadId = created.UploadId
console.log('multipart upload created')

const started = Date.now()
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

  await s3.send(new CompleteMultipartUploadCommand({
    Bucket: BUCKET,
    Key: KEY,
    UploadId,
    MultipartUpload: { Parts: parts },
  }))
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
const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: KEY }))
console.log(`verified: ${head.ContentLength} bytes on R2`)
if (head.ContentLength !== size) {
  console.error(`SIZE MISMATCH: local ${size}, remote ${head.ContentLength}`)
  process.exit(1)
}
console.log('size matches the local archive')
