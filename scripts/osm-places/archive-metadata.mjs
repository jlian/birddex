import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export const REQUIRED_ARCHIVE_METADATA = Object.freeze({
  attribution: '(c) OpenStreetMap contributors, ODbL 1.0',
  license: 'ODbL-1.0',
  license_url: 'https://opendatacommons.org/licenses/odbl/1-0/',
  source: 'OpenStreetMap',
})

export function applyArchiveMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('PMTiles metadata must be a JSON object')
  }
  const updated = { ...metadata, ...REQUIRED_ARCHIVE_METADATA }
  delete updated.generator_options
  return updated
}

export function validateArchiveMetadata(metadata, label = 'archive') {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error(`${label} metadata must be a JSON object`)
  }
  for (const [key, expected] of Object.entries(REQUIRED_ARCHIVE_METADATA)) {
    if (metadata[key] !== expected) {
      throw new Error(`${label} metadata ${key} must equal ${JSON.stringify(expected)}`)
    }
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  const [, , command, input, output] = process.argv
  if (!input || (command !== 'apply' && command !== 'check') || (command === 'apply' && !output)) {
    console.error('usage: node archive-metadata.mjs apply <input.json> <output.json> | check <input.json>')
    process.exit(1)
  }

  try {
    const metadata = JSON.parse(readFileSync(input, 'utf8'))
    if (command === 'apply') {
      writeFileSync(output, `${JSON.stringify(applyArchiveMetadata(metadata))}\n`)
    } else {
      validateArchiveMetadata(metadata)
    }
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}