import { test } from '@playwright/test';
import { playAudit } from 'playwright-lighthouse';

// Lighthouse audit against a configurable URL + form-factor + N runs.
//
// Env vars (all optional, with defaults preserving the original homepage-only
// invocation):
//   URL_PATH         path relative to baseURL, default "/"
//   PAGE_SLUG        short slug used in artifact filenames, default "homepage"
//   FORM_FACTOR      mobile|desktop, default mobile
//   RUNS_PER_AUDIT   integer N, default 1 (CI sets 5 for statistical power)
//
// Artifact naming: lighthouse-${PAGE_SLUG}-${target}-${FORM_FACTOR}-run${n}.{json,html}
// When N=1 the suffix is "-run1" — keeps a single naming convention.
//
// History: until 2026-05-13 this spec ran mobile only (formFactor default).
// 2026-05-13 added explicit form factor + matrix in perf-prod.yml.
// 2026-05-21 added URL_PATH + PAGE_SLUG + RUNS_PER_AUDIT for the
// statistical-power + multi-page upgrade. Threshold gating moved out of the
// spec into the aggregator: a flaky run 1 must NOT prevent runs 2..N from
// capturing data; the aggregator decides pass/fail from the median.
// See docs/performance-status.md "Measurement upgrade — 2026-05-21".

// Lighthouse uses the CDP debug port (9222); only one audit at a time.
test.describe.configure({ mode: 'serial' });

type FormFactor = 'mobile' | 'desktop';
const FORM_FACTOR: FormFactor =
  (process.env.FORM_FACTOR === 'desktop' ? 'desktop' : 'mobile');

const URL_PATH = process.env.URL_PATH || '/';
const PAGE_SLUG = process.env.PAGE_SLUG || 'homepage';
const RUNS_PER_AUDIT = Math.max(1, parseInt(process.env.RUNS_PER_AUDIT || '1', 10));

// Thresholds live in the aggregator (perf-prod.yml) and apply to the
// MEDIAN across all N runs, not any single run. Spec captures data
// unconditionally so a flaky sample doesn't lose us the other N-1 runs.
//
// CAVEAT: playwright-lighthouse derives `onlyCategories` from
// Object.keys(thresholds). Passing `{}` produces "onlyCategories cannot
// be an empty array". Workaround: set all four to a floor of 0 — every
// category gets audited, nothing fails inside the spec, aggregator
// decides pass/fail from medians.
const FLOOR_THRESHOLDS = { performance: 0, accessibility: 0, 'best-practices': 0, seo: 0 };

const CHALLENGE_RX = /\/\.well-known\/sgcaptcha\//;
// Kept deliberately tight. All N iterations share one Playwright test timeout,
// so a generous settle budget on a fully-blocked cell would blow that timeout —
// turning a run the aggregator would have cleanly rejected into a hard job
// failure. In practice the challenge resolves in a few seconds.
const SETTLE_ATTEMPTS = 2;
const SETTLE_TIMEOUT_MS = 10_000;

// SG-Security gates runner IPs it distrusts with a JS challenge at
// /.well-known/sgcaptcha/. Chromium solves it unattended, but it has to be
// fully settled BEFORE Lighthouse starts, for two distinct reasons:
//
//   * playwright-lighthouse derives the audit URL from page.url(), so a page
//     left parked on the challenge makes Lighthouse audit the challenge itself
//     — perf null, all metrics null. That is how an audit of the challenge page
//     came to be published as latest-prod-mobile.html (2026-07-27).
//   * a challenge navigation landing mid-audit destroys the JS context the
//     audit is evaluating in ("Execution context was destroyed, most likely
//     because of a navigation"), which killed every iteration of shop/desktop.
//
// On an unchallenged run this is exactly one page.goto — identical to what the
// spec did before — so measured values stay comparable with existing history.
async function settleOnRealPage(page: import('@playwright/test').Page, url: string) {
  for (let attempt = 1; attempt <= SETTLE_ATTEMPTS; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'load' });
    } catch (err) {
      // A challenge redirect firing mid-navigation aborts the goto. Expected;
      // the retry below covers it.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[lighthouse] settle attempt ${attempt}: goto aborted (${msg})`);
    }

    if (!CHALLENGE_RX.test(page.url())) return true;

    // The challenge navigates itself to the real page once its proof-of-work
    // is accepted. Wait that out rather than auditing the challenge.
    console.warn(`[lighthouse] settle attempt ${attempt}: on SG challenge, waiting for it to clear`);
    await page
      .waitForURL(u => !CHALLENGE_RX.test(u.toString()), { timeout: SETTLE_TIMEOUT_MS })
      .catch(() => {});

    if (!CHALLENGE_RX.test(page.url())) return true;
  }

  console.warn(`[lighthouse] still on SG challenge after ${SETTLE_ATTEMPTS} attempts — auditing anyway; the aggregator will reject it`);
  return false;
}

