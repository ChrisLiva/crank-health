# Codebase health

`<repo>` @ `b56bfa4385957a69ba6c188096dd29abd4eecf1b` · crank-health 0.2.1 · quick profile

## Grades

| Category | Grade | Basis |
| --- | --- | --- |
| security | A | Nothing counted toward the grade. |
| types | F | 1 graded finding (1 error), weighted total 5 (error ×5, warning ×1, info ×0.2). |
| dead code | F | 1 graded finding (1 warning), weighted total 1 (error ×5, warning ×1, info ×0.2). 1 advisory finding did not count toward the grade. |
| complexity | D | 1 of 7 functions over cognitive complexity 15 (14.3%). |
| duplication | A | 0.0% of tokens duplicated. |
| lint | F | 2 graded findings (1 error, 1 warning), weighted total 6 (error ×5, warning ×1, info ×0.2). |
| format | C | 1 of 6 checked files fail the formatter (16.7%). |
| test quality | not assessed | not assessed — run `--deep` |

### Measurements

- Complexity: 1 of 7 functions over cognitive complexity 15 (14.3%).
- Duplication: 0.0% of tokens duplicated.
- Format: 6 files checked by a formatter.

## security — A

Nothing counted toward the grade.

Graded on absolute counts, never normalized: any critical → F, any error → D, no graded finding → A, otherwise B or C by the warning and info counts.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| bandit | ok | [default-config] | 1.9.4 | — |
| gitleaks | not available | [default-config] | — (pinned 8.30.1) | gitleaks is not on PATH — install it (brew install gitleaks, or see https://github.com/gitleaks/gitleaks#installing) to assess this, or leave it out and the rest of the scan is unaffected |
| opengrep | not available | [default-config] | — (pinned 1.26.0) | opengrep is not on PATH — install it (brew install opengrep, or see https://github.com/opengrep/opengrep#installation) to assess this, or leave it out and the rest of the scan is unaffected |
| osv-scanner | not available | [default-config] | — (pinned 2.4.0) | osv-scanner is not on PATH — install it (brew install osv-scanner, or see https://google.github.io/osv-scanner/installation/) to assess this, or leave it out and the rest of the scan is unaffected |
| zizmor | not available | [default-config] | — (pinned 1.29.0) | no GitHub Actions workflows or composite actions, so zizmor assessed nothing |

Evidence: [raw/bandit.json](raw/bandit.json)

## types — F

1 graded finding (1 error), weighted total 5 (error ×5, warning ×1, info ×0.2).

Graded on weighted findings per KLOC: A ≤0, B ≤1, C ≤5, D ≤15, else F.

**Remediation.** Fix the reported errors where they are raised. Widening a type or adding a suppression moves the grade without changing what the code does wrong.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| pyright | not available | [default-config] | — (pinned 1.1.411) | standing down: this project has no virtualenv, so ty type-checks it |
| ty | ok | [default-config] | 0.0.66 | — |

**Findings** (1)

- error `undefined_name.py:2` `unresolved-reference` — Name `missing_name` used when not defined (ty) [default-config]

Evidence: [raw/ty.gitlab.json](raw/ty.gitlab.json)

## dead code — F

1 graded finding (1 warning), weighted total 1 (error ×5, warning ×1, info ×0.2). 1 advisory finding did not count toward the grade.

Graded on weighted findings per KLOC: A ≤0.5, B ≤2, C ≤5, D ≤10, else F.

**Remediation.** Delete the unused export, file or dependency — or wire it up, if it was meant to be used. Check each one for dynamic or external use an analyzer cannot see before deleting it.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| vulture | ok | [default-config] | 2.16 | — |

**Findings** (1)

- warning `dead.py` `vulture/unused-import` — Unused import `os` (90% confidence) (vulture) [default-config]

**Advisory findings — reported, not counted toward the grade** (1)

- info `dead.py:8` `vulture/unused-function` — Unused function `never_called` (60% confidence) (vulture) [default-config] [advisory]

Evidence: [raw/vulture.txt](raw/vulture.txt)

## complexity — D

1 of 7 functions over cognitive complexity 15 (14.3%).

Graded on the measured percentage: A ≤2, B ≤5, C ≤10, D ≤20, else F.

**Remediation.** Split the flagged functions: extract branch-heavy parts into named helpers and replace nested conditionals with early returns. The ceiling is cognitive complexity 15.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| complexipy | ok | [default-config] | 6.2.0 | — |

**Findings** (1)

- warning `complex.py:1` `complexipy/cognitive-complexity` — Function 'classify' has a cognitive complexity of 38, which exceeds the maximum allowed complexity of 15. (complexipy) [default-config]

Evidence: [raw/complexipy.json](raw/complexipy.json) · [raw/complexipy.sarif.json](raw/complexipy.sarif.json)

## duplication — A

0.0% of tokens duplicated.

Graded on the measured percentage: A ≤3, B ≤5, C ≤10, D ≤20, else F.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| jscpd | ok | [default-config] | 5.0.14 | — |

Evidence: [raw/jscpd-report.json](raw/jscpd-report.json)

## lint — F

2 graded findings (1 error, 1 warning), weighted total 6 (error ×5, warning ×1, info ×0.2).

Graded on weighted findings per KLOC: A ≤1, B ≤5, C ≤15, D ≤40, else F.

**Remediation.** Fix the reported violations. Where a rule is wrong for this repo, configure it in the repo’s own lint config rather than suppressing it line by line.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| ruff-lint | ok | [default-config] | 0.16.1 | — |

**Findings** (2)

- warning `dead.py:1` `F401` — `os` imported but unused (ruff-lint) [default-config]
  - fix: see https://docs.astral.sh/ruff/rules/unused-import
- error `undefined_name.py:2` `F821` — Undefined name `missing_name` (ruff-lint) [default-config]
  - fix: see https://docs.astral.sh/ruff/rules/undefined-name

Evidence: [raw/ruff-lint.json](raw/ruff-lint.json)

## format — C

1 of 6 checked files fail the formatter (16.7%).

Graded on the measured percentage: A ≤1, B ≤10, C ≤30, D ≤60, else F.

**Remediation.** Run the repo’s formatter over the listed files. Keep format-only changes in their own commit so they do not hide a behaviour change.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| ruff-format | ok | [default-config] | 0.16.1 | — |

**Findings** (1)

- warning `unformatted.py` `ruff/format` — File does not match ruff’s default formatting (ruff-format) [default-config]
  - fix: uvx ruff format <file>

Evidence: [raw/ruff-format.json](raw/ruff-format.json)

## test quality — not assessed

Not graded: not assessed — run `--deep`

---
