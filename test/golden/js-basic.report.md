# Codebase health

`<repo>` @ `ae26f855da3e9c5e066a3f5921243a54f49eb741` · crank-health 0.13.0 · quick profile

## Grades

| Category | Grade | Basis |
| --- | --- | --- |
| security | not assessed | gitleaks is not on PATH — install it (brew install gitleaks, or see https://github.com/gitleaks/gitleaks#installing) to assess this, or leave it out and the rest of the scan is unaffected; opengrep is not on PATH — install it (brew install opengrep, or see https://github.com/opengrep/opengrep#installation) to assess this, or leave it out and the rest of the scan is unaffected; no GitHub Actions workflows or composite actions, so zizmor assessed nothing; no Python files, so bandit assessed nothing; osv-scanner is not on PATH — install it (brew install osv-scanner, or see https://google.github.io/osv-scanner/installation/) to assess this, or leave it out and the rest of the scan is unaffected; no go.mod in this repo, so govulncheck assessed no Go dependencies |
| types | not assessed | no tsconfig.json and no TypeScript sources — nothing owns the types category |
| dead code | D — 1 weighted finding per 0.1 KLOC | 1 graded finding (1 warning), weighted total 1 (error ×5, warning ×1, info ×0.2). |
| complexity | D — 1 of 9 functions over cognitive complexity 15 | 1 of 9 functions over cognitive complexity 15 (11.1%). |
| duplication | A — 0.0% of tokens duplicated | 0.0% of tokens duplicated. |
| lint | F — 16 weighted findings per 0.1 KLOC | 4 graded findings (3 error, 1 warning), weighted total 16 (error ×5, warning ×1, info ×0.2). 1 advisory finding did not count toward the grade. |
| format | C — 1 of 9 files failing the formatter | 1 of 9 checked files fail the formatter (11.1%). |
| test quality | not assessed | not assessed — run `--deep` |

### Measurements

- Complexity: 1 of 9 functions over cognitive complexity 15 (11.1%).
- Duplication: 0.0% of tokens duplicated.
- Format: 9 files checked by a formatter.

## security — not assessed

Not graded: gitleaks is not on PATH — install it (brew install gitleaks, or see https://github.com/gitleaks/gitleaks#installing) to assess this, or leave it out and the rest of the scan is unaffected; opengrep is not on PATH — install it (brew install opengrep, or see https://github.com/opengrep/opengrep#installation) to assess this, or leave it out and the rest of the scan is unaffected; no GitHub Actions workflows or composite actions, so zizmor assessed nothing; no Python files, so bandit assessed nothing; osv-scanner is not on PATH — install it (brew install osv-scanner, or see https://google.github.io/osv-scanner/installation/) to assess this, or leave it out and the rest of the scan is unaffected; no go.mod in this repo, so govulncheck assessed no Go dependencies

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| bandit | not available | [default-config] | — (pinned 1.9.4) | no Python files, so bandit assessed nothing |
| gitleaks | not available | [default-config] | — (pinned 8.30.1) | gitleaks is not on PATH — install it (brew install gitleaks, or see https://github.com/gitleaks/gitleaks#installing) to assess this, or leave it out and the rest of the scan is unaffected |
| govulncheck | not available | [default-config] | — (pinned v1.7.0) | no go.mod in this repo, so govulncheck assessed no Go dependencies |
| opengrep | not available | [default-config] | — (pinned 1.28.0) | opengrep is not on PATH — install it (brew install opengrep, or see https://github.com/opengrep/opengrep#installation) to assess this, or leave it out and the rest of the scan is unaffected |
| osv-scanner | not available | [default-config] | — (pinned 2.5.1) | osv-scanner is not on PATH — install it (brew install osv-scanner, or see https://google.github.io/osv-scanner/installation/) to assess this, or leave it out and the rest of the scan is unaffected |
| zizmor | not available | [default-config] | — (pinned 1.29.0) | no GitHub Actions workflows or composite actions, so zizmor assessed nothing |

## types — not assessed

Not graded: no tsconfig.json and no TypeScript sources — nothing owns the types category

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| tsc | not available | [default-config] | — (pinned 7.0.2) | no tsconfig.json and no TypeScript sources — nothing owns the types category |

## dead code — D

1 graded finding (1 warning), weighted total 1 (error ×5, warning ×1, info ×0.2).

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| fallow-dead-code | ok | [default-config] | 3.20.0 | — |
| knip | ok | [default-config] | 6.32.3 | — |

**Findings** (1)

- warning `src/clean.js:5` `fallow/unused-export` — Export `subtract` is never used (fallow-dead-code) [default-config]

Evidence: [raw/root/fallow-dead-code.json](raw/root/fallow-dead-code.json) · [raw/root/fallow-dead-code.stderr.txt](raw/root/fallow-dead-code.stderr.txt) · [raw/root/knip.json](raw/root/knip.json)

## complexity — D

1 of 9 functions over cognitive complexity 15 (11.1%).

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| fallow-health | ok | [default-config] | 3.20.0 | — |
| fta | ok | [default-config] | 3.0.1 | — |

**Findings** (1)

- error `src/complex.js:1` `fallow/complexity` — Function `classify` has cognitive complexity 29 (cyclomatic 18); the ceiling is 15 (fallow-health) [default-config]

Evidence: [raw/root/fallow-health.json](raw/root/fallow-health.json) · [raw/root/fallow-health.stderr.txt](raw/root/fallow-health.stderr.txt) · [raw/root/fta.json](raw/root/fta.json)

## duplication — A

0.0% of tokens duplicated.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| jscpd | ok | [default-config] | 5.0.16 | — |

Evidence: [raw/root/jscpd-report.json](raw/root/jscpd-report.json)

## lint — F

4 graded findings (3 error, 1 warning), weighted total 16 (error ×5, warning ×1, info ×0.2). 1 advisory finding did not count toward the grade.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| aislop | ok | [default-config] | 0.15.0 | — |
| oxlint | ok | [default-config] | 1.80.0 | — |
| react-doctor | not available | [default-config] | — (pinned 0.9.12) | no React dependency detected |

**Findings** (4)

- error `src/const-assign.js:2` `eslint(no-const-assign)` — Unexpected re-assignment of `const` variable limit. (oxlint) [default-config]
- error `src/dupe-keys.js:2` `eslint(no-dupe-keys)` — Duplicate key 'home' (oxlint) [default-config]
- warning `src/unreachable.js:6` `ai-slop/unreachable-code` — Code after return/throw statement is unreachable (aislop) [default-config]
  - fix: Remove the unreachable code or restructure the control flow
- error `src/unreachable.js:6` `eslint(no-unreachable)` — Unreachable code. (oxlint) [default-config]

**Advisory findings** (1) — reported, not counted toward the grade: 1 × `oxlint` `oxc(no-accumulating-spread)`.

- warning `src/accumulate.js:2` `oxc(no-accumulating-spread)` — Do not spread accumulators in loops (oxlint) [default-config] [advisory]

Evidence: [raw/root/aislop.json](raw/root/aislop.json) · [raw/root/oxlint.sarif.json](raw/root/oxlint.sarif.json)

## format — C

1 of 9 checked files fail the formatter (11.1%).

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| prettier | ok | [default-config] | 3.9.6 | — |

**Findings** (1)

- warning `src/unformatted.js` `prettier/format` — File does not match prettier’s default formatting (prettier) [default-config]
  - fix: npx prettier --write <file>

Evidence: [raw/root/prettier.txt](raw/root/prettier.txt)

## test quality — not assessed

Not graded: not assessed — run `--deep`

## Reference

How each category is graded, and what fixing it means — the same in every report.

| Category | Graded on | Remediation |
| --- | --- | --- |
| security | absolute counts, never normalized: any critical → F, any error → D, no graded finding → A, otherwise B or C by the warning and info counts. | Treat a leaked credential as compromised: rotate it first, then remove it from the code and from history. For the rest, fix the flagged call site, upgrade the affected dependency, and pin third-party actions to a commit sha. |
| types | weighted findings per KLOC: A ≤0, B ≤1, C ≤5, D ≤15, else F. | Fix the reported errors where they are raised. Widening a type or adding a suppression moves the grade without changing what the code does wrong. |
| dead code | weighted findings per KLOC: A ≤0.5, B ≤2, C ≤5, D ≤10, else F. | Delete the unused export, file or dependency — or wire it up, if it was meant to be used. Check each one for dynamic or external use an analyzer cannot see before deleting it. |
| complexity | the measured percentage: A ≤2, B ≤5, C ≤10, D ≤20, else F. | Split the flagged functions: extract branch-heavy parts into named helpers and replace nested conditionals with early returns. The ceiling is cognitive complexity 15. |
| duplication | the measured percentage: A ≤3, B ≤5, C ≤10, D ≤20, else F. | Extract the duplicated block into one shared function or module and call it from both sites. The grade is the duplicated-token share, so the largest clones move it most. |
| lint | weighted findings per KLOC: A ≤1, B ≤5, C ≤15, D ≤40, else F. | Fix the reported violations. Where a rule is wrong for this repo, configure it in the repo’s own lint config rather than suppressing it line by line. |
| format | the measured percentage: A ≤1, B ≤10, C ≤30, D ≤60, else F. | Run the repo’s formatter over the listed files. Keep format-only changes in their own commit so they do not hide a behaviour change. |
| test quality | the measured percentage: A ≥80, B ≥65, C ≥50, D ≥35, else F. | Strengthen the tests covering the code the mutation run survived: assert on observable behaviour rather than on the implementation. |

---
