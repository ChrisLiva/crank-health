# Codebase health

`<repo>` @ `7efc798a8272cfcfaa35d9bb77747075e07febd6` · crank-health 0.3.0 · quick profile

## Grades

| Category | Grade | Basis |
| --- | --- | --- |
| security | not assessed | gitleaks is not on PATH — install it (brew install gitleaks, or see https://github.com/gitleaks/gitleaks#installing) to assess this, or leave it out and the rest of the scan is unaffected; opengrep is not on PATH — install it (brew install opengrep, or see https://github.com/opengrep/opengrep#installation) to assess this, or leave it out and the rest of the scan is unaffected; no GitHub Actions workflows or composite actions, so zizmor assessed nothing; no Python files in this repo, so bandit assessed nothing; osv-scanner is not on PATH — install it (brew install osv-scanner, or see https://google.github.io/osv-scanner/installation/) to assess this, or leave it out and the rest of the scan is unaffected |
| types | not assessed | no tsconfig.json and no TypeScript sources — nothing owns the types category |
| dead code | A | Nothing counted toward the grade. |
| complexity | A | 0 of 11 functions over cognitive complexity 15 (0.0%). |
| duplication | F | 41.2% of tokens duplicated; the 2 clones below are the evidence, not the grade. 2 advisory findings did not count toward the grade. |
| lint | F | 2 graded findings (2 error), weighted total 10 (error ×5, warning ×1, info ×0.2). |
| format | C | 1 of 8 checked files fail the formatter (12.5%). |
| test quality | not assessed | not assessed — run `--deep` |

### Measurements

- Complexity: 0 of 11 functions over cognitive complexity 15 (0.0%).
- Duplication: 41.2% of tokens duplicated.
- Format: 8 files checked by a formatter.

## Projects

2 projects, each graded on its own files, its own toolchain and its own denominators; the grades above are the repo as a whole. A category marked `repo-scoped` is one a repo-spanning scan answered — secrets, dependency audits, workflow checks — so it is graded once, above, and not per project.

The repo root is a workspace shell (declared by package.json): it holds no source of its own, so it is not graded as a project.

### packages/api

`packages/api/package.json` · js-ts

| Category | Grade | Basis |
| --- | --- | --- |
| security | not assessed | opengrep is not on PATH — install it (brew install opengrep, or see https://github.com/opengrep/opengrep#installation) to assess this, or leave it out and the rest of the scan is unaffected; no Python files in this repo, so bandit assessed nothing |
| types | not assessed | no tsconfig.json and no TypeScript sources — nothing owns the types category |
| dead code | A | Nothing counted toward the grade. |
| complexity | A | 0 of 6 functions over cognitive complexity 15 (0.0%). |
| duplication | A | 0.0% of tokens duplicated; the 1 clone below are the evidence, not the grade. 1 advisory finding did not count toward the grade. |
| lint | F | 1 graded finding (1 error), weighted total 5 (error ×5, warning ×1, info ×0.2). |
| format | C | 1 of 4 checked files fail the formatter (25.0%). |
| test quality | not assessed | not assessed — run `--deep` |

| Tool | Category | Ownership | Owned via | Version |
| --- | --- | --- | --- | --- |
| prettier | format | dependency, not installed | package.json | 3.9.6 |

### packages/web

`packages/web/package.json` · js-ts

| Category | Grade | Basis |
| --- | --- | --- |
| security | not assessed | opengrep is not on PATH — install it (brew install opengrep, or see https://github.com/opengrep/opengrep#installation) to assess this, or leave it out and the rest of the scan is unaffected; no Python files in this repo, so bandit assessed nothing |
| types | not assessed | no tsconfig.json and no TypeScript sources — nothing owns the types category |
| dead code | A | Nothing counted toward the grade. |
| complexity | A | 0 of 5 functions over cognitive complexity 15 (0.0%). |
| duplication | A | 0.0% of tokens duplicated; the 1 clone below are the evidence, not the grade. 1 advisory finding did not count toward the grade. |
| lint | F | 1 graded finding (1 error), weighted total 5 (error ×5, warning ×1, info ×0.2). |
| format | A | 0 of 4 checked files fail the formatter (0.0%). |
| test quality | not assessed | not assessed — run `--deep` |

| Tool | Category | Ownership | Owned via | Version |
| --- | --- | --- | --- | --- |
| eslint | lint | config+dependency, not installed | packages/web/eslint.config.js | 10.8.0 |
| prettier | format | dependency, not installed | package.json | 3.9.6 |

## security — not assessed

Not graded: gitleaks is not on PATH — install it (brew install gitleaks, or see https://github.com/gitleaks/gitleaks#installing) to assess this, or leave it out and the rest of the scan is unaffected; opengrep is not on PATH — install it (brew install opengrep, or see https://github.com/opengrep/opengrep#installation) to assess this, or leave it out and the rest of the scan is unaffected; no GitHub Actions workflows or composite actions, so zizmor assessed nothing; no Python files in this repo, so bandit assessed nothing; osv-scanner is not on PATH — install it (brew install osv-scanner, or see https://google.github.io/osv-scanner/installation/) to assess this, or leave it out and the rest of the scan is unaffected

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| bandit | not available | [default-config] | — (pinned 1.9.4) | no Python files in this repo, so bandit assessed nothing |
| bandit | not available | [default-config] | — (pinned 1.9.4) | no Python files in this repo, so bandit assessed nothing |
| gitleaks | not available | [default-config] | — (pinned 8.30.1) | gitleaks is not on PATH — install it (brew install gitleaks, or see https://github.com/gitleaks/gitleaks#installing) to assess this, or leave it out and the rest of the scan is unaffected |
| opengrep | not available | [default-config] | — (pinned 1.26.0) | opengrep is not on PATH — install it (brew install opengrep, or see https://github.com/opengrep/opengrep#installation) to assess this, or leave it out and the rest of the scan is unaffected |
| opengrep | not available | [default-config] | — (pinned 1.26.0) | opengrep is not on PATH — install it (brew install opengrep, or see https://github.com/opengrep/opengrep#installation) to assess this, or leave it out and the rest of the scan is unaffected |
| osv-scanner | not available | [default-config] | — (pinned 2.4.0) | osv-scanner is not on PATH — install it (brew install osv-scanner, or see https://google.github.io/osv-scanner/installation/) to assess this, or leave it out and the rest of the scan is unaffected |
| zizmor | not available | [default-config] | — (pinned 1.29.0) | no GitHub Actions workflows or composite actions, so zizmor assessed nothing |

## types — not assessed

Not graded: no tsconfig.json and no TypeScript sources — nothing owns the types category

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| tsc | not available | [default-config] | — (pinned 7.0.2) | no tsconfig.json and no TypeScript sources — nothing owns the types category |
| tsc | not available | [default-config] | — (pinned 7.0.2) | no tsconfig.json and no TypeScript sources — nothing owns the types category |

## dead code — A

Nothing counted toward the grade.

Graded on weighted findings per KLOC: A ≤0.5, B ≤2, C ≤5, D ≤10, else F.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| fallow-dead-code | ok | [default-config] | 3.14.0 | — |
| fallow-dead-code | ok | [default-config] | 3.14.0 | — |
| knip | ok | [default-config] | 6.31.0 | — |
| knip | ok | [default-config] | 6.31.0 | — |

Evidence: [raw/packages/api/fallow-dead-code.json](raw/packages/api/fallow-dead-code.json) · [raw/packages/api/fallow-dead-code.stderr.txt](raw/packages/api/fallow-dead-code.stderr.txt) · [raw/packages/web/fallow-dead-code.json](raw/packages/web/fallow-dead-code.json) · [raw/packages/web/fallow-dead-code.stderr.txt](raw/packages/web/fallow-dead-code.stderr.txt) · [raw/packages/api/knip.json](raw/packages/api/knip.json) · [raw/packages/web/knip.json](raw/packages/web/knip.json)

## complexity — A

0 of 11 functions over cognitive complexity 15 (0.0%).

Graded on the measured percentage: A ≤2, B ≤5, C ≤10, D ≤20, else F.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| fallow-health | ok | [default-config] | 3.14.0 | — |
| fallow-health | ok | [default-config] | 3.14.0 | — |
| fta | ok | [default-config] | 3.0.0 | — |
| fta | ok | [default-config] | 3.0.0 | — |

Evidence: [raw/packages/api/fallow-health.json](raw/packages/api/fallow-health.json) · [raw/packages/api/fallow-health.stderr.txt](raw/packages/api/fallow-health.stderr.txt) · [raw/packages/web/fallow-health.json](raw/packages/web/fallow-health.json) · [raw/packages/web/fallow-health.stderr.txt](raw/packages/web/fallow-health.stderr.txt) · [raw/packages/api/fta.json](raw/packages/api/fta.json) · [raw/packages/web/fta.json](raw/packages/web/fta.json)

## duplication — F

41.2% of tokens duplicated; the 2 clones below are the evidence, not the grade. 2 advisory findings did not count toward the grade.

Graded on the measured percentage: A ≤3, B ≤5, C ≤10, D ≤20, else F.

**Remediation.** Extract the duplicated block into one shared function or module and call it from both sites. The grade is the duplicated-token share, so the largest clones move it most.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| jscpd | ok | [default-config] | 5.0.14 | — |
| jscpd | ok | [default-config] | 5.0.14 | — |
| jscpd | ok | [default-config] | 5.0.14 | — |

**Advisory findings — reported, not counted toward the grade** (2)

- warning `packages/api/src/shared.js:1` `jscpd/duplicate-block` — 11 lines (124 tokens) duplicated from packages/web/src/shared.js:1-11 (jscpd) [default-config] [advisory]
  - fix: Extract the duplicated block into a shared function or module
- warning `packages/web/src/shared.js:1` `jscpd/duplicate-block` — 11 lines (124 tokens) duplicated from packages/api/src/shared.js:1-11 (jscpd) [default-config] [advisory]
  - fix: Extract the duplicated block into a shared function or module

Evidence: [raw/packages/api/jscpd-report.json](raw/packages/api/jscpd-report.json) · [raw/packages/web/jscpd-report.json](raw/packages/web/jscpd-report.json) · [raw/repo/jscpd-report.json](raw/repo/jscpd-report.json)

## lint — F

2 graded findings (2 error), weighted total 10 (error ×5, warning ×1, info ×0.2).

Graded on weighted findings per KLOC: A ≤1, B ≤5, C ≤15, D ≤40, else F.

**Remediation.** Fix the reported violations. Where a rule is wrong for this repo, configure it in the repo’s own lint config rather than suppressing it line by line.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| eslint | ok | [repo-config] | 10.8.0 | — |
| oxlint | ok | [default-config] | 1.77.0 | — |
| oxlint | ok | [default-config] | 1.77.0 | stood down: lint graded by eslint |

**Findings** (2)

- error `packages/api/src/const-assign.js:2` `eslint(no-const-assign)` — Unexpected re-assignment of `const` variable limit. (oxlint) [default-config]
- error `packages/web/src/lint.js:2` `no-unused-vars` — 'unused' is assigned a value but never used. (eslint) [repo-config]

Evidence: [raw/packages/web/eslint.json](raw/packages/web/eslint.json) · [raw/packages/api/oxlint.sarif.json](raw/packages/api/oxlint.sarif.json) · [raw/packages/web/oxlint.sarif.json](raw/packages/web/oxlint.sarif.json)

## format — C

1 of 8 checked files fail the formatter (12.5%).

Graded on the measured percentage: A ≤1, B ≤10, C ≤30, D ≤60, else F.

**Remediation.** Run the repo’s formatter over the listed files. Keep format-only changes in their own commit so they do not hide a behaviour change.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| prettier | ok | [repo-config] | 3.9.6 | — |
| prettier | ok | [repo-config] | 3.9.6 | — |

**Findings** (1)

- warning `packages/api/src/unformatted.js` `prettier/format` — File does not match the repo’s prettier configuration (prettier) [repo-config]
  - fix: npx prettier --write <file>

Evidence: [raw/packages/api/prettier.txt](raw/packages/api/prettier.txt) · [raw/packages/web/prettier.txt](raw/packages/web/prettier.txt)

## test quality — not assessed

Not graded: not assessed — run `--deep`

---
