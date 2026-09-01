import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/release.yml'), 'utf8')

describe('release species identity rollout', () => {
  it('backfills the target database after migrations and before deployment', () => {
    const migrationStep = workflow.indexOf('- name: Apply D1 migrations')
    const backfillStep = workflow.indexOf('- name: Backfill species identities')
    const deployStep = workflow.indexOf('- name: Deploy to Cloudflare Workers')

    expect(migrationStep).toBeGreaterThan(-1)
    expect(backfillStep).toBeGreaterThan(migrationStep)
    expect(deployStep).toBeGreaterThan(backfillStep)

    const backfill = workflow.slice(backfillStep, deployStep)
    expect(backfill).toContain('export D1_REMOTE=1')
    expect(backfill).toMatch(
      /if \[ "\$\{\{ github\.ref_name \}\}" = "main" \]; then\s+export D1_DATABASE=wingdex-db\s+else\s+export D1_DATABASE=wingdex-db-dev\s+export D1_ENV=preview\s+fi/
    )

    const dump = backfill.indexOf('node scripts/backfill-species-code.mjs --dump-names')
    const plan = backfill.indexOf('npx vitest run --config vitest.plan.config.ts')
    const dryRun = backfill.indexOf('node scripts/backfill-species-code.mjs --strict 5')
    const apply = backfill.indexOf('node scripts/backfill-species-code.mjs --apply --strict 5')
    expect(dump).toBeGreaterThan(-1)
    expect(plan).toBeGreaterThan(dump)
    expect(dryRun).toBeGreaterThan(plan)
    expect(apply).toBeGreaterThan(dryRun)
  })
})
