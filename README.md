# darivreme-perf

Public Lighthouse performance harness + published results for **darivreme.com**.

Two branches, two purposes:

- **`main`** (this branch) — the CI harness: a weekly GitHub Actions workflow
  that runs Lighthouse against the public site (4 pages × mobile/desktop × N=5)
  and publishes the results.
- **`gh-pages`** — the published results: per-metric history JSON
  (`history/timeline.json`, `history/latest.json`) and HTML Lighthouse reports,
  served at <https://leni-kirilov.github.io/darivreme-perf/>.

## Why this lives in a public repo

It audits a **public** URL and publishes **public** results, so it needs no
private source and no server secrets. Public repos get **unlimited free Actions
minutes**, so this monitoring costs zero quota. The private site repo keeps only
the secret-bearing workflows (deploy / drift / security). Moved here from the
private monorepo on 2026-07-13.

## What runs

`.github/workflows/perf-prod.yml` — weekly (Mon 03:00 UTC) + manual dispatch.
Results land in:

- The **perf-tracker issue** in this repo (auto-updated body + rolling comment
  history + an inline timeline chart).
- `gh-pages` (history JSON + HTML reports).

Manual run:

```
gh workflow run perf-prod.yml -R leni-kirilov/darivreme-perf
```

Optional: set a repo **variable** `NTFY_TOPIC` for ntfy.sh push on failures
(a variable, not a secret). No other configuration required — results are
pushed with the built-in `GITHUB_TOKEN`.
