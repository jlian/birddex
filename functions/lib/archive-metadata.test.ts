import { describe, expect, it } from 'vitest'
import {
  REQUIRED_ARCHIVE_METADATA,
  applyArchiveMetadata,
  validateArchiveMetadata,
} from '../../scripts/osm-places/archive-metadata.mjs'

describe('archive metadata', () => {
  it('preserves generated metadata while adding the required ODbL fields', () => {
    const metadata = applyArchiveMetadata({
      name: 'WingDex places',
      vector_layers: [{ id: 'parks' }, { id: 'admin' }],
      generator_options: '/mnt/scratch',
    })

    expect(metadata).toMatchObject({
      name: 'WingDex places',
      vector_layers: [{ id: 'parks' }, { id: 'admin' }],
      ...REQUIRED_ARCHIVE_METADATA,
    })
    expect(metadata).not.toHaveProperty('generator_options')
  })

  it('rejects an archive missing required license metadata', () => {
    expect(() => validateArchiveMetadata({
      ...REQUIRED_ARCHIVE_METADATA,
      license_url: undefined,
    }, 'source')).toThrow('source metadata license_url must equal')
  })
})