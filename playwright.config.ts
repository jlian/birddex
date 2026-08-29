import { defineConfig } from '@playwright/test';
import { testBaseURL, testServerPort } from './e2e/test-server';

const isCI = !!process.env.CI;
const isARM = process.arch === 'arm64';
// Fork pull requests get no repository secrets, so there is no Cloudflare
// credential to authenticate a remote binding with. `env.PLACES` is
// `remote = true`, and wrangler refuses to start the remote proxy session
// without one, so the server never boots and the whole E2E step times out
// before a single test runs. Excluding the `@remote-r2` test alone cannot help,
// because the failure happens at server start. `--local` forces every binding
// local, which boots cleanly and keeps the rest of the suite meaningful on
// forks.
//
// Both values are required, not just the token: the token authenticates and the
// account id selects the account the remote bucket lives in. A half-configured
// environment cannot open the remote session either, so it takes the same local
// fallback. This matches the credential check in .github/workflows/ci.yml.
const hasCloudflareCredentials =
  !!process.env.CLOUDFLARE_API_TOKEN && !!process.env.CLOUDFLARE_ACCOUNT_ID;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  timeout: isCI ? 15_000 : isARM ? 30_000 : 10_000,
  retries: isCI ? 1 : 0,
  // ONE worker. Every spec shares a single local D1 database and the same dex,
  // and several seed or clear it, so parallel workers corrupt each other's
  // fixtures. The symptom was one test failing per run with the identity
  // rotating between files, which reads as flakiness but is a data race.
  // The suite is ~2 minutes serially, so the parallelism was not buying much.
  workers: 1,
  reporter: isCI ? 'line' : 'list',
  use: {
    baseURL: testBaseURL,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  webServer: {
    // --ip 127.0.0.1 works around wrangler hanging in Docker (cloudflare/workers-sdk#6280)
    //
    // `--env preview` is load-bearing on CI, not cosmetic. Without it the
    // server gets the TOP-LEVEL bindings, which include the production R2
    // bucket, and an R2 binding grants `put` and `delete` at runtime whatever
    // the TypeScript type says. Since this server runs pull-request code, that
    // is the same production-mutation risk the deployed preview avoids by
    // binding `wingdex-places-preview`. D1 stays local and disposable either
    // way, so the flag only changes which R2 bucket is reachable.
    //
    // `--local` is appended when the credentials are incomplete, see
    // hasCloudflareCredentials.
    command: isCI
      ? `npx wrangler dev --env preview${hasCloudflareCredentials ? '' : ' --local'} --port ${testServerPort} --ip 127.0.0.1 --show-interactive-dev-session=false`
      : `PORT=${testServerPort} FORCE_RESTART=true bash scripts/dev-full.sh`,
    url: testBaseURL,
    reuseExistingServer: false,
    // Local needs MORE than CI, not less. CI runs `wrangler dev` against a
    // prebuilt dist, but the local command is dev-full.sh, which rebuilds
    // before it serves. 20s was not enough for that on any machine here, so
    // `npm run check:all` failed at the webServer rather than at a test.
    timeout: isCI ? 45_000 : 180_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
