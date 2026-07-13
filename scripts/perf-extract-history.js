#!/usr/bin/env node
/*
 * perf-extract-history.js — parse a directory of Lighthouse JSON reports
 * (lhr.json) into a structured per-page-per-factor-per-run history file.
 *
 * Replaces the previous extract-4-category-scores-then-discard approach.
 * Captures Core Web Vitals + audit numericValues so we can attribute
 * changes to specific metrics over time, not just the rolled-up perf score.
 *
 * Usage:
 *   node scripts/perf-extract-history.js \
 *     --inputs lighthouse-reports/ \
 *     --out    history-output.json \
 *     --run-id 26210264411 \
 *     --run-number 32 \
 *     --started-at 2026-05-21T06:48:43Z
 *
 * Filename convention (set by tests/perf/lighthouse-homepage.spec.ts):
 *   lighthouse-${slug}-${target}-${factor}-run${n}.json
 * Captcha-blocked runs (finalDisplayedUrl contains /.well-known/sgcaptcha/)
 * are reported separately and excluded from the median/min/max summary.
 *
 * Output schema documented in docs/performance-status.md §Measurement upgrade.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Audits worth tracking ──────────────────────────────────────────────────
// Each entry: numericValue is what we extract; unit notes interpretation.
const METRIC_AUDITS = [
    { id: 'first-contentful-paint',   key: 'fcp_ms',         unit: 'ms' },
    { id: 'largest-contentful-paint', key: 'lcp_ms',         unit: 'ms' },
    { id: 'cumulative-layout-shift',  key: 'cls',            unit: 'unitless' },
    { id: 'total-blocking-time',      key: 'tbt_ms',         unit: 'ms' },
    { id: 'speed-index',              key: 'si_ms',          unit: 'ms' },
    { id: 'interactive',              key: 'tti_ms',         unit: 'ms' },
];

// Savings audits report ms in numericValue (used in perf-score weighting)
// AND actual byte savings in details.overallSavingsBytes (the structural
// metric we cite in changelogs). We capture both.
const SAVINGS_AUDITS = [
    { id: 'unused-css-rules',  msKey: 'unused_css_ms',  bytesKey: 'unused_css_bytes' },
    { id: 'unused-javascript', msKey: 'unused_js_ms',   bytesKey: 'unused_js_bytes' },
];

// Pure ms / bytes audits — no dual field.
const DIAGNOSTIC_AUDITS = [
    { id: 'render-blocking-resources', key: 'render_blocking_ms',  unit: 'ms' },
    { id: 'bootup-time',               key: 'bootup_time_ms',      unit: 'ms' },
    { id: 'total-byte-weight',         key: 'total_bytes',         unit: 'bytes' },
    { id: 'mainthread-work-breakdown', key: 'main_thread_ms',      unit: 'ms' },
];

const SUMMARY_METRICS = [
    'perf', 'a11y', 'bp', 'seo',
    ...METRIC_AUDITS.map(a => a.key),
    ...SAVINGS_AUDITS.flatMap(a => [a.msKey, a.bytesKey]),
    ...DIAGNOSTIC_AUDITS.map(a => a.key),
    'third_party_blocking_ms',
];

// ─── Argparse ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
    const out = {};
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (!k.startsWith('--')) continue;
        out[k.slice(2)] = argv[i + 1];
        i++;
    }
    if (!out.inputs || !out.out) {
        console.error('usage: node perf-extract-history.js --inputs <dir> --out <file> [--run-id N] [--run-number N] [--started-at ISO8601]');
        process.exit(2);
    }
    return out;
}

// ─── Statistics ─────────────────────────────────────────────────────────────
function median(sorted) {
    const n = sorted.length;
    if (n === 0) return null;
    const mid = Math.floor(n / 2);
    return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(sorted, p) {
    const n = sorted.length;
    if (n === 0) return null;
    if (n === 1) return sorted[0];
    const idx = (p / 100) * (n - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function summarize(values) {
    const clean = values.filter(v => v !== null && v !== undefined && !Number.isNaN(v));
    if (clean.length === 0) return { n: 0, median: null, min: null, max: null, p25: null, p75: null };
    const sorted = [...clean].sort((a, b) => a - b);
    return {
        n: clean.length,
        median: round(median(sorted)),
        min: round(sorted[0]),
        max: round(sorted[sorted.length - 1]),
        p25: round(percentile(sorted, 25)),
        p75: round(percentile(sorted, 75)),
    };
}

function round(v) {
    if (v === null || v === undefined) return null;
    // 2 decimal places for unitless (CLS); integer for ms/bytes/scores.
    return Math.abs(v) < 5 && v !== Math.floor(v) ? Math.round(v * 100) / 100 : Math.round(v);
}

// ─── Parse one lhr.json ─────────────────────────────────────────────────────
function parseOneReport(filePath) {
    let r;
    try {
        r = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        return { error: `parse failed: ${e.message}`, file: filePath };
    }

    const finalUrl = r.finalDisplayedUrl || r.finalUrl || '';
    if (/\/\.well-known\/sgcaptcha\//.test(finalUrl)) {
        return { captcha: true, finalUrl, file: filePath };
    }

    const cats = r.categories || {};
    const audits = r.audits || {};

    const score = k => {
        const c = cats[k];
        if (!c || c.score === null || c.score === undefined) return null;
        return Math.round(c.score * 100);
    };

    const auditValue = id => {
        const a = audits[id];
        if (!a || a.numericValue === null || a.numericValue === undefined) return null;
        return round(a.numericValue);
    };

    const row = {
        file: path.basename(filePath),
        finalUrl,
        fetchTime: r.fetchTime || null,
        lhVersion: r.lighthouseVersion || null,
        perf: score('performance'),
        a11y: score('accessibility'),
        bp: score('best-practices'),
        seo: score('seo'),
    };
    for (const m of METRIC_AUDITS) row[m.key] = auditValue(m.id);
    for (const s of SAVINGS_AUDITS) {
        const a = audits[s.id];
        row[s.msKey]    = a ? round(a.numericValue) : null;
        row[s.bytesKey] = a && a.details ? round(a.details.overallSavingsBytes) : null;
    }
    for (const d of DIAGNOSTIC_AUDITS) row[d.key] = auditValue(d.id);

    // Third-party summary — flatten per-origin into a small structured field.
    const tps = audits['third-party-summary'];
    if (tps && tps.details && Array.isArray(tps.details.items)) {
        row.third_parties = tps.details.items.map(it => ({
            entity: it.entity || it.url || 'unknown',
            blocking_ms: round(it.blockingTime),
            main_thread_ms: round(it.mainThreadTime),
            transfer_bytes: round(it.transferSize),
        }));
        // Aggregate scalar for trend chart.
        row.third_party_blocking_ms = round(
            tps.details.items.reduce((sum, it) => sum + (it.blockingTime || 0), 0)
        );
    }

    return row;
}

// ─── Group reports by (slug, factor) ────────────────────────────────────────
// New format: lighthouse-${slug}-${target}-${factor}-run${n}.json (post-2026-05-21)
// Legacy:     lighthouse-${slug}-${target}-${factor}.json         (backfill)
const FILENAME_RX_NEW    = /^lighthouse-(.+)-(local|prod|staging)-(mobile|desktop)-run(\d+)\.json$/;
const FILENAME_RX_LEGACY = /^lighthouse-(.+)-(local|prod|staging)-(mobile|desktop)\.json$/;

function groupReports(dir) {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const groups = {};   // slug -> factor -> [{ runIdx, file }]
    let target = null;

    for (const f of files) {
        let slug, tgt, factor, runIdx;
        const mNew = f.match(FILENAME_RX_NEW);
        if (mNew) {
            [, slug, tgt, factor] = mNew;
            runIdx = parseInt(mNew[4], 10);
        } else {
            const mLeg = f.match(FILENAME_RX_LEGACY);
            if (!mLeg) continue;
            [, slug, tgt, factor] = mLeg;
            runIdx = 1;   // legacy = single-run capture, treated as run 1
        }
        target = target || tgt;
        groups[slug] = groups[slug] || {};
        groups[slug][factor] = groups[slug][factor] || [];
        groups[slug][factor].push({ runIdx, file: path.join(dir, f) });
    }

    // Sort each factor's runs by runIdx for deterministic order.
    for (const slug of Object.keys(groups)) {
        for (const factor of Object.keys(groups[slug])) {
            groups[slug][factor].sort((a, b) => a.runIdx - b.runIdx);
        }
    }

    return { groups, target };
}

// ─── Build the output ───────────────────────────────────────────────────────
function buildOutput(args) {
    const { groups, target } = groupReports(args.inputs);

    const pages = {};
    let exampleUrl = null;

    for (const slug of Object.keys(groups).sort()) {
        pages[slug] = {};
        for (const factor of ['mobile', 'desktop']) {
            const runs = groups[slug][factor] || [];
            if (runs.length === 0) continue;

            const parsed = runs.map(r => {
                const row = parseOneReport(r.file);
                row.run_idx = r.runIdx;
                if (row.finalUrl && !exampleUrl) exampleUrl = row.finalUrl;
                return row;
            });

            const valid = parsed.filter(r => !r.captcha && !r.error);
            const captchaCount = parsed.filter(r => r.captcha).length;

            const summary = {};
            for (const key of SUMMARY_METRICS) {
                summary[key] = summarize(valid.map(r => r[key]));
            }

            // URL: pull from the first successful run (all should be the same path).
            const pageUrl = valid.find(v => v.finalUrl && !/\.well-known/.test(v.finalUrl))?.finalUrl
                         || parsed[0]?.finalUrl
                         || null;
            if (!pages[slug].url) pages[slug].url = pageUrl;

            pages[slug][factor] = {
                n_attempted: parsed.length,
                n_valid: valid.length,
                n_captcha: captchaCount,
                runs: parsed,
                summary,
            };
        }
    }

    return {
        run_number: args['run-number'] || null,
        run_id: args['run-id'] || null,
        started_at: args['started-at'] || new Date().toISOString(),
        target: target || 'prod',
        pages,
    };
}

// ─── Main ───────────────────────────────────────────────────────────────────
function main() {
    const args = parseArgs(process.argv);

    if (!fs.existsSync(args.inputs) || !fs.statSync(args.inputs).isDirectory()) {
        console.error(`Inputs dir not found: ${args.inputs}`);
        process.exit(1);
    }

    const output = buildOutput(args);
    fs.writeFileSync(args.out, JSON.stringify(output, null, 2));

    // Brief summary to stderr for the workflow log.
    const lines = [];
    for (const slug of Object.keys(output.pages)) {
        for (const factor of ['mobile', 'desktop']) {
            const cell = output.pages[slug][factor];
            if (!cell) continue;
            const perfSummary = cell.summary.perf;
            lines.push(`  ${slug}/${factor}: N=${cell.n_valid}/${cell.n_attempted} perf median=${perfSummary.median ?? '—'} range=[${perfSummary.min ?? '—'},${perfSummary.max ?? '—'}]${cell.n_captcha ? ` (${cell.n_captcha} captcha-blocked)` : ''}`);
        }
    }
    console.error(`[perf-extract] wrote ${args.out}`);
    console.error(lines.join('\n'));
}

if (require.main === module) main();

module.exports = { parseOneReport, summarize, buildOutput };
