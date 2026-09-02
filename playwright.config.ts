import { defineConfig } from '@playwright/test';
import { testBaseURL, testServerPort } from './e2e/test-server';

const isCI = !!process.env.CI;
const isARM = process.arch === 'arm64';
// Fork pull requests get no repository secrets, so there is no Cloudflare
// credential to authenticate a remote binding with. `env.PLACES` is
// `remote = true`, and wrangler refuses to start the remote proxy session
// without one, so the server never boots and the whole E2E step times out
// before a single test runs. Excluding the `@remote-r2` test alone cannot help,
// because the failure happens at server start. Disabling remote bindings keeps
// the rest of the suite meaningful on forks.
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
    // The preview environment is load-bearing on CI, not cosmetic. Without it the
    // server gets the TOP-LEVEL bindings, which include the production R2
    // bucket, and an R2 binding grants `put` and `delete` at runtime whatever
    // the TypeScript type says. Since this server runs pull-request code, that
    // is the same production-mutation risk the deployed preview avoids by
    // binding `wingdex-places-preview`. D1 stays local and disposable either
    // way, so the flag only changes which R2 bucket is reachable.
    //
    // Remote bindings are disabled when the credentials are incomplete, see
    // hasCloudflareCredentials.
    command: isCI
      ? `CLOUDFLARE_ENV=preview CLOUDFLARE_REMOTE_BINDINGS=${hasCloudflareCredentials ? 'true' : 'false'} VITE_SERVER_HOST=true VITE_PORT=${testServerPort} npm run dev`
      : `npm run db:migrate && VITE_PORT=${testServerPort} npm run dev`,
    url: `${testBaseURL}/api/health`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
