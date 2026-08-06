import { test, expect } from '@playwright/test';

// Guards the --host-resolver-rules GA block in playwright.config.ts
// (BLOCK_GA_ARGS). This harness audits PROD on a schedule, so without the
// block every run registers in GA4 as a brand-new user.
//
// Why this probes the HOSTS directly rather than loading a page and counting
// beacons: a page-based check passes vacuously anywhere the site emits no tag,
// which makes an inert guard indistinguishable from a working one. Resolving
// the hosts is a property of the browser's launch args, so it holds in any
// environment and needs no cooperation from the site under test.
//
// BOTH directions matter:
//   1. a GA collection host must be unreachable  -> the block is on
//   2. googletagmanager.com must still load      -> we did NOT over-block
// (2) is not a nicety. gtag.js is real page weight; widening the block to
// cover googletagmanager would quietly improve our own Lighthouse scores and
// break every comparison against the published trend.
//
// Negative-tested 2026-08-06 by neutralising the flag: both projects went red
// on (1) while (2) stayed green.

const COLLECT_URL = 'https://region1.google-analytics.com/g/collect?v=2&tid=G-TEST';
const TAG_URL = 'https://www.googletagmanager.com/gtag/js?id=GT-TWR24463';

test.describe('GA4 block', () => {
  test('GA collection hosts are unreachable', async ({ page }) => {
    await page.goto('about:blank');
    const result = await page.evaluate(async (url) => {
      try {
        await fetch(url, { method: 'GET', mode: 'no-cors', cache: 'no-store' });
        return 'reachable';
      } catch {
        return 'refused';
      }
    }, COLLECT_URL);

    expect(
      result,
      `GA collection host is reachable — the --host-resolver-rules block is NOT in ` +
        `force. Every scheduled prod audit is registering in GA4. Check launchOptions ` +
        `in playwright.config.ts; per-project launchOptions REPLACES the top-level one.`,
    ).toBe('refused');
  });

  test('googletagmanager.com still loads (perf scores stay comparable)', async ({ page }) => {
    await page.goto('about:blank');
    const status = await page.evaluate(async (url) => {
      try {
        const r = await fetch(url, { cache: 'no-store' });
        return r.status;
      } catch {
        return 0;
      }
    }, TAG_URL);

    expect(
      status,
      `googletagmanager.com did not load. The block must cover GA *collection* hosts ` +
        `only — blocking the tag itself removes real page weight and silently inflates ` +
        `the perf scores this repo publishes.`,
    ).toBe(200);
  });
});
