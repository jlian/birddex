import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/release.yml'), 'utf8')

describe('release species identity rollout', () => {
  it('deploys the compatible worker before migrating and backfilling the target database', () => {
    const migrationStep = workflow.indexOf('- name: Apply D1 migrations')
    const backfillStep = workflow.indexOf('- name: Backfill species identities')
    const deployStep = workflow.indexOf('- name: Deploy to Cloudflare Workers')

    expect(deployStep).toBeGreaterThan(-1)
    expect(migrationStep).toBeGreaterThan(-1)
    expect(migrationStep).toBeGreaterThan(deployStep)
    expect(backfillStep).toBeGreaterThan(migrationStep)

    const migration = workflow.slice(migrationStep, backfillStep)
    expect(migration).toMatch(
      /if \[ "\$\{\{ github\.ref_name \}\}" = "main" \]; then\s+npx wrangler d1 migrations apply wingdex-db --remote\s+else\s+npx wrangler d1 migrations apply wingdex-db-dev --remote --env preview\s+fi/
    )

    const backfill = workflow.slice(backfillStep, workflow.indexOf('- name: Purge production edge cache'))
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

  it('runs strict backfill only while the identity migrations are in the release range', () => {
    const deployCheck = workflow.slice(
      workflow.indexOf('- name: Check for deployable changes'),
      workflow.indexOf('- uses: actions/setup-node@v6')
    )
    expect(deployCheck.indexOf('BASE_SHA=$(gh api')).toBeLessThan(
      deployCheck.indexOf('elif [ "$EVENT_NAME" = "workflow_dispatch" ]')
    )
    expect(workflow).toContain('echo "should_backfill=true" >> "$GITHUB_OUTPUT"')
    expect(workflow).toContain('echo "should_backfill=false" >> "$GITHUB_OUTPUT"')
    expect(workflow).toContain(
      "if: steps.changes.outputs.should_deploy == 'true' && steps.changes.outputs.should_backfill == 'true'"
    )
    expect(workflow).toMatch(
      /grep -Eq '\^migrations\/001\(4_species_code\|5_taxon_code\|6_dex_meta_group_key\)\\\.sql\$'/
    )
  })
})
