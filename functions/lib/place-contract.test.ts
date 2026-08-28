import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { buildContract, contractPath, writeContract } from './place-contract'
import { kindOf, scoreOf } from './place-rank'

/**
 * The offline search build must include and rank exactly what the reverse
 * lookup does.
 *
 * `scripts/osm-places/place-contract.json` is generated from `place-rank.ts`
 * and consumed by the Python builder. This test regenerates it and fails if
 * the committed copy is stale, so a change to `scoreOf()` or `kindOf()` cannot
 * silently leave the next corpus built on the previous rules.
 *
 * This exists because a hand-written Python copy of these rules had already
 * drifted: it scored `museum` at 26 instead of 19 and `city` at 20 instead of
 * 14, so the corpus contained the wrong rows at the wrong ranks while claiming
 * to implement the shared contract.
 */
describe('place contract export', () => {
  it('has a committed artifact', () => {
    expect(existsSync(contractPath())).toBe(true)
  })

  it('matches the live scoreOf and kindOf', () => {
    const committed = JSON.parse(readFileSync(contractPath(), 'utf8'))
    expect(committed).toEqual(buildContract())
  })

  it('captures the values that the drifted copy got wrong', () => {
    const contract = buildContract()
    // Regression pins. Each of these was WRONG in the hand-written copy.
    expect(contract.score.tourism.museum).toBe(19)
    expect(contract.kind.tourism.museum).toBe('landmark')
    expect(contract.score.place.city).toBe(14)
    expect(contract.score.tourism.zoo).toBe(26)
    expect(contract.score.leisure.park).toBe(25)
    expect(contract.score.natural.water).toBe(24)
  })

  it('agrees with the functions for every exported entry', () => {
    const contract = buildContract()
    for (const [key, values] of Object.entries(contract.score)) {
      for (const [value, expected] of Object.entries(values)) {
        expect(scoreOf({ [key]: value })).toBe(expected)
        expect(kindOf({ [key]: value })).toBe(contract.kind[key][value])
      }
    }
  })

  it('excludes anything the contract scores zero', () => {
    const contract = buildContract()
    // Streets and addresses must never be searchable.
    expect(contract.score.highway).toBeUndefined()
    for (const [key, values] of Object.entries(contract.score)) {
      for (const value of Object.keys(values)) {
        expect(scoreOf({ [key]: value })).toBeGreaterThan(0)
      }
    }
  })
})

// Regenerate on demand rather than only asserting, so the artifact is easy to
// refresh: `UPDATE_CONTRACT=1 npx vitest run ... place-contract.test.ts`.
if (process.env.UPDATE_CONTRACT) {
  writeContract()
}
