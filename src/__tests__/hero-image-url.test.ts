import { describe, it, expect } from 'vitest'
import { getHeroImageUrl } from '@/lib/wikimedia'

const PREFIX = 'https://upload.wikimedia.org/wikipedia/commons/'

describe('getHeroImageUrl', () => {
  it('rewrites the thumbnail width to the 960 step', () => {
    expect(getHeroImageUrl(`${PREFIX}thumb/e/e1/Somali_ostrich.jpg/330px-Somali_ostrich.jpg`))
      .toBe(`${PREFIX}thumb/e/e1/Somali_ostrich.jpg/960px-Somali_ostrich.jpg`)
  })

  it('preserves percent-encoded filenames', () => {
    const name = 'Struthio_camelus_-_Etosha_2014_%283%29.jpg'
    expect(getHeroImageUrl(`${PREFIX}thumb/9/9d/${name}/330px-${name}`))
      .toBe(`${PREFIX}thumb/9/9d/${name}/960px-${name}`)
  })

  // Multi-page sources (TIFF) carry a `lossy-pageN-` prefix ahead of the width.
  it('rewrites the width in multi-page renderings', () => {
    expect(getHeroImageUrl(`${PREFIX}thumb/6/65/Tinamotis_pentlandii.tif/lossy-page1-330px-Tinamotis_pentlandii.tif.jpg`))
      .toBe(`${PREFIX}thumb/6/65/Tinamotis_pentlandii.tif/lossy-page1-960px-Tinamotis_pentlandii.tif.jpg`)
  })

  it('returns undefined for originals served without a thumb segment', () => {
    expect(getHeroImageUrl(`${PREFIX}d/d8/Taoniscus.jpg`)).toBeUndefined()
  })

  it('returns undefined when there is no thumbnail', () => {
    expect(getHeroImageUrl(undefined)).toBeUndefined()
  })
})
