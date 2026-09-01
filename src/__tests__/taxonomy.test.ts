import { describe, it, expect } from 'vitest'
import { searchSpecies, findBestMatch, normalizeSpeciesName, speciesCount, getWikiTitle } from '../../functions/lib/taxonomy'

describe('taxonomy', () => {
  describe('speciesCount', () => {
    it('has a large number of species loaded', () => {
      expect(speciesCount).toBeGreaterThan(10000)
    })
  })

  describe('searchSpecies', () => {
    it('returns empty array for empty query', () => {
      expect(searchSpecies('')).toEqual([])
      expect(searchSpecies('   ')).toEqual([])
    })

    it('finds species by common name prefix', () => {
      const results = searchSpecies('Northern Card')
      expect(results.length).toBeGreaterThan(0)
      expect(results.some(r => r.common === 'Northern Cardinal')).toBe(true)
    })

    it('finds species by scientific name prefix', () => {
      const results = searchSpecies('Turdus')
      expect(results.length).toBeGreaterThan(0)
      expect(results.every(r => r.scientific.startsWith('Turdus'))).toBe(true)
    })

    it('finds species by substring match', () => {
      const results = searchSpecies('cardinal')
      expect(results.length).toBeGreaterThan(0)
      // "Northern Cardinal" contains "cardinal" as a substring
      expect(results.some(r => r.common.toLowerCase().includes('cardinal'))).toBe(true)
    })

    it('ranks prefix matches above substring matches', () => {
      const results = searchSpecies('bald')
      expect(results.length).toBeGreaterThan(0)
      // "Bald Eagle" starts with "Bald" so should be first
      expect(results[0].common).toBe('Bald Eagle')
    })

    it('respects the limit parameter', () => {
      const results = searchSpecies('robin', 3)
      expect(results.length).toBeLessThanOrEqual(3)
    })

    it('returns results with both common and scientific names', () => {
      const results = searchSpecies('Blue Jay')
      expect(results.length).toBeGreaterThan(0)
      const blueJay = results.find(r => r.common === 'Blue Jay')
      expect(blueJay).toBeDefined()
      expect(blueJay!.scientific).toBe('Cyanocitta cristata')
    })
  })

  describe('findBestMatch', () => {
    it('returns null for empty string', () => {
      expect(findBestMatch('')).toBeNull()
    })

    it('matches exact common name', () => {
      const match = findBestMatch('Northern Cardinal')
      expect(match).not.toBeNull()
      expect(match!.common).toBe('Northern Cardinal')
      expect(match!.scientific).toBe('Cardinalis cardinalis')
    })

    it('matches exact scientific name', () => {
      const match = findBestMatch('Haliaeetus leucocephalus')
      expect(match).not.toBeNull()
      expect(match!.common).toBe('Bald Eagle')
    })

    it('parses AI-style "Common Name (Scientific Name)" format', () => {
      const match = findBestMatch('Common Kingfisher (Alcedo atthis)')
      expect(match).not.toBeNull()
      expect(match!.common).toBe('Common Kingfisher')
    })

    it('prefers scientific name match in parenthesized format', () => {
      // Even if common name part is slightly off, scientific match wins
      const match = findBestMatch('Kingfisher (Alcedo atthis)')
      expect(match).not.toBeNull()
      expect(match!.common).toBe('Common Kingfisher')
    })

    it('is case-insensitive', () => {
      const match = findBestMatch('bald eagle')
      expect(match).not.toBeNull()
      expect(match!.common).toBe('Bald Eagle')
    })

    it('returns null for a completely made-up species', () => {
      const match = findBestMatch('Purple Sparkle Dragon')
      expect(match).toBeNull()
    })

    it('does not guess from word overlap', () => {
      expect(findBestMatch('American Robin bird')).toBeNull()
      expect(findBestMatch('Pink-headed Duck')).toBeNull()
    })

    it('rejects domestic species with only one word overlap', () => {
      // "Domestic Duck" has 2 words but only "duck" matches taxonomy entries.
      // The threshold requires at least 2 word matches to prevent false positives.
      expect(findBestMatch('Domestic Duck')).toBeNull()
      expect(findBestMatch('Domestic Chicken')).toBeNull()
      expect(findBestMatch('Pekin Duck')).toBeNull()
    })
  })

  describe('normalizeSpeciesName', () => {
    it('normalizes an AI-style name to canonical common name', () => {
      expect(normalizeSpeciesName('Common Kingfisher (Alcedo atthis)'))
        .toBe('Common Kingfisher')
    })

    it('returns the original name if no match is found', () => {
      expect(normalizeSpeciesName('totally fake bird'))
        .toBe('totally fake bird')
    })

    it('returns canonical name for exact matches', () => {
      expect(normalizeSpeciesName('Bald Eagle')).toBe('Bald Eagle')
    })
  })

  describe('getWikiTitle', () => {
    it('returns wiki title for a known species', () => {
      const title = getWikiTitle('Northern Cardinal')
      expect(title).toBe('Northern cardinal')
    })

    it('returns undefined for an unknown species', () => {
      expect(getWikiTitle('Purple Sparkle Dragon')).toBeUndefined()
    })

    it('is case-insensitive', () => {
      expect(getWikiTitle('bald eagle')).toBe(getWikiTitle('Bald Eagle'))
    })

    it('returns undefined for empty string', () => {
      expect(getWikiTitle('')).toBeUndefined()
    })
  })
})
