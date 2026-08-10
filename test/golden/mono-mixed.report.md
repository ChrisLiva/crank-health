# Codebase health

`<repo>` @ `3048f450a6c1c828d5fd777d2b188c80877db803` · crank-health 0.6.0 · quick profile

## Grades

| Category | Grade | Basis |
| --- | --- | --- |
| security | A | Nothing counted toward the grade. |
| types | F | 1 graded finding (1 error), weighted total 5 (error ×5, warning ×1, info ×0.2). |
| dead code | A | Nothing counted toward the grade. |
| complexity | A | 0 of 3 functions over cognitive complexity 15 (0.0%). |
| duplication | A | 0.0% of tokens duplicated. |
| lint | F | 2 graded findings (2 error), weighted total 10 (error ×5, warning ×1, info ×0.2). |
| format | A | 0 of 4 checked files fail the formatter (0.0%). |
| test quality | not assessed | not assessed — run `--deep` |

### Findings by language

| Source | security | types | dead code | complexity | duplication | lint | format | test quality | total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| js-ts | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 1 |
| python | 0 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 2 |

### Measurements

- Complexity: 0 of 3 functions over cognitive complexity 15 (0.0%).
- Duplication: 0.0% of tokens duplicated.
- Format: 4 files checked by a formatter.

## Projects

2 projects, each graded on its own files, its own toolchain and its own denominators; the grades above are the repo as a whole. A category marked `repo-scoped` is one a repo-spanning scan answered — secrets, dependency audits, workflow checks — so it is graded once, above, and not per project.

The repo root is a workspace shell: it holds no source of its own, so it is not graded as a project.

### services/api

`services/api/pyproject.toml` · python

| Category | Grade | Basis |
| --- | --- | --- |
| security | A | Nothing counted toward the grade. |
| types | F | 1 graded finding (1 error), weighted total 5 (error ×5, warning ×1, info ×0.2). |
| dead code | A | Nothing counted toward the grade. |
| complexity | A | 0 of 2 functions over cognitive complexity 15 (0.0%). |
| duplication | A | 0.0% of tokens duplicated. |
| lint | F | 1 graded finding (1 error), weighted total 5 (error ×5, warning ×1, info ×0.2). |
| format | A | 0 of 2 checked files fail the formatter (0.0%). |
| test quality | not assessed | not assessed — run `--deep` |

This project declares no tool of its own: it was analyzed on crank-health’s defaults.

### services/web

`services/web/package.json` · js-ts

