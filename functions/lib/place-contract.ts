/**
 * Emit the birding-place contract as JSON, read FROM the live implementation.
 *
 * `scoreOf()` and `kindOf()` in `place-rank.ts` decide what counts as a birding
 * place. The offline Python build needs the SAME answer, and a hand-written
 * copy of the rules had already drifted when review caught it, so the contract
 * is exported rather than restated.
 *
 * The export is an ORDERED RULE LIST, not a lookup table, because two
 * properties of `scoreOf()` defeat a table:
 *
 * 1. Precedence is interleaved across keys. The if-chain tests attraction,
 *    then leisure, then water, then landuse, so a key's priority depends on
 *    its value: `{tourism:'hotel', leisure:'park'}` scores 25 from the park
 *    branch, while `{tourism:'zoo', leisure:'park'}` scores 26 from the zoo
 *    branch. No fixed key order reproduces both.
 *
 * 2. Score and kind can come from DIFFERENT tags. For that hotel in a park,
 *    `scoreOf` returns 25 (park) but `kindOf` returns 'lodging'. They are
 *    separate chains, so they get separate rule lists.
 *
 * Emitting the chain in order, one rule per branch, means the consumer walks it
 * and takes the first match. That is what the TypeScript does, so it cannot
 * disagree by construction. An earlier attempt INFERRED each value's priority
 * by probing combinations, which was clever and wrong: the randomised parity
 * test found cases it mis-ordered within a few thousand samples.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { kindOf, scoreOf } from './place-rank'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')

export const CONTRACT_KEYS = ['tourism', 'leisure', 'natural', 'boundary', 'landuse', 'place'] as const

export const WILDCARD = '*'

/**
 * One branch of the real if-chain: "if this key holds one of these values,
 * the answer is this". `values` containing `*` means the branch matches any
 * value for that key, which is how `if (tourism) return 18` is represented.
 */
export interface ContractRule {
  key: string
  values: string[]
  score?: number
  kind?: string
}

export interface PlaceContract {
  scoreRules: ContractRule[]
  kindRules: ContractRule[]
}

/**
 * Recover the chain by READING it, then prove the reading against the
 * functions.
 *
 * Two cleverer approaches failed first, and both failed the same way: they
 * inferred each branch's position by probing combinations, and the randomised
 * parity test found orderings they got wrong. Inference cannot see a branch
 * that no probe happens to expose, so "no counter-example found" was being
 * mistaken for "correct".
 *
 * The if-chain is right there in the source, in order. Parsing it is simple
 * and total, and the parity test then verifies the parse against the live
 * functions over thousands of random multi-tag features, so a mis-parse cannot
 * pass silently.
 */
function parseChain(
  functionName: string,
  literal: RegExp,
): Array<{ key: string; values: string[]; answer: string }> {
  const source = readFileSync(resolve(here, 'place-rank.ts'), 'utf8')
  const start = source.indexOf(`export function ${functionName}`)
  if (start < 0) throw new Error(`cannot find ${functionName} in place-rank.ts`)
  const end = source.indexOf('\nexport ', start + 1)
  const body = source.slice(start, end < 0 ? undefined : end)

  // Resolve the named Sets once, so a branch guarded by `SET.has(x)` expands
  // to its members rather than staying an opaque reference.
  const sets = new Map<string, string[]>()
  for (const match of source.matchAll(/const (\w+) = new Set\(\[([\s\S]*?)\]\)/g)) {
    sets.set(match[1], [...match[2].matchAll(/'([^']+)'/g)].map((m) => m[1]))
  }

  const rules: Array<{ key: string; values: string[]; answer: string }> = []
  // Join the body into single logical branches first. `kindOf` wraps two of
  // its conditions across lines to satisfy the formatter, and a line-by-line
  // parse silently skipped both: `boundary=protected_area` produced no `kind`
  // at all, and the multi-set `place` branch lost its `admin` answer. Skipping
  // a branch is invisible in single-tag probes, which is why the randomised
  // multi-tag test is the one that caught it.
  const flattened = body
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s*\{\s*/g, ' { ')
    .split(/(?=if \()/)
  for (const line of flattened) {
    const branch = line.match(/if \((.*)\) \{?\s*return (.+?)$/)
    if (!branch) continue
    const [, condition, rawAnswer] = branch
    const answer = (rawAnswer.match(literal) ?? [])[1]
    if (answer === undefined) continue

    // Which tag key does this branch test?
    const key = CONTRACT_KEYS.find(
      (candidate) => condition.includes(candidate) || condition.includes(`props.${candidate}`),
    )
    if (!key) continue

    const values: string[] = []
    for (const set of condition.matchAll(/(\w+)\.has\(/g)) {
      const members = sets.get(set[1])
      if (members) values.push(...members)
    }
    for (const eq of condition.matchAll(/=== '([^']+)'/g)) values.push(eq[1])
    // A bare `if (tourism)` with no comparison is the open-ended fallback.
    rules.push({ key, values: values.length ? values : [WILDCARD], answer })
  }
  return rules
}

export function buildContract(): PlaceContract {
  const scoreRules = parseChain('scoreOf', /^(\d+)/).map((rule) => ({
    key: rule.key,
    values: rule.values,
    score: Number(rule.answer),
  }))
  const kindRules = parseChain('kindOf', /^'([^']+)'/).map((rule) => ({
    key: rule.key,
    values: rule.values,
    kind: rule.answer,
  }))
  return { scoreRules, kindRules }
}

export function contractPath(): string {
  return resolve(repoRoot, 'scripts/osm-places/place-contract.json')
}

export function writeContract(): PlaceContract {
  const contract = buildContract()
  const path = contractPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(contract, null, 2)}\n`)
  return contract
}

function matches(rule: ContractRule, tags: Record<string, string>): boolean {
  const value = tags[rule.key]
  if (value === undefined) return false
  return rule.values.includes(WILDCARD) || rule.values.includes(value)
}

/**
 * Resolve a feature from the exported rules: first matching rule wins.
 *
 * This is the reference implementation of what the Python builder does, kept
 * here so the parity test drives both from one place.
 */
export function resolveFromContract(
  contract: PlaceContract,
  tags: Record<string, string>,
): { score: number; kind: string } {
  const scoreRule = contract.scoreRules.find((rule) => matches(rule, tags))
  const kindRule = contract.kindRules.find((rule) => matches(rule, tags))
  return { score: scoreRule?.score ?? 0, kind: kindRule?.kind ?? 'other' }
}
