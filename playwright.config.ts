import { defineConfig } from '@playwright/test';

const isCI = !!process.env.CI;
const isARM = process.arch === 'arm64';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  timeout: isCI ? 15_000 : isARM ? 30_000 : 10_000,
  retries: isCI ? 1 : 0,
  workers: isCI ? 2 : 4,
  reporter: isCI ? 'line' : 'list',
  use: {
    baseURL: 'http://localhost:5000',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  webServer: {
    // --ip 127.0.0.1 works around wrangler hanging in Docker (cloudflare/workers-sdk#6280)
    command: isCI
      ? 'npx wrangler dev --port 5000 --ip 127.0.0.1 --show-interactive-dev-session=false'
      : 'FORCE_RESTART=true bash scripts/dev-full.sh',
    url: 'http://localhost:5000',
    reuseExistingServer: !isCI,
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
