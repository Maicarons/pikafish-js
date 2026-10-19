import { defineConfig, devices } from '@playwright/test';

// Two servers, because the deployment matrix is the point:
//   4311 - sends COOP/COEP, like Vercel and `vite preview`
//   4312 - sends nothing, like GitHub Pages (coi-serviceworker has to step in)
const ISOLATED_PORT = Number(process.env.E2E_ISOLATED_PORT ?? 4311);
const PLAIN_PORT = Number(process.env.E2E_PLAIN_PORT ?? 4312);
const DIST = 'apps/demo/dist';

export default defineConfig({
  testDir: './e2e',
  // Every page downloads and hashes the 48 MB weights, so parallel workers would
  // only make the timings noisy.
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  // The stress run is a long, manual/nightly job (`npm run test:stress`).
  grepInvert: /@stress/,
  use: {
    baseURL: `http://127.0.0.1:${ISOLATED_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Firefox and WebKit run the smoke set: three builds load and search, the
      // Pages path works, and the no-isolation path fails loudly. The full suite
      // only needs to run once to catch regressions.
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      grep: /@smoke/,
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      grep: /@smoke/,
    },
  ],
  webServer: [
    {
      command: `node scripts/serve-static.mjs --root ${DIST} --port ${ISOLATED_PORT} --silent`,
      url: `http://127.0.0.1:${ISOLATED_PORT}/index.html`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node scripts/serve-static.mjs --root ${DIST} --port ${PLAIN_PORT} --isolation=off --silent`,
      url: `http://127.0.0.1:${PLAIN_PORT}/index.html`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
