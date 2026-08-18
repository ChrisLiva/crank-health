# Codebase health

`<repo>` @ `63a85c9608c26de869f36a70eee7d0f8ca7d78b7` · crank-health 0.10.0 · quick profile

## Grades

| Category | Grade | Basis |
| --- | --- | --- |
| security | A — 0 graded findings | Nothing counted toward the grade. |
| types | F — 5 weighted findings per 0.02 KLOC | 1 graded finding (1 error), weighted total 5 (error ×5, warning ×1, info ×0.2). |
| dead code | A — 0 weighted findings per 0.02 KLOC | Nothing counted toward the grade. |
| complexity | A — 0 of 3 functions over cognitive complexity 15 | 0 of 3 functions over cognitive complexity 15 (0.0%). |
| duplication | A — 0.0% of tokens duplicated | 0.0% of tokens duplicated. |
| lint | F — 10 weighted findings per 0.02 KLOC | 2 graded findings (2 error), weighted total 10 (error ×5, warning ×1, info ×0.2). |
| format | A — 0 of 4 files failing the formatter | 0 of 4 checked files fail the formatter (0.0%). |
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
| security | not assessed | opengrep is not on PATH — install it (brew install opengrep, or see https://github.com/opengrep/opengrep#installation) to assess this, or leave it out and the rest of the scan is unaffected; no Python files, so bandit assessed nothing |
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

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| bandit | ok | [default-config] | 1.9.4 | (services/api) |
| bandit | not available | [default-config] | — (pinned 1.9.4) | no Python files, so bandit assessed nothing (services/web) |
| gitleaks | not available | [default-config] | — (pinned 8.30.1) | gitleaks is not on PATH — install it (brew install gitleaks, or see https://github.com/gitleaks/gitleaks#installing) to assess this, or leave it out and the rest of the scan is unaffected |
| govulncheck | not available | [default-config] | — (pinned v1.7.0) | Go toolchain absent — Go advisories graded conservatively (reachability unknown) |
| opengrep | not available | [default-config] | — (pinned 1.26.0) | opengrep is not on PATH — install it (brew install opengrep, or see https://github.com/opengrep/opengrep#installation) to assess this, or leave it out and the rest of the scan is unaffected (services/api, services/web) |
| osv-scanner | not available | [default-config] | — (pinned 2.5.0) | osv-scanner is not on PATH — install it (brew install osv-scanner, or see https://google.github.io/osv-scanner/installation/) to assess this, or leave it out and the rest of the scan is unaffected |
| zizmor | not available | [default-config] | — (pinned 1.29.0) | no GitHub Actions workflows or composite actions, so zizmor assessed nothing |

Evidence: [raw/services/api/bandit.json](raw/services/api/bandit.json)

## types — F

1 graded finding (1 error), weighted total 5 (error ×5, warning ×1, info ×0.2).

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| pyright | not available | [default-config] | — (pinned 1.1.411) | standing down: this project has no virtualenv, so ty type-checks it (services/api) |
| tsc | not available | [default-config] | — (pinned 7.0.2) | no tsconfig.json and no TypeScript sources — nothing owns the types category (services/web) |
| ty | ok | [default-config] | 0.0.72 | (services/api) |

**Findings** (1)

- error `services/api/greet.py:2` `unresolved-reference` — Name `missing_name` used when not defined (ty) [default-config]

Evidence: [raw/services/api/ty.gitlab.json](raw/services/api/ty.gitlab.json)

## dead code — A

Nothing counted toward the grade.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| fallow-dead-code | ok | [default-config] | 3.17.0 | (services/web) |
| knip | error | [default-config] | — (pinned 6.32.2) | could not parse knip output: Unexpected token 'R', " Run `knip "... is not valid JSON (services/web) |
| vulture | ok | [default-config] | 2.16 | (services/api) |

Evidence: [raw/services/web/fallow-dead-code.json](raw/services/web/fallow-dead-code.json) · [raw/services/web/fallow-dead-code.stderr.txt](raw/services/web/fallow-dead-code.stderr.txt) · [raw/services/web/knip.json](raw/services/web/knip.json) · [raw/services/web/knip.stderr.txt](raw/services/web/knip.stderr.txt)

## complexity — A

0 of 3 functions over cognitive complexity 15 (0.0%).

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| complexipy | ok | [default-config] | 7.0.1 | (services/api) |
| fallow-health | ok | [default-config] | 3.17.0 | (services/web) |
| fta | ok | [default-config] | 3.0.1 | (services/web) |

Evidence: [raw/services/api/complexipy.json](raw/services/api/complexipy.json) · [raw/services/api/complexipy.sarif.json](raw/services/api/complexipy.sarif.json) · [raw/services/web/fallow-health.json](raw/services/web/fallow-health.json) · [raw/services/web/fallow-health.stderr.txt](raw/services/web/fallow-health.stderr.txt) · [raw/services/web/fta.json](raw/services/web/fta.json)

## duplication — A

0.0% of tokens duplicated.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| jscpd | ok | [default-config] | 5.0.15 | — |

Evidence: [raw/repo/jscpd-report.json](raw/repo/jscpd-report.json) · [raw/services/api/jscpd-report.json](raw/services/api/jscpd-report.json) · [raw/services/web/jscpd-report.json](raw/services/web/jscpd-report.json)

## lint — F

2 graded findings (2 error), weighted total 10 (error ×5, warning ×1, info ×0.2).

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| oxlint | ok | [default-config] | 1.78.0 | (services/web) |
| react-doctor | not available | [default-config] | — (pinned 0.9.12) | no React dependency detected (services/web) |
| ruff-lint | ok | [default-config] | 0.16.3 | (services/api) |

**Findings** (2)

- error `services/api/greet.py:2` `F821` — Undefined name `missing_name` (ruff-lint) [default-config]
  - fix: see https://docs.astral.sh/ruff/rules/undefined-name
- error `services/web/src/dupe-keys.js:2` `eslint(no-dupe-keys)` — Duplicate key 'home' (oxlint) [default-config]

Evidence: [raw/services/web/oxlint.sarif.json](raw/services/web/oxlint.sarif.json) · [raw/services/api/ruff-lint.json](raw/services/api/ruff-lint.json)

## format — A

0 of 4 checked files fail the formatter (0.0%).

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| prettier | ok | [default-config] | 3.9.6 | (services/web) |
| ruff-format | ok | [default-config] | 0.16.3 | (services/api) |

Evidence: [raw/services/api/ruff-format.json](raw/services/api/ruff-format.json)

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