| Category | Grade | Basis |
| --- | --- | --- |
| security | not assessed | opengrep is not on PATH — install it (brew install opengrep, or see https://github.com/opengrep/opengrep#installation) to assess this, or leave it out and the rest of the scan is unaffected; no Python files in this repo, so bandit assessed nothing |
| types | not assessed | no tsconfig.json and no TypeScript sources — nothing owns the types category |
| dead code | A | Nothing counted toward the grade. |
| complexity | A | 0 of 1 function over cognitive complexity 15 (0.0%). |
| duplication | A | 0.0% of tokens duplicated. |
| lint | F | 1 graded finding (1 error), weighted total 5 (error ×5, warning ×1, info ×0.2). |
| format | A | 0 of 2 checked files fail the formatter (0.0%). |
| test quality | not assessed | not assessed — run `--deep` |

This project declares no tool of its own: it was analyzed on crank-health’s defaults.

## security — A

Nothing counted toward the grade.

Graded on absolute counts, never normalized: any critical → F, any error → D, no graded finding → A, otherwise B or C by the warning and info counts.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| bandit | ok | [default-config] | 1.9.4 | — |
| bandit | not available | [default-config] | — (pinned 1.9.4) | no Python files in this repo, so bandit assessed nothing |
| gitleaks | not available | [default-config] | — (pinned 8.30.1) | gitleaks is not on PATH — install it (brew install gitleaks, or see https://github.com/gitleaks/gitleaks#installing) to assess this, or leave it out and the rest of the scan is unaffected |
| opengrep | not available | [default-config] | — (pinned 1.26.0) | opengrep is not on PATH — install it (brew install opengrep, or see https://github.com/opengrep/opengrep#installation) to assess this, or leave it out and the rest of the scan is unaffected |
| osv-scanner | not available | [default-config] | — (pinned 2.4.0) | osv-scanner is not on PATH — install it (brew install osv-scanner, or see https://google.github.io/osv-scanner/installation/) to assess this, or leave it out and the rest of the scan is unaffected |
| zizmor | not available | [default-config] | — (pinned 1.29.0) | no GitHub Actions workflows or composite actions, so zizmor assessed nothing |

Evidence: [raw/services/api/bandit.json](raw/services/api/bandit.json)

## types — F

1 graded finding (1 error), weighted total 5 (error ×5, warning ×1, info ×0.2).

Graded on weighted findings per KLOC: A ≤0, B ≤1, C ≤5, D ≤15, else F.

**Remediation.** Fix the reported errors where they are raised. Widening a type or adding a suppression moves the grade without changing what the code does wrong.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| pyright | not available | [default-config] | — (pinned 1.1.411) | standing down: this project has no virtualenv, so ty type-checks it |
| tsc | not available | [default-config] | — (pinned 7.0.2) | no tsconfig.json and no TypeScript sources — nothing owns the types category |
| ty | ok | [default-config] | 0.0.66 | — |

**Findings** (1)

- error `services/api/greet.py:2` `unresolved-reference` — Name `missing_name` used when not defined (ty) [default-config]

Evidence: [raw/services/api/ty.gitlab.json](raw/services/api/ty.gitlab.json)

## dead code — A

Nothing counted toward the grade.

Graded on weighted findings per KLOC: A ≤0.5, B ≤2, C ≤5, D ≤10, else F.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| fallow-dead-code | ok | [default-config] | 3.14.0 | — |
| knip | error | [default-config] | — (pinned 6.31.0) | could not parse knip output: Unexpected token 'R', " Run `knip "... is not valid JSON |
| vulture | ok | [default-config] | 2.16 | — |

Evidence: [raw/services/web/fallow-dead-code.json](raw/services/web/fallow-dead-code.json) · [raw/services/web/fallow-dead-code.stderr.txt](raw/services/web/fallow-dead-code.stderr.txt) · [raw/services/web/knip.json](raw/services/web/knip.json) · [raw/services/web/knip.stderr.txt](raw/services/web/knip.stderr.txt) · [raw/services/api/vulture.txt](raw/services/api/vulture.txt)

## complexity — A

0 of 3 functions over cognitive complexity 15 (0.0%).

Graded on the measured percentage: A ≤2, B ≤5, C ≤10, D ≤20, else F.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| complexipy | ok | [default-config] | 6.2.0 | — |
| fallow-health | ok | [default-config] | 3.14.0 | — |
| fta | ok | [default-config] | 3.0.0 | — |

Evidence: [raw/services/api/complexipy.json](raw/services/api/complexipy.json) · [raw/services/api/complexipy.sarif.json](raw/services/api/complexipy.sarif.json) · [raw/services/web/fallow-health.json](raw/services/web/fallow-health.json) · [raw/services/web/fallow-health.stderr.txt](raw/services/web/fallow-health.stderr.txt) · [raw/services/web/fta.json](raw/services/web/fta.json)

## duplication — A

0.0% of tokens duplicated.

Graded on the measured percentage: A ≤3, B ≤5, C ≤10, D ≤20, else F.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| jscpd | ok | [default-config] | 5.0.14 | — |

Evidence: [raw/repo/jscpd-report.json](raw/repo/jscpd-report.json) · [raw/services/api/jscpd-report.json](raw/services/api/jscpd-report.json) · [raw/services/web/jscpd-report.json](raw/services/web/jscpd-report.json)

## lint — F

2 graded findings (2 error), weighted total 10 (error ×5, warning ×1, info ×0.2).

Graded on weighted findings per KLOC: A ≤1, B ≤5, C ≤15, D ≤40, else F.

**Remediation.** Fix the reported violations. Where a rule is wrong for this repo, configure it in the repo’s own lint config rather than suppressing it line by line.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| oxlint | ok | [default-config] | 1.77.0 | — |
| react-doctor | not available | [default-config] | — (pinned 0.9.5) | no React dependency detected |
| ruff-lint | ok | [default-config] | 0.16.1 | — |

**Findings** (2)

- error `services/api/greet.py:2` `F821` — Undefined name `missing_name` (ruff-lint) [default-config]
  - fix: see https://docs.astral.sh/ruff/rules/undefined-name
- error `services/web/src/dupe-keys.js:2` `eslint(no-dupe-keys)` — Duplicate key 'home' (oxlint) [default-config]

Evidence: [raw/services/web/oxlint.sarif.json](raw/services/web/oxlint.sarif.json) · [raw/services/api/ruff-lint.json](raw/services/api/ruff-lint.json)

## format — A

0 of 4 checked files fail the formatter (0.0%).

Graded on the measured percentage: A ≤1, B ≤10, C ≤30, D ≤60, else F.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| prettier | ok | [default-config] | 3.9.6 | — |
| ruff-format | ok | [default-config] | 0.16.1 | — |

Evidence: [raw/services/web/prettier.txt](raw/services/web/prettier.txt) · [raw/services/api/ruff-format.json](raw/services/api/ruff-format.json)

## test quality — not assessed

Not graded: not assessed — run `--deep`

---
