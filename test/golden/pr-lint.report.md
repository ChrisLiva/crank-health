# Codebase health

`<repo>` @ `<sha>` · crank-health 0.13.0 · quick profile · PR vs `main` (merge-base `<short>`)

## Grades

| Category | Grade | Basis |
| --- | --- | --- |
| lint | F — 10 weighted findings per 0.012 KLOC | 2 graded findings (2 error), weighted total 10 (error ×5, warning ×1, info ×0.2). This change: 1 new, 1 resolved. |

Not assessed: not selected by `--only` — security, types, dead code, complexity, duplication, format, test quality

## PR delta

Against `main`, merge-base `<short>`. 1 new finding (1 on lines this change touched), 1 resolved, 1 unchanged.

| Category | Base | Head | New | Resolved |
| --- | --- | --- | --- | --- |
| security | not assessed | not assessed | 0 | 0 |
| types | not assessed | not assessed | 0 | 0 |
| dead code | not assessed | not assessed | 0 | 0 |
| complexity | not assessed | not assessed | 0 | 0 |
| duplication | not assessed | not assessed | 0 | 0 |
| lint | F | F | 1 | 1 |
| format | not assessed | not assessed | 0 | 0 |
| test quality | not assessed | not assessed | 0 | 0 |

**New findings** (1)

- error `src/clean.js:3` `eslint(no-unreachable)` — Unreachable code. (oxlint) [default-config] [in-diff]

**Resolved findings** (1)

- error `src/fixed.js:2` `eslint(no-const-assign)` — Unexpected re-assignment of `const` variable limit. (oxlint) [default-config]

## lint — F

2 graded findings (2 error), weighted total 10 (error ×5, warning ×1, info ×0.2). This change: 1 new, 1 resolved.

| Tool | Scan | State | Config | Version | Notes |
| --- | --- | --- | --- | --- | --- |
| aislop | base | ok | [default-config] | 0.15.0 | — |
| aislop | head | ok | [default-config] | 0.15.0 | — |
| oxlint | base | ok | [default-config] | 1.80.0 | — |
| oxlint | head | ok | [default-config] | 1.80.0 | — |
| react-doctor | base | not available | [default-config] | — (pinned 0.9.12) | no React dependency detected |
| react-doctor | head | not available | [default-config] | — (pinned 0.9.12) | no React dependency detected |

**Findings** (2)

- error `src/clean.js:3` `eslint(no-unreachable)` — Unreachable code. (oxlint) [default-config]
- error `src/renamed.js:2` `eslint(no-dupe-keys)` — Duplicate key 'x' (oxlint) [default-config]

Evidence: [raw/base/root/aislop.json](raw/base/root/aislop.json) · [raw/root/aislop.json](raw/root/aislop.json) · [raw/base/root/oxlint.sarif.json](raw/base/root/oxlint.sarif.json) · [raw/root/oxlint.sarif.json](raw/root/oxlint.sarif.json)

## Reference

How each category is graded, and what fixing it means — the same in every report.

| Category | Graded on | Remediation |
| --- | --- | --- |
| lint | weighted findings per KLOC: A ≤1, B ≤5, C ≤15, D ≤40, else F. | Fix the reported violations. Where a rule is wrong for this repo, configure it in the repo’s own lint config rather than suppressing it line by line. |

---
