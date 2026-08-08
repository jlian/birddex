import { defineConfig } from '@playwright/test';

const isCI = !!process.env.CI;
const isARM = process.arch === 'arm64';
const serverPort = Number(process.env.PLAYWRIGHT_PORT || (isCI ? 5000 : 5012));
const baseURL = `http://localhost:${serverPort}`;

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
    baseURL,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  webServer: {
    // --ip 127.0.0.1 works around wrangler hanging in Docker (cloudflare/workers-sdk#6280)
    command: isCI
      ? `npx wrangler dev --port ${serverPort} --ip 127.0.0.1 --show-interactive-dev-session=false`
      : `PORT=${serverPort} FORCE_RESTART=true bash scripts/dev-full.sh`,
    url: baseURL,
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
