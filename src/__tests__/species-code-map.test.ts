import codeMap from '../../functions/lib/species-code-map.json'
import taxonomy from '@/lib/taxonomy.json'
import extra from '@/lib/taxonomy-extra.json'
import { describe, expect, it } from 'vitest'

type CodePair = [string, string]

describe('generated species code map', () => {
  it('matches classifier and sidecar names with classifier precedence', () => {
    const expected: Record<string, CodePair> = {}
    const add = (name: string, taxonCode: string, speciesCode: string) => {
      const key = name.trim().toLowerCase()
      if (key && !expected[key]) expected[key] = [taxonCode, speciesCode]
    }

    for (const [common, scientific, code] of taxonomy as unknown as string[][]) {
      if (!code) continue
      add(common, code, code)
      add(scientific, code, code)
    }
    for (const [code, common, scientific, , , reportAsCode] of extra.entries as string[][]) {
      add(common, code, reportAsCode || code)
      add(scientific, code, reportAsCode || code)
    }

    expect(codeMap).toEqual(Object.fromEntries(
      Object.entries(expected).sort(([a], [b]) => a.localeCompare(b)),
    ))
    expect(codeMap['mallard (domestic type)']).toEqual(['mallar2', 'mallar3'])
    expect(codeMap['mallard']).toEqual(['mallar3', 'mallar3'])
  })
})