#!/usr/bin/env node
/*
 * verify-published-reports.js — assert the published latest-prod-*.html reports
 * are genuine audits of the site, and are not silently going stale.
 *
 * Guards two distinct failure modes:
 *
 * 1. WRONG PAGE. SG-Security serves a JS challenge at /.well-known/sgcaptcha/ to
 *    runner IPs it distrusts. A report of that challenge page scores plausibly
 *    (a11y 87 / bp 100 / seo 92 under Lighthouse 12.8.2) so it does not look
 *    broken — both public reports served challenge-page audits for a week in
 *    July 2026 before anyone noticed.
 *
 * 2. STALE. The publish gate added 2026-07-28 deliberately publishes NOTHING
 *    when no run in a cell is usable, leaving the previous good report in place.
 *    That is the right call, but it means a report can quietly age for weeks
 *    while still looking perfectly valid. This is a failure mode the gate
 *    itself introduced, which is exactly why it needs its own assertion.
 *
 * Usage:
 *   node scripts/verify-published-reports.js [--max-age-days N] [file ...]
 *
 * With no files, fetches the two published prod reports from gh-pages raw
 * (deliberately raw.githubusercontent.com, not the Pages URL — the Pages CDN
 * serves stale content for minutes after a deploy and would mask a real
 * regression, or fake one).
 *
 * Exit 0 = all good. Exit 1 = at least one report is invalid or stale.
 */
'use strict';

const fs = require('fs');

const RAW_BASE = 'https://raw.githubusercontent.com/leni-kirilov/darivreme-perf/gh-pages';
const DEFAULT_TARGETS = ['latest-prod-mobile.html', 'latest-prod-desktop.html'];

const CAPTCHA_URL_RX = /\/\.well-known\/sgcaptcha\//;
// Filename only, deliberately not tied to the CDN host it currently ships from —
// anchoring to a vendor hostname is what made detection silently inert once.
const CHALLENGE_ASSET_RX = /robot-suspicion\.svg/;

function parseArgs(argv) {
    const out = { maxAgeDays: 10, files: [] };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--max-age-days') out.maxAgeDays = Number(argv[++i]);
        else out.files.push(argv[i]);
    }
    return out;
}

// The report embeds its lhr as `window.__LIGHTHOUSE_JSON__ = {...}` followed by
// more script, so the object must be sliced out before JSON.parse.
//
// Find the object's end by scanning once for the brace that closes it, tracking
// string/escape state so braces inside string values don't confuse the depth
// count. Do NOT "walk back from the end trying JSON.parse until it works" — on a
// ~1 MB report that is O(n) parses of O(n) slices and effectively hangs. (It did,
// on first write, 2026-07-28.)
function extractLhr(html) {
    const m = /window\.__LIGHTHOUSE_JSON__\s*=\s*/.exec(html);
    if (!m) throw new Error('no embedded __LIGHTHOUSE_JSON__ found');
    const start = m.index + m[0].length;
    if (html[start] !== '{') throw new Error(`expected '{' at offset ${start}, got ${html[start]}`);

    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < html.length; i++) {
        const c = html[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
    }
    throw new Error('unterminated embedded lhr JSON');
}

function checkReport(name, html, maxAgeDays) {
    const problems = [];
    let lhr;
    try {
        lhr = extractLhr(html);
    } catch (e) {
        return [`${e.message}`];
    }

    const requested = lhr.requestedUrl || '';
    const final = lhr.finalDisplayedUrl || lhr.finalUrl || '';
    const perf = lhr.categories?.performance?.score;

    if (CAPTCHA_URL_RX.test(final)) problems.push(`finalDisplayedUrl is the SG challenge: ${final}`);
    if (perf === null || perf === undefined) problems.push('no performance score — unusable run');

    const items = lhr.audits?.['network-requests']?.details?.items;
    if (Array.isArray(items)) {
        if (items.some(it => CHALLENGE_ASSET_RX.test(it.url || ''))) {
            problems.push('challenge-page assets present — audited the challenge, not the site');
        }
        // Touching the challenge endpoint is fine; a NON-3xx response there means
        // the challenge was actually served to us. A 302 is SG waving us through.
        for (const it of items) {
            if (CAPTCHA_URL_RX.test(it.url || '')) {
                const code = it.statusCode;
                if (typeof code === 'number' && (code < 300 || code >= 400)) {
                    problems.push(`challenge served (HTTP ${code} at sgcaptcha) — measured the challenge`);
                    break;
                }
            }
        }
    }

    if (lhr.fetchTime) {
        const ageDays = (Date.now() - Date.parse(lhr.fetchTime)) / 86400000;
        if (Number.isFinite(ageDays) && ageDays > maxAgeDays) {
            problems.push(`stale: fetchTime ${lhr.fetchTime} is ${ageDays.toFixed(1)}d old (max ${maxAgeDays}d) — the publish gate has been refusing to publish`);
        }
    } else {
        problems.push('no fetchTime — cannot check staleness');
    }

    const score = v => (v === null || v === undefined ? '—' : Math.round(v * 100));
    console.log(`  requested : ${requested}`);
    console.log(`  final     : ${final}`);
    console.log(`  fetchTime : ${lhr.fetchTime || '—'}`);
    console.log(`  perf      : ${score(perf)}`);
    return problems;
}

async function load(target) {
    if (fs.existsSync(target)) return fs.readFileSync(target, 'utf8');
    const url = `${RAW_BASE}/${target}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url} -> HTTP ${res.status}`);
    return res.text();
}

async function main() {
    const args = parseArgs(process.argv);
    const targets = args.files.length ? args.files : DEFAULT_TARGETS;
    let failed = 0;

    for (const target of targets) {
        console.log(`\n=== ${target} ===`);
        let problems;
        try {
            problems = checkReport(target, await load(target), args.maxAgeDays);
        } catch (e) {
            problems = [e.message];
        }
        if (problems.length) {
            failed++;
            for (const p of problems) console.error(`  FAIL: ${p}`);
        } else {
            console.log('  OK — genuine audit, within age limit');
        }
    }

    console.log('');
    if (failed) {
        console.error(`${failed}/${targets.length} published report(s) invalid or stale`);
        process.exit(1);
    }
    console.log(`${targets.length}/${targets.length} published reports OK`);
}

main().catch(e => { console.error(e); process.exit(1); });
