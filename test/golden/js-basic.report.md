# Codebase health

`<repo>` @ `1ef990be72b477df6dfdf1ea506c796cdcea30ca` · crank-health 0.1.0 · quick profile

## Grades

| Category | Grade | Basis |
| --- | --- | --- |
| security | not assessed | gitleaks is not on PATH — install it (brew install gitleaks, or see https://github.com/gitleaks/gitleaks#installing) to assess this, or leave it out and the rest of the scan is unaffected; opengrep is not on PATH — install it (brew install opengrep, or see https://github.com/opengrep/opengrep#installation) to assess this, or leave it out and the rest of the scan is unaffected; no GitHub Actions workflows or composite actions, so zizmor assessed nothing; no Python files in this repo, so bandit assessed nothing; osv-scanner is not on PATH — install it (brew install osv-scanner, or see https://google.github.io/osv-scanner/installation/) to assess this, or leave it out and the rest of the scan is unaffected |
| types | not assessed | no tsconfig.json and no TypeScript sources — nothing owns the types category |
| dead code | F | 2 graded findings (2 warning), weighted total 2 (error ×5, warning ×1, info ×0.2). |
| complexity | D | 1 of 9 functions over cognitive complexity 15 (11.1%). |
| duplication | A | 0.0% of tokens duplicated. |
| lint | F | 3 graded findings (3 error), weighted total 15 (error ×5, warning ×1, info ×0.2). 1 advisory finding did not count toward the grade. |
| format | C | 1 of 9 checked files fail the formatter (11.1%). |
| test quality | not assessed | not assessed — run `--deep` |

### Measurements

- Complexity: 1 of 9 functions over cognitive complexity 15 (11.1%).
- Duplication: 0.0% of tokens duplicated.
- Format: 9 files checked by a formatter.

## security — not assessed

Not graded: gitleaks is not on PATH — install it (brew install gitleaks, or see https://github.com/gitleaks/gitleaks#installing) to assess this, or leave it out and the rest of the scan is unaffected; opengrep is not on PATH — install it (brew install opengrep, or see https://github.com/opengrep/opengrep#installation) to assess this, or leave it out and the rest of the scan is unaffected; no GitHub Actions workflows or composite actions, so zizmor assessed nothing; no Python files in this repo, so bandit assessed nothing; osv-scanner is not on PATH — install it (brew install osv-scanner, or see https://google.github.io/osv-scanner/installation/) to assess this, or leave it out and the rest of the scan is unaffected

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| bandit | not available | [default-config] | — (pinned 1.9.4) | no Python files in this repo, so bandit assessed nothing |
| gitleaks | not available | [default-config] | — (pinned 8.30.1) | gitleaks is not on PATH — install it (brew install gitleaks, or see https://github.com/gitleaks/gitleaks#installing) to assess this, or leave it out and the rest of the scan is unaffected |
| opengrep | not available | [default-config] | — (pinned 1.26.0) | opengrep is not on PATH — install it (brew install opengrep, or see https://github.com/opengrep/opengrep#installation) to assess this, or leave it out and the rest of the scan is unaffected |
| osv-scanner | not available | [default-config] | — (pinned 2.4.0) | osv-scanner is not on PATH — install it (brew install osv-scanner, or see https://google.github.io/osv-scanner/installation/) to assess this, or leave it out and the rest of the scan is unaffected |
| zizmor | not available | [default-config] | — (pinned 1.29.0) | no GitHub Actions workflows or composite actions, so zizmor assessed nothing |

## types — not assessed

Not graded: no tsconfig.json and no TypeScript sources — nothing owns the types category

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| tsc | not available | [default-config] | — (pinned 7.0.2) | no tsconfig.json and no TypeScript sources — nothing owns the types category |

## dead code — F

2 graded findings (2 warning), weighted total 2 (error ×5, warning ×1, info ×0.2).

Graded on weighted findings per KLOC: A ≤0.5, B ≤2, C ≤5, D ≤10, else F.

**Remediation.** Delete the unused export, file or dependency — or wire it up, if it was meant to be used. Check each one for dynamic or external use an analyzer cannot see before deleting it.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| fallow-dead-code | ok | [default-config] | 3.14.0 | — |
| knip | ok | [default-config] | 6.31.0 | — |

**Findings** (2)

- warning `src/clean.js:5` `fallow/unused-export` — Export `subtract` is never used (fallow-dead-code) [default-config]
- warning `src/clean.js:5` `knip/unused-exports` — Export `subtract` is never used (knip) [default-config]

Evidence: [raw/fallow-dead-code.json](raw/fallow-dead-code.json) · [raw/fallow-dead-code.stderr.txt](raw/fallow-dead-code.stderr.txt) · [raw/knip.json](raw/knip.json)

## complexity — D

1 of 9 functions over cognitive complexity 15 (11.1%).

Graded on the measured percentage: A ≤2, B ≤5, C ≤10, D ≤20, else F.

**Remediation.** Split the flagged functions: extract branch-heavy parts into named helpers and replace nested conditionals with early returns. The ceiling is cognitive complexity 15.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| fallow-health | ok | [default-config] | 3.14.0 | — |
| fta | ok | [default-config] | 3.0.0 | — |

**Findings** (1)

- error `src/complex.js:1` `fallow/complexity` — Function `classify` has cognitive complexity 29 (cyclomatic 18); the ceiling is 15 (fallow-health) [default-config]

Evidence: [raw/fallow-health.json](raw/fallow-health.json) · [raw/fallow-health.stderr.txt](raw/fallow-health.stderr.txt) · [raw/fta.json](raw/fta.json)

## duplication — A

0.0% of tokens duplicated.

Graded on the measured percentage: A ≤3, B ≤5, C ≤10, D ≤20, else F.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| jscpd | ok | [default-config] | 5.0.14 | — |

Evidence: [raw/jscpd-report.json](raw/jscpd-report.json)

## lint — F

3 graded findings (3 error), weighted total 15 (error ×5, warning ×1, info ×0.2). 1 advisory finding did not count toward the grade.

Graded on weighted findings per KLOC: A ≤1, B ≤5, C ≤15, D ≤40, else F.

**Remediation.** Fix the reported violations. Where a rule is wrong for this repo, configure it in the repo’s own lint config rather than suppressing it line by line.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| oxlint | ok | [default-config] | 1.77.0 | — |

**Findings** (3)

- error `src/const-assign.js:2` `eslint(no-const-assign)` — Unexpected re-assignment of `const` variable limit. (oxlint) [default-config]
- error `src/dupe-keys.js:2` `eslint(no-dupe-keys)` — Duplicate key 'home' (oxlint) [default-config]
- error `src/unreachable.js:6` `eslint(no-unreachable)` — Unreachable code. (oxlint) [default-config]

**Advisory findings — reported, not counted toward the grade** (1)

- warning `src/accumulate.js:2` `oxc(no-accumulating-spread)` — Do not spread accumulators in loops (oxlint) [default-config] [advisory]

Evidence: [raw/oxlint.sarif.json](raw/oxlint.sarif.json)

## format — C

1 of 9 checked files fail the formatter (11.1%).

Graded on the measured percentage: A ≤1, B ≤10, C ≤30, D ≤60, else F.

**Remediation.** Run the repo’s formatter over the listed files. Keep format-only changes in their own commit so they do not hide a behaviour change.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| prettier | ok | [default-config] | 3.9.6 | — |

**Findings** (1)

- warning `src/unformatted.js` `prettier/format` — File does not match prettier’s default formatting (prettier) [default-config]
  - fix: npx prettier --write <file>

Evidence: [raw/prettier.txt](raw/prettier.txt)

## test quality — not assessed

Not graded: not assessed — run `--deep`

---
