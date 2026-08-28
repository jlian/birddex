import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import {
  CONTRACT_KEYS,
  buildContract,
  contractPath,
  resolveFromContract,
  writeContract,
} from './place-contract'
import { kindOf, scoreOf } from './place-rank'

/**
 * The offline search build must include and rank exactly what the reverse
 * lookup does.
 *
 * `scripts/osm-places/place-contract.json` is generated from `place-rank.ts`
 * and consumed by the Python builder. A hand-written Python copy of these
 * rules had already drifted in review, so the contract is exported rather than
 * restated, and this test proves the export reproduces the real functions.
 *
 * The important test is the RANDOMISED multi-tag one. Hand-picked cases are
 * what let the first version pass while being wrong: single-tag probes all
 * agreed, and the disagreement only appeared for objects carrying several
 * tags, which is most real OSM features.
 */
const VALUES: Record<string, string[]> = {
  tourism: ['zoo', 'aquarium', 'attraction', 'viewpoint', 'hotel', 'museum', 'artwork', 'camp_site', 'gallery', 'theme_park'],
  leisure: ['park', 'garden', 'nature_reserve', 'golf_course', 'pitch', 'sports_centre'],
  natural: ['water', 'bay', 'beach', 'wetland', 'wood', 'scrub', 'grassland', 'fell', 'peak', 'coastline'],
  boundary: ['protected_area', 'national_park', 'administrative'],
  landuse: ['forest', 'recreation_ground', 'residential', 'farmland'],
  place: ['island', 'islet', 'city', 'town', 'village', 'hamlet', 'suburb', 'neighbourhood', 'farm', 'locality'],
}

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('place contract export', () => {
  it('has a committed artifact that is not stale', () => {
    expect(existsSync(contractPath())).toBe(true)
    const committed = JSON.parse(readFileSync(contractPath(), 'utf8'))
    expect(committed).toEqual(buildContract())
  })

  it('reproduces scoreOf and kindOf for every single-tag case', () => {
    const contract = buildContract()
    for (const key of CONTRACT_KEYS) {
      for (const value of VALUES[key] ?? []) {
        const tags = { [key]: value }
        const resolved = resolveFromContract(contract, tags)
        expect(`${key}=${value} score`).toBe(`${key}=${value} score`)
        expect(resolved.score).toBe(scoreOf(tags))
        if (resolved.score > 0) expect(resolved.kind).toBe(kindOf(tags))
      }
    }
  })

  it('reproduces scoreOf and kindOf for randomised MULTI-tag features', () => {
    const contract = buildContract()
    const random = mulberry32(20260828)
    const keys = Object.keys(VALUES)
    const mismatches: string[] = []
    for (let i = 0; i < 4000; i += 1) {
      const tags: Record<string, string> = {}
      const count = 1 + Math.floor(random() * 3)
      for (let j = 0; j < count; j += 1) {
        const key = keys[Math.floor(random() * keys.length)]
        const pool = VALUES[key]
        tags[key] = pool[Math.floor(random() * pool.length)]
      }
      const resolved = resolveFromContract(contract, tags)
      const expectedScore = scoreOf(tags)
      if (resolved.score !== expectedScore) {
        mismatches.push(`${JSON.stringify(tags)} score ${resolved.score} != ${expectedScore}`)
        continue
      }
      if (expectedScore > 0 && resolved.kind !== kindOf(tags)) {
        mismatches.push(`${JSON.stringify(tags)} kind ${resolved.kind} != ${kindOf(tags)}`)
      }
    }
    expect(mismatches.slice(0, 10)).toEqual([])
  })

  it('the PYTHON consumer resolves identically to the TypeScript', () => {
    // The artifact is only useful if the offline builder reads it the same way
    // the ranker computes it. This runs the REAL Python resolver over the same
    // randomised multi-tag features, rather than trusting that two
    // implementations of "first matching rule" agree.
    const random = mulberry32(20260829)
    const keys = Object.keys(VALUES)
    const cases: Array<Record<string, string>> = []
    for (let i = 0; i < 1500; i += 1) {
      const tags: Record<string, string> = {}
      const count = 1 + Math.floor(random() * 3)
      for (let j = 0; j < count; j += 1) {
        const key = keys[Math.floor(random() * keys.length)]
        const pool = VALUES[key]
        tags[key] = pool[Math.floor(random() * pool.length)]
      }
      cases.push(tags)
    }

    const script = `
import sys, json, importlib.util
spec = importlib.util.spec_from_file_location("m", "scripts/osm-places/build-search-records.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m._SCORE_RULES, m._KIND_RULES = m.load_contract()
cases = json.loads(sys.stdin.read())
print(json.dumps([{"score": m.score_of(c), "kind": m.kind_of(c)} for c in cases]))
`
    const output = execFileSync('python3', ['-c', script], {
      input: JSON.stringify(cases),
      encoding: 'utf8',
    })
    const fromPython = JSON.parse(output) as Array<{ score: number; kind: string }>

    const mismatches: string[] = []
    cases.forEach((tags, i) => {
      const expectedScore = scoreOf(tags)
      const expectedKind = expectedScore > 0 ? kindOf(tags) : fromPython[i].kind
      if (fromPython[i].score !== expectedScore || fromPython[i].kind !== expectedKind) {
        mismatches.push(
          `${JSON.stringify(tags)} python=${JSON.stringify(fromPython[i])} ts={score:${expectedScore},kind:${expectedKind}}`,
        )
      }
    })
    expect(mismatches.slice(0, 10)).toEqual([])
  })

  it('pins the multi-tag case the per-key export got wrong', () => {
    const contract = buildContract()
    // A hotel inside a park: the park branch precedes lodging, so the SCORE is
    // the park's 25 while the KIND is still 'lodging'. Score and kind resolve
    // from different tags, which a single-table export cannot represent.
    const tags = { tourism: 'hotel', leisure: 'park' }
    expect(scoreOf(tags)).toBe(25)
    expect(kindOf(tags)).toBe('lodging')
    expect(resolveFromContract(contract, tags)).toEqual({ score: 25, kind: 'lodging' })
  })

  it('covers open-ended fallbacks for values absent from the source', () => {
    const contract = buildContract()
    // `if (tourism) return 18` catches anything not named earlier, including
    // values that appear nowhere in place-rank.ts.
    expect(scoreOf({ tourism: 'artwork' })).toBe(18)
    expect(resolveFromContract(contract, { tourism: 'artwork' }).score).toBe(18)
    expect(resolveFromContract(contract, { natural: 'fell' }).score).toBe(scoreOf({ natural: 'fell' }))
  })

  it('excludes anything the contract scores zero', () => {
    const contract = buildContract()
    expect(contract.highway).toBeUndefined()
    expect(resolveFromContract(contract, { highway: 'residential' }).score).toBe(0)
  })
})

// Regenerate on demand: `UPDATE_CONTRACT=1 npx vitest run ... place-contract.test.ts`
if (process.env.UPDATE_CONTRACT) {
  writeContract()
}
