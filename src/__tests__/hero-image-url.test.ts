import { describe, it, expect } from 'vitest'
import { getHeroImageUrl, getFilePageUrl } from '@/lib/wikimedia'

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

describe('getFilePageUrl', () => {
  it('takes the file name from before the rendered width', () => {
    expect(getFilePageUrl(`${PREFIX}thumb/e/e1/Somali_ostrich.jpg/330px-Somali_ostrich.jpg`))
      .toBe('https://commons.wikimedia.org/wiki/File:Somali_ostrich.jpg')
  })

  it('takes the last segment for an original served without a thumb segment', () => {
    expect(getFilePageUrl(`${PREFIX}d/d8/Taoniscus.jpg`))
      .toBe('https://commons.wikimedia.org/wiki/File:Taoniscus.jpg')
  })

  it('keeps the source file name for a multi-page render', () => {
    expect(getFilePageUrl(`${PREFIX}thumb/6/65/Tinamotis_pentlandii.tif/lossy-page1-330px-Tinamotis_pentlandii.tif.jpg`))
      .toBe('https://commons.wikimedia.org/wiki/File:Tinamotis_pentlandii.tif')
  })

  it('points at English Wikipedia for files hosted there rather than Commons', () => {
    expect(getFilePageUrl('https://upload.wikimedia.org/wikipedia/en/thumb/8/80/Satyr.jpg/330px-Satyr.jpg'))
      .toBe('https://en.wikipedia.org/wiki/File:Satyr.jpg')
  })

  // The name comes out of a URL path, so it is already encoded. Encoding it again
  // turns %28 into %2528 and the API rejects the title.
  it('leaves an already percent-encoded name encoded exactly once', () => {
    expect(getFilePageUrl(`${PREFIX}thumb/8/89/Chalk-browed_mockingbird_%28Mimus_saturninus%29.jpg/330px-Chalk-browed_mockingbird_%28Mimus_saturninus%29.jpg`))
      .toBe('https://commons.wikimedia.org/wiki/File:Chalk-browed_mockingbird_%28Mimus_saturninus%29.jpg')
  })

  it('returns undefined for a missing or unrecognised URL', () => {
    expect(getFilePageUrl(undefined)).toBeUndefined()
    expect(getFilePageUrl('https://example.com/a/b/Foo.jpg')).toBeUndefined()
  })
})
