import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { foldQuery, ftsExpression } from './place-search'

/**
 * The folding in `place-search.ts` and in
 * `scripts/osm-places/build-search-records.py` must agree exactly.
 *
 * They are separate implementations in separate languages by necessity: one
 * folds the corpus offline, the other folds the query at request time. If they
 * drift, a query stops matching rows that plainly contain the words, and the
 * failure is SILENT: search just returns nothing.
 *
 * So this test does not assert the TypeScript against hand-written strings,
 * which would only prove it agrees with my expectations. It runs the real
 * Python and compares.
 */
const CASES = [
  'Discovery Park',
  'Doñana',
  'Saint-Louis',
  'Straße',
  'ÎLE-DE-FRANCE',
  "Martha's Vineyard",
  'Union   Bay',
  '  leading and trailing  ',
  'Tōkyō',
  '東京',
  'Καλαμάτα',
  'Ålesund',
  'İstanbul',
  'co-operative reserve',
  'St. Martin',
  'a/b\\c',
  'Ærø',
  'Škocjan',
  'Đà Nẵng',
  '3 Mile Creek',
  // Characters where Python `casefold` and `str.lower` DISAGREE. These are
  // the exact inputs that caught the original drift, so they stay pinned.
  'Ὁδυσσεύς',
  'ᎠᎡᎢ',
  'ẞ',
  'ſharp',
  'µ-reserve',
]

function pythonFold(values: string[]): string[] {
  const script = `
import sys, json, importlib.util
spec = importlib.util.spec_from_file_location("m", "scripts/osm-places/build-search-records.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
print(json.dumps([m.fold(v) for v in json.loads(sys.stdin.read())]))
`
  const out = execFileSync('python3', ['-c', script], {
    input: JSON.stringify(values),
    encoding: 'utf8',
  })
  return JSON.parse(out) as string[]
}

describe('query folding matches the offline builder', () => {
  it('agrees with the Python implementation on every case', () => {
    const expected = pythonFold(CASES)
    const actual = CASES.map(foldQuery)
    // Compare as a table so a failure names the input that drifted.
    expect(CASES.map((c, i) => `${c} -> ${actual[i]}`))
      .toEqual(CASES.map((c, i) => `${c} -> ${expected[i]}`))
  })

  it('folds the German sharp s the same way the builder does', () => {
    // Not 'strasse': the builder uses str.lower, which JavaScript can match.
    expect(foldQuery('Straße')).toBe('straße')
  })

  it('strips diacritics so an ASCII query finds an accented name', () => {
    expect(foldQuery('Doñana')).toBe('donana')
  })

  it('treats punctuation as a separator rather than deleting it', () => {
    expect(foldQuery('Saint-Louis')).toBe('saint louis')
  })

  it('keeps non-Latin scripts intact', () => {
    expect(foldQuery('東京')).toBe('東京')
  })

  it('strips combining marks outside the Latin block', () => {
    // Hebrew niqqud are combining marks. An earlier version stripped only
    // U+0300-U+036F, so these survived, were treated as punctuation, and split
    // one word into three tokens that the index could never match.
    expect(foldQuery('שָׁלוֹם')).toBe('שלום')
  })
})

describe('FTS expression building', () => {
  it('puts a prefix star on EVERY token', () => {
    // #343 requires token-prefix matching. Starring only the last token looked
    // like a cheap win but broke the requirement: `discover par` found nothing,
    // because `discover` is not a token in `discovery park`. The bounded
    // candidate stage is what pays for full prefix matching.
    expect(ftsExpression('discovery park')).toBe('"discovery"* "park"*')
    expect(ftsExpression('discover par')).toBe('"discover"* "par"*')
    expect(ftsExpression('tokyo')).toBe('"tokyo"*')
  })

  it('neutralises FTS5 operators a user might type', () => {
    // Unquoted, `OR` and `NOT` are operators and would silently change the
    // query's meaning. Folding removes the star, and quoting makes the
    // remaining words literal.
    expect(ftsExpression(foldQuery('park OR NOT lake'))).toBe('"park"* "or"* "not"* "lake"*')
    expect(ftsExpression(foldQuery('park*'))).toBe('"park"*')
    expect(ftsExpression(foldQuery('^park'))).toBe('"park"*')
  })

  it('escapes an embedded double quote by doubling it', () => {
    expect(ftsExpression('a"b')).toBe('"a""b"*')
  })

  it('produces an empty expression for empty input', () => {
    expect(ftsExpression('')).toBe('')
  })
})
