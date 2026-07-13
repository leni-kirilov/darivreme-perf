#!/usr/bin/env node
/*
 * perf-rebuild-timeline.js — read all history/runs/*.json files, emit a
 * flat timeline.json suitable for chart rendering.
 *
 * Each row in the output covers one (run × page × factor) combination,
 * carrying the median values of every metric. The chart consumer picks
 * which metrics to plot per page/factor slice.
 *
 * Usage:
 *   node scripts/perf-rebuild-timeline.js <runs-dir> <output-file>
 *
 * Schema (array of objects):
 *   [
 *     {
 *       "date": "2026-05-21",
 *       "run_number": 32,
 *       "started_at": "2026-05-21T06:48:43Z",
 *       "page": "home",
 *       "factor": "mobile",
 *       "n_valid": 5,
 *       "n_captcha": 0,
 *       "perf": 51, "a11y": 84, "bp": 100, "seo": 100,
 *       "lcp_ms": 13200, "fcp_ms": 2800, "tbt_ms": 950, ...
 *       "unused_css_bytes": 300762, "unused_js_bytes": 327748, ...
 *     },
 *     ...
 *   ]
 *
 * Sorted by started_at ascending. Captcha-blocked cells (n_valid=0) are
 * still emitted so the gap is visible on the chart.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function flatten(runFile) {
    const h = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    const dateOnly = (h.started_at || '').slice(0, 10);
    const rows = [];
    for (const slug of Object.keys(h.pages || {})) {
        for (const factor of ['mobile', 'desktop']) {
            const cell = h.pages[slug][factor];
            if (!cell) continue;
            const row = {
                date: dateOnly,
                run_number: h.run_number || null,
                started_at: h.started_at || null,
                page: slug,
                factor,
                n_valid: cell.n_valid || 0,
                n_captcha: cell.n_captcha || 0,
            };
            // Copy median of every summary key.
            for (const key of Object.keys(cell.summary || {})) {
                row[key] = cell.summary[key].median;
            }
            rows.push(row);
        }
    }
    return rows;
}

function main() {
    const [, , runsDir, outFile] = process.argv;
    if (!runsDir || !outFile) {
        console.error('usage: node perf-rebuild-timeline.js <runs-dir> <output-file>');
        process.exit(2);
    }
    if (!fs.existsSync(runsDir)) {
        console.error(`runs dir not found: ${runsDir}`);
        process.exit(1);
    }
    const files = fs.readdirSync(runsDir).filter(f => f.endsWith('.json'));
    let rows = [];
    for (const f of files) {
        try {
            rows = rows.concat(flatten(path.join(runsDir, f)));
        } catch (e) {
            console.error(`skip ${f}: ${e.message}`);
        }
    }
    rows.sort((a, b) => {
        if (a.started_at && b.started_at) return a.started_at.localeCompare(b.started_at);
        return (a.run_number || 0) - (b.run_number || 0);
    });
    fs.writeFileSync(outFile, JSON.stringify(rows, null, 2));
    console.error(`[perf-timeline] wrote ${outFile} with ${rows.length} rows from ${files.length} run files`);
}

if (require.main === module) main();

module.exports = { flatten };
