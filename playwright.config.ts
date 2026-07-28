import { defineConfig, devices } from '@playwright/test';

// Default target = local DDEV. Override with BASE_URL env var to run the same
// read-only suite against prod (or staging7 once it unlocks in Phase 2).
//
//   BASE_URL=https://darivreme.com npx playwright test
//
// All tests in this suite are read-only (GET only, no form submissions, no
// cart/checkout). Adding a write-test? It does NOT belong here — it goes in
// a tier-b/ subdirectory once we wire up DDEV-only execution.
const baseURL = process.env.BASE_URL || 'https://darivreme.ddev.site:33001';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    ignoreHTTPSErrors: true,
  },
  projects: [
    { name: 'desktop-chromium', testDir: './tests/e2e',  use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-pixel5',    testDir: './tests/e2e',  use: { ...devices['Pixel 5'] } },
    {
      name: 'lighthouse-chromium',
      testDir: './tests/perf',
      // One test runs all RUNS_PER_AUDIT iterations, and each may spend a few
      // seconds waiting out an SG-Security challenge before it can audit, so the
      // budget has to cover N audits plus N settles. 120s was enough for the
      // audits alone; it left no room for settling.
      timeout: 300_000,
      use: {
        ...devices['Desktop Chrome'],
        // Lighthouse attaches via the Chrome DevTools Protocol on this port.
        // Tests in tests/perf/ run serially (configured per-spec) to avoid
        // port conflicts.
        launchOptions: { args: ['--remote-debugging-port=9222'] },
      },
    },
  ],
});
