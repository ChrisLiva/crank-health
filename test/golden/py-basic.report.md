# Codebase health

`<repo>` @ `115d9d5485a1af0d26655b36a218ba53c995f5ad` · crank-health 0.16.0 · quick profile

## Grades

| Category | Grade | Basis |
| --- | --- | --- |
| security | A — 0 graded findings | Nothing counted toward the grade. |
| types | F — 5 weighted findings per 0.062 KLOC | 1 graded finding (1 error), weighted total 5 (error ×5, warning ×1, info ×0.2). |
| dead code | F — 1 weighted finding per 0.062 KLOC | 1 graded finding (1 warning), weighted total 1 (error ×5, warning ×1, info ×0.2). 1 advisory finding did not count toward the grade. |
| complexity | D — 1 of 7 functions over cognitive complexity 15 | 1 of 7 functions over cognitive complexity 15 (14.3%). |
| duplication | A — 0.0% of tokens duplicated | 0.0% of tokens duplicated. |
| lint | F — 7 weighted findings per 0.062 KLOC | 3 graded findings (1 error, 2 warning), weighted total 7 (error ×5, warning ×1, info ×0.2). |
| format | C — 1 of 6 files failing the formatter | 1 of 6 checked files fail the formatter (16.7%). |
| test quality | not assessed | not assessed — run `--deep` |

### Measurements

- Complexity: 1 of 7 functions over cognitive complexity 15 (14.3%).
- Duplication: 0.0% of tokens duplicated.
- Format: 6 files checked by a formatter.

## security — A

Nothing counted toward the grade.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| bandit | ok | [default-config] | 1.9.4 | — |
| gitleaks | not available | [default-config] | — (pinned 8.30.1) | gitleaks is not on PATH — install it (brew install gitleaks, or see https://github.com/gitleaks/gitleaks#installing) to assess this, or leave it out and the rest of the scan is unaffected |
| govulncheck | not available | [default-config] | — (pinned v1.7.0) | no go.mod in this repo, so govulncheck assessed no Go dependencies |
| opengrep | not available | [default-config] | — (pinned 1.29.0) | opengrep is not on PATH — install it (brew install opengrep, or see https://github.com/opengrep/opengrep#installation) to assess this, or leave it out and the rest of the scan is unaffected |
| osv-scanner | not available | [default-config] | — (pinned 2.5.1) | osv-scanner is not on PATH — install it (brew install osv-scanner, or see https://google.github.io/osv-scanner/installation/) to assess this, or leave it out and the rest of the scan is unaffected |
| zizmor | not available | [default-config] | — (pinned 1.30.0) | no GitHub Actions workflows or composite actions, so zizmor assessed nothing |

Evidence: [raw/root/bandit.json](raw/root/bandit.json)

## types — F

1 graded finding (1 error), weighted total 5 (error ×5, warning ×1, info ×0.2).

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| pyright | not available | [default-config] | — (pinned 1.1.411) | standing down: this project has no virtualenv, so ty type-checks it |
| ty | ok | [default-config] | 0.0.78 | — |

**Findings** (1)

- error `undefined_name.py:2` `unresolved-reference` — Name `missing_name` used when not defined (ty) [default-config]

Evidence: [raw/root/ty.gitlab.json](raw/root/ty.gitlab.json)

## dead code — F

1 graded finding (1 warning), weighted total 1 (error ×5, warning ×1, info ×0.2). 1 advisory finding did not count toward the grade.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| vulture | ok | [default-config] | 2.16 | — |

**Findings** (1)

- warning `dead.py` `vulture/unused-import` — Unused import `os` (90% confidence) (vulture) [default-config]

**Advisory findings** (1) — reported, not counted toward the grade: 1 × `vulture` `vulture/unused-function`.

- info `dead.py:8` `vulture/unused-function` — Unused function `never_called` (60% confidence) (vulture) [default-config] [advisory]

Evidence: [raw/root/vulture.txt](raw/root/vulture.txt)

## complexity — D

1 of 7 functions over cognitive complexity 15 (14.3%).

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| complexipy | ok | [default-config] | 7.0.1 | — |

**Findings** (1)

- warning `complex.py:1` `complexipy/cognitive-complexity` — Function 'classify' has a cognitive complexity of 38, which exceeds the maximum allowed complexity of 15. (complexipy) [default-config]

Evidence: [raw/root/complexipy.json](raw/root/complexipy.json) · [raw/root/complexipy.sarif.json](raw/root/complexipy.sarif.json)

## duplication — A

0.0% of tokens duplicated.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| jscpd | ok | [default-config] | 5.1.2 | — |

Evidence: [raw/root/jscpd-report.json](raw/root/jscpd-report.json)

## lint — F

3 graded findings (1 error, 2 warning), weighted total 7 (error ×5, warning ×1, info ×0.2).

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| aislop | ok | [default-config] | 0.16.0 | — |
| ruff-lint | ok | [default-config] | 0.16.6 | — |

**Findings** (3)

- warning `dead.py:1` `F401` — `os` imported but unused (ruff-lint) [default-config]
  - fix: see https://docs.astral.sh/ruff/rules/unused-import
- warning `dead.py` `ai-slop/unused-import` — Imported symbol 'os' is never used (aislop) [default-config]
  - fix: Remove unused imports to keep the code clean
- error `undefined_name.py:2` `F821` — Undefined name `missing_name` (ruff-lint) [default-config]
  - fix: see https://docs.astral.sh/ruff/rules/undefined-name

Evidence: [raw/root/aislop.json](raw/root/aislop.json) · [raw/root/ruff-lint.json](raw/root/ruff-lint.json)

## format — C

1 of 6 checked files fail the formatter (16.7%).

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| ruff-format | ok | [default-config] | 0.16.6 | — |

**Findings** (1)

- warning `unformatted.py` `ruff/format` — File does not match ruff’s default formatting (ruff-format) [default-config]
  - fix: uvx ruff format <file>

Evidence: [raw/root/ruff-format.json](raw/root/ruff-format.json)

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
