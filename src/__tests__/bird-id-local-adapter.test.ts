import { describe, expect, it } from 'vitest'
import { mapIdentifyResults } from '@/lib/bird-id-local-adapter'

describe('local bird identification result mapping', () => {
  it('uses the same common-and-scientific species key as eBird imports', () => {
    expect(mapIdentifyResults([{
      commonName: 'Chukar',
      scientificName: 'Alectoris chukar',
      taxonIdx: 0,
      confidence: 0.98,
      logP: -1.2,
    }])).toEqual({
      candidates: [{
        species: 'Chukar (Alectoris chukar)',
        confidence: 0.98,
      }],
      rangeAdjusted: true,
    })
  })

  it('reports no range adjustment when every candidate lacks a prior', () => {
    expect(mapIdentifyResults([{
      commonName: 'Chukar',
      scientificName: 'Alectoris chukar',
      taxonIdx: 0,
      confidence: 0.98,
      logP: null,
    }]).rangeAdjusted).toBe(false)
  })
})