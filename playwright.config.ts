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

// Stop this harness from registering in GA4. It audits PROD on a schedule and
// executes page JS, so gtag fires and GA4 logs every run as a zero-engagement
// "new user" — Lighthouse launches a fresh profile per run, so there is no
// cookie to reuse and each one is counted as a distinct person.
//
// Map ONLY the GA *collection* hosts to 127.0.0.1. gtag.js still loads from
// googletagmanager.com, so page weight and the perf score are unchanged and
// the historical trend stays comparable — blocking googletagmanager instead
// would silently improve our own scores and break the timeline. GA4 sends via
// navigator.sendBeacon, which fails silently on a refused connection, so no
// console error and no Best-Practices regression.
//
// Applied at the browser-launch layer so it also covers Lighthouse's own
// CDP-driven navigation, which a page.route() handler would NOT intercept.
//
// Ported 2026-08-06 from darivreme-monorepo (its PR #3), which could not reach
// this harness: the monorepo fix predates the 2026-07-13 move of perf-prod.yml
// into this repo, so the scheduled prod audits kept reporting to GA4 for weeks
// after the "fix" existed. Measured over Jul 30 - Aug 5: GA4 showed 7,403
// views against 2,213 prod actually served to a JS-capable client.
const BLOCK_GA_ARGS = [
  '--host-resolver-rules=' + [
    'MAP google-analytics.com 127.0.0.1',
    'MAP *.google-analytics.com 127.0.0.1',
    'MAP analytics.google.com 127.0.0.1',
    // stats.g.doubleclick.net is GA4's Google Signals collector, so it belongs
    // here. Do NOT widen this back to *.g.doubleclick.net: that also catches
    // googleads.g.doubleclick.net/pagead/id, which the embedded YouTube player
    // requests. That one is a normal resource load, not a sendBeacon, so
    // refusing it logs ERR_CONNECTION_REFUSED to the console — which would ding
    // Lighthouse's errors-in-console Best-Practices audit on any audited page
    // carrying a video, showing up in the published trend as a regression that
    // is really our own measurement artefact. It is also not our traffic being
    // measured. Caught 2026-08-06 in darivreme-monorepo, where the wildcard
    // broke 5 clean-page tests; #4's homepage-only validation missed it.
    'MAP stats.g.doubleclick.net 127.0.0.1',
  ].join(','),
];

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
    // Inherited by desktop-chromium + mobile-pixel5 (they set no launchOptions).
    launchOptions: { args: BLOCK_GA_ARGS },
  },
  projects: [
    { name: 'desktop-chromium', testDir: './tests/e2e',  use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-pixel5',    testDir: './tests/e2e',  use: { ...devices['Pixel 5'] } },
    {
      name: 'lighthouse-chromium',
      testDir: './tests/perf',
      // Lighthouse run + cleanup typically takes 30–60s on a CI runner
      // (slower network than local). Default 30s test timeout is too tight.
      timeout: 120_000,
      use: {
        ...devices['Desktop Chrome'],
        // Lighthouse attaches via the Chrome DevTools Protocol on this port.
        // Tests in tests/perf/ run serially (configured per-spec) to avoid
        // port conflicts. Per-project launchOptions REPLACES the top-level one,
        // so the GA-block args are repeated here explicitly — this is the
        // project the scheduled prod audit actually runs.
        launchOptions: { args: ['--remote-debugging-port=9222', ...BLOCK_GA_ARGS] },
      },
    },
  ],
});
