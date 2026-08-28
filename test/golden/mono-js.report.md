# Codebase health

`<repo>` @ `acbb91a96406d62565ed52fa2009a8581e16b023` · crank-health 0.15.0 · quick profile

## Grades

| Category | Grade | Basis |
| --- | --- | --- |
| security | not assessed | gitleaks is not on PATH — install it (brew install gitleaks, or see https://github.com/gitleaks/gitleaks#installing) to assess this, or leave it out and the rest of the scan is unaffected; opengrep is not on PATH — install it (brew install opengrep, or see https://github.com/opengrep/opengrep#installation) to assess this, or leave it out and the rest of the scan is unaffected; no GitHub Actions workflows or composite actions, so zizmor assessed nothing; no Python files, so bandit assessed nothing; osv-scanner is not on PATH — install it (brew install osv-scanner, or see https://google.github.io/osv-scanner/installation/) to assess this, or leave it out and the rest of the scan is unaffected; no go.mod in this repo, so govulncheck assessed no Go dependencies |
| types | not assessed | no tsconfig.json and no TypeScript sources — nothing owns the types category |
| dead code | A — 0 weighted findings per 0.26 KLOC | Nothing counted toward the grade. |
| complexity | A — 0 of 19 functions over cognitive complexity 15 | 0 of 19 functions over cognitive complexity 15 (0.0%). 6 advisory findings did not count toward the grade. |
| duplication | D — 12.7% of tokens duplicated | 12.7% of tokens duplicated; the clone below is the evidence, not the grade. 1 advisory finding did not count toward the grade. |
| lint | D — 10 weighted findings per 0.26 KLOC | 2 graded findings (2 error), weighted total 10 (error ×5, warning ×1, info ×0.2). |
| format | B — 1 of 10 files failing the formatter | 1 of 10 checked files fail the formatter (10.0%). |
| test quality | not assessed | not assessed — run `--deep` |

**Scan notes.**

- scan scope: 1 file under a hidden directory was not analyzed by language tools; repo-scoped scanners (gitleaks, osv-scanner) scan the full tree

### Measurements

- Complexity: 0 of 19 functions over cognitive complexity 15 (0.0%).
- Duplication: 12.7% of tokens duplicated.
- Format: 10 files checked by a formatter.

## Projects

2 projects, each graded on its own files, its own toolchain and its own denominators; the grades above are the repo as a whole. A category marked `repo-scoped` is one a repo-spanning scan answered — secrets, dependency audits, workflow checks — so it is graded once, above, and not per project.

The repo root is a workspace shell (declared by package.json): it holds no source of its own, so it is not graded as a project.

### packages/api

`packages/api/package.json` · js-ts

| Category | Grade | Basis |
| --- | --- | --- |
| security | not assessed | opengrep is not on PATH — install it (brew install opengrep, or see https://github.com/opengrep/opengrep#installation) to assess this, or leave it out and the rest of the scan is unaffected |
| types | not assessed | no tsconfig.json and no TypeScript sources — nothing owns the types category |
| dead code | A | Nothing counted toward the grade. |
| complexity | A | 0 of 7 functions over cognitive complexity 15 (0.0%). |
| duplication | A | 0.0% of tokens duplicated; the clone below is the evidence, not the grade. 1 advisory finding did not count toward the grade. |
| lint | F | 1 graded finding (1 error), weighted total 5 (error ×5, warning ×1, info ×0.2). |
| format | C | 1 of 5 checked files fail the formatter (20.0%). |
| test quality | not assessed | not assessed — run `--deep` |

| Tool | Category | Ownership | Owned via | Version |
| --- | --- | --- | --- | --- |
| prettier | format | dependency, not installed | package.json | 3.9.6 |

### packages/web

`packages/web/package.json` · js-ts

| Category | Grade | Basis |
| --- | --- | --- |
| security | not assessed | opengrep is not on PATH — install it (brew install opengrep, or see https://github.com/opengrep/opengrep#installation) to assess this, or leave it out and the rest of the scan is unaffected |
| types | not assessed | no tsconfig.json and no TypeScript sources — nothing owns the types category |
| dead code | A | Nothing counted toward the grade. |
| complexity | A | 0 of 12 functions over cognitive complexity 15 (0.0%). 6 advisory findings did not count toward the grade. |
| duplication | A | 0.0% of tokens duplicated. |
| lint | D | 1 graded finding (1 error), weighted total 5 (error ×5, warning ×1, info ×0.2). |
| format | A | 0 of 5 checked files fail the formatter (0.0%). |
| test quality | not assessed | not assessed — run `--deep` |

| Tool | Category | Ownership | Owned via | Version |
| --- | --- | --- | --- | --- |
| eslint | lint | config+dependency, not installed | packages/web/eslint.config.js | 10.9.1 |
| prettier | format | dependency, not installed | package.json | 3.9.6 |

## security — not assessed

Not graded: gitleaks is not on PATH — install it (brew install gitleaks, or see https://github.com/gitleaks/gitleaks#installing) to assess this, or leave it out and the rest of the scan is unaffected; opengrep is not on PATH — install it (brew install opengrep, or see https://github.com/opengrep/opengrep#installation) to assess this, or leave it out and the rest of the scan is unaffected; no GitHub Actions workflows or composite actions, so zizmor assessed nothing; no Python files, so bandit assessed nothing; osv-scanner is not on PATH — install it (brew install osv-scanner, or see https://google.github.io/osv-scanner/installation/) to assess this, or leave it out and the rest of the scan is unaffected; no go.mod in this repo, so govulncheck assessed no Go dependencies

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| bandit | not available | [default-config] | — (pinned 1.9.4) | no Python files, so bandit assessed nothing |
| gitleaks | not available | [default-config] | — (pinned 8.30.1) | gitleaks is not on PATH — install it (brew install gitleaks, or see https://github.com/gitleaks/gitleaks#installing) to assess this, or leave it out and the rest of the scan is unaffected |
| govulncheck | not available | [default-config] | — (pinned v1.7.0) | no go.mod in this repo, so govulncheck assessed no Go dependencies |
| opengrep | not available | [default-config] | — (pinned 1.28.0) | opengrep is not on PATH — install it (brew install opengrep, or see https://github.com/opengrep/opengrep#installation) to assess this, or leave it out and the rest of the scan is unaffected (packages/api, packages/web) |
| osv-scanner | not available | [default-config] | — (pinned 2.5.1) | osv-scanner is not on PATH — install it (brew install osv-scanner, or see https://google.github.io/osv-scanner/installation/) to assess this, or leave it out and the rest of the scan is unaffected |
| zizmor | not available | [default-config] | — (pinned 1.29.0) | no GitHub Actions workflows or composite actions, so zizmor assessed nothing |

## types — not assessed

Not graded: no tsconfig.json and no TypeScript sources — nothing owns the types category

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| tsc | not available | [default-config] | — (pinned 7.0.2) | no tsconfig.json and no TypeScript sources — nothing owns the types category (packages/api, packages/web) |

## dead code — A

Nothing counted toward the grade.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| fallow-dead-code | ok | [default-config] | 3.20.0 | (packages/api, packages/web) |
| knip | ok | [default-config] | 6.32.3 | (packages/api, packages/web) |

Evidence: [raw/packages/api/fallow-dead-code.json](raw/packages/api/fallow-dead-code.json) · [raw/packages/api/fallow-dead-code.stderr.txt](raw/packages/api/fallow-dead-code.stderr.txt) · [raw/packages/web/fallow-dead-code.json](raw/packages/web/fallow-dead-code.json) · [raw/packages/web/fallow-dead-code.stderr.txt](raw/packages/web/fallow-dead-code.stderr.txt) · [raw/packages/api/knip.json](raw/packages/api/knip.json) · [raw/packages/web/knip.json](raw/packages/web/knip.json)

## complexity — A

0 of 19 functions over cognitive complexity 15 (0.0%). 6 advisory findings did not count toward the grade.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| fallow-health | ok | [default-config] | 3.20.0 | (packages/api, packages/web) |
| fta | ok | [default-config] | 3.0.1 | (packages/api, packages/web) |

**Advisory findings** (6) — reported, not counted toward the grade: 5 × `fallow-health` `fallow/complexity`, 1 × `fta` `fta/file-score`.

- info `packages/web/src/tokens.js` `fta/file-score` — File has an FTA maintainability score of 63.2 (needs improvement), across 165 lines (fta) [default-config] [advisory]
- error `packages/web/src/tokens.js:10` `fallow/complexity` — Function `kindOf` has cognitive complexity 1 (cyclomatic 37); the ceiling is 15 (fallow-health) [default-config] [advisory]
- error `packages/web/src/tokens.js:58` `fallow/complexity` — Function `tierOf` has cognitive complexity 1 (cyclomatic 35); the ceiling is 15 (fallow-health) [default-config] [advisory]

All 6 are in `report.json`, under `advisories`.

Evidence: [raw/packages/api/fallow-health.json](raw/packages/api/fallow-health.json) · [raw/packages/api/fallow-health.stderr.txt](raw/packages/api/fallow-health.stderr.txt) · [raw/packages/web/fallow-health.json](raw/packages/web/fallow-health.json) · [raw/packages/web/fallow-health.stderr.txt](raw/packages/web/fallow-health.stderr.txt) · [raw/packages/api/fta.json](raw/packages/api/fta.json) · [raw/packages/web/fta.json](raw/packages/web/fta.json)

## duplication — D

12.7% of tokens duplicated; the clone below is the evidence, not the grade. 1 advisory finding did not count toward the grade.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| jscpd | ok | [default-config] | 5.0.16 | (packages/api, packages/web) |

**Advisory findings** (1) — reported, not counted toward the grade: 1 × `jscpd` `jscpd/duplicate-block`.

- warning `packages/api/src/shared.js:1` `jscpd/duplicate-block` — 11 lines (124 tokens) duplicated from packages/web/src/shared.js:1-11 (jscpd) [default-config] [advisory]
  - fix: Extract the duplicated block into a shared function or module

Evidence: [raw/packages/api/jscpd-report.json](raw/packages/api/jscpd-report.json) · [raw/packages/web/jscpd-report.json](raw/packages/web/jscpd-report.json) · [raw/repo/jscpd-report.json](raw/repo/jscpd-report.json)

## lint — D

2 graded findings (2 error), weighted total 10 (error ×5, warning ×1, info ×0.2).

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| aislop | ok | [default-config] | 0.15.0 | (packages/api, packages/web) |
| eslint | ok | [repo-config] | 10.9.1 | (packages/web) |
| oxlint | ok | [default-config] | 1.80.0 | (packages/api) |
| oxlint | ok | [default-config] | 1.80.0 | stood down: lint graded by eslint (packages/web) |
| react-doctor | not available | [default-config] | — (pinned 0.9.12) | no React dependency detected (packages/api, packages/web) |

**Findings** (2)

- error `packages/api/src/const-assign.js:2` `eslint(no-const-assign)` — Unexpected re-assignment of `const` variable limit. (oxlint) [default-config]
- error `packages/web/src/lint.js:2` `no-unused-vars` — 'unused' is assigned a value but never used. (eslint) [repo-config]

Evidence: [raw/packages/api/aislop.json](raw/packages/api/aislop.json) · [raw/packages/web/aislop.json](raw/packages/web/aislop.json) · [raw/packages/web/eslint.json](raw/packages/web/eslint.json) · [raw/packages/api/oxlint.sarif.json](raw/packages/api/oxlint.sarif.json) · [raw/packages/web/oxlint.sarif.json](raw/packages/web/oxlint.sarif.json)

## format — B

1 of 10 checked files fail the formatter (10.0%).

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| prettier | ok | [repo-config] | 3.9.6 | (packages/api, packages/web) |

**Findings** (1)

- warning `packages/api/src/unformatted.js` `prettier/format` — File does not match the repo’s prettier configuration (prettier) [repo-config]
  - fix: npx prettier --write <file>

Evidence: [raw/packages/api/prettier.txt](raw/packages/api/prettier.txt)

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