// Lighthouse settings per form factor. Numbers come from Lighthouse's own
// desktop preset (lighthouse-core/config/constants.js) — keeping them in
// sync means our CI matches what users see when they pick "Desktop" in the
// DevTools Lighthouse panel.
const formFactorOpts = {
  mobile: {
    formFactor: 'mobile',
    screenEmulation: { mobile: true,  width: 412,  height: 823, deviceScaleFactor: 1.75, disabled: false },
    throttling: { rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier: 4, requestLatencyMs: 562.5, downloadThroughputKbps: 1474.56, uploadThroughputKbps: 675 },
    throttlingMethod: 'simulate',
  },
  desktop: {
    formFactor: 'desktop',
    screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
    throttling: { rttMs: 40, throughputKbps: 10240, cpuSlowdownMultiplier: 1, requestLatencyMs: 0, downloadThroughputKbps: 0, uploadThroughputKbps: 0 },
    throttlingMethod: 'simulate',
  },
} as const;

test(`X1: ${PAGE_SLUG} Lighthouse ×${RUNS_PER_AUDIT} (${FORM_FACTOR})`, async ({ page, baseURL }) => {
  const target =
    baseURL?.includes('ddev.site') ? 'local' :
    baseURL?.includes('staging7') ? 'staging' :
    'prod';

  const lhOpts = formFactorOpts[FORM_FACTOR];

  // Absolute URL pinned once, and passed to playAudit explicitly below so the
  // audited URL can never drift to wherever the page happened to end up.
  const targetUrl = new URL(URL_PATH, baseURL).href;

  // Initial goto warms caches and ensures the page is reachable.
  await settleOnRealPage(page, targetUrl);

  let successCount = 0;
  const errors: string[] = [];

  for (let n = 1; n <= RUNS_PER_AUDIT; n++) {
    try {
      if (n > 1) {
        // Clear the browser cache via CDP so every iteration is cold-cache.
        // Without this, runs 2..N hit Playwright context's warm cache and
        // report ~40 KB transfer + LCP 1.3s, inflating medians. Run 1 is
        // the only realistic-first-visit sample without this.
        //
        // Cookies are cleared too, which does re-arm the SG-Security challenge
        // for every iteration — settleOnRealPage() below absorbs it. Keeping
        // the challenge cookie instead would carry a WooCommerce session cookie
        // across iterations, and WP/SG page caches bypass on those, so runs
        // 2..N would measure cache-bypassed and score lower. Re-solving the
        // challenge is the cheaper trade than losing comparability with history.
        const client = await page.context().newCDPSession(page);
        await client.send('Network.clearBrowserCache');
        await client.send('Network.clearBrowserCookies');
        await client.detach();
        await settleOnRealPage(page, targetUrl);
      }

      await playAudit({
        page,
        // Explicit — otherwise playwright-lighthouse falls back to page.url(),
        // which is the challenge URL whenever settling failed.
        url: targetUrl,
        // Floor thresholds = audit every category, never fail in the spec.
        // Aggregator decides pass/fail from the median over N runs.
        thresholds: FLOOR_THRESHOLDS,
        port: 9222,
        opts: {
          logLevel: 'error',
          ...lhOpts,
        },
        reports: {
          // HTML for humans, JSON for the extractor (perf-extract-history.js).
          // Filename includes slug + factor + run index so all artifacts
          // coexist for the aggregator to pick up.
          formats: { html: true, json: true },
          name: `lighthouse-${PAGE_SLUG}-${target}-${FORM_FACTOR}-run${n}`,
          directory: 'lighthouse-reports',
        },
      });
      successCount++;
    } catch (err) {
      // ConnectionClosedError / ProtocolError can happen mid-iteration
      // when Chrome's CDP connection drops. Don't lose the other runs.
      // Log and continue so the aggregator can compute median from what
      // we DID capture.
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      errors.push(`run${n}: ${msg}`);
      console.warn(`[lighthouse] iteration ${n} of ${RUNS_PER_AUDIT} failed: ${msg}`);
    }
  }

  // Only fail the test if NOTHING succeeded — i.e. we have no data to
  // publish. Partial success (e.g. 4 of 5 audits captured) is still
  // useful and the aggregator picks up whatever lhr.json files exist.
  if (successCount === 0) {
    throw new Error(
      `All ${RUNS_PER_AUDIT} Lighthouse iterations failed for ${PAGE_SLUG}/${FORM_FACTOR}:\n` +
      errors.join('\n')
    );
  }
  if (errors.length > 0) {
    console.warn(`[lighthouse] ${PAGE_SLUG}/${FORM_FACTOR}: ${successCount}/${RUNS_PER_AUDIT} iterations succeeded; ${errors.length} flaked`);
  }
});
