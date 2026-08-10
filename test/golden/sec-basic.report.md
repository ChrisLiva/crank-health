# Codebase health

`<repo>` @ `1cb090abdb6af232c7f51dac1b38b5ec22c2e25f` · crank-health 0.4.0 · quick profile

## Grades

| Category | Grade | Basis |
| --- | --- | --- |
| security | D | 5 graded findings (2 error, 3 warning). 1 advisory finding did not count toward the grade. |
| types | A | Nothing counted toward the grade. |
| dead code | A | Nothing counted toward the grade. |
| complexity | A | 0 of 5 functions over cognitive complexity 15 (0.0%). 2 advisory findings did not count toward the grade. |
| duplication | F | 47.0% of tokens duplicated; the 2 clones below are the evidence, not the grade. 2 advisory findings did not count toward the grade. |
| lint | F | 1 graded finding (1 error), weighted total 5 (error ×5, warning ×1, info ×0.2). |
| format | A | 0 of 5 checked files fail the formatter (0.0%). |
| test quality | not assessed | not assessed — run `--deep` |

### Findings by language

| Source | security | types | dead code | complexity | duplication | lint | format | test quality | total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| js-ts | 0 | 0 | 0 | 2 | 2 | 1 | 0 | 0 | 5 |
| python | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 |
| other | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 4 |

`other` is findings in files no language adapter owns — workflow YAML, lockfiles, config.

### Measurements

- Complexity: 0 of 5 functions over cognitive complexity 15 (0.0%).
- Duplication: 47.0% of tokens duplicated.
- Format: 5 files checked by a formatter.

## security — D

5 graded findings (2 error, 3 warning). 1 advisory finding did not count toward the grade.

Graded on absolute counts, never normalized: any critical → F, any error → D, no graded finding → A, otherwise B or C by the warning and info counts.

**Remediation.** Treat a leaked credential as compromised: rotate it first, then remove it from the code and from history. For the rest, fix the flagged call site, upgrade the affected dependency, and pin third-party actions to a commit sha.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| bandit | ok | [default-config] | 1.9.4 | — |
| gitleaks | not available | [default-config] | — (pinned 8.30.1) | gitleaks is not on PATH — install it (brew install gitleaks, or see https://github.com/gitleaks/gitleaks#installing) to assess this, or leave it out and the rest of the scan is unaffected |
| opengrep | not available | [default-config] | — (pinned 1.26.0) | opengrep is not on PATH — install it (brew install opengrep, or see https://github.com/opengrep/opengrep#installation) to assess this, or leave it out and the rest of the scan is unaffected |
| osv-scanner | not available | [default-config] | — (pinned 2.4.0) | osv-scanner is not on PATH — install it (brew install osv-scanner, or see https://google.github.io/osv-scanner/installation/) to assess this, or leave it out and the rest of the scan is unaffected |
| zizmor | ok | [default-config] | 1.29.0 | — |

**Findings** (5)

- error `.github/workflows/ci.yml:2` `dangerous-triggers` — Use of fundamentally insecure workflow trigger — pull_request_target is almost always used insecurely (high severity, medium confidence) (zizmor) [default-config]
  - fix: see https://docs.zizmor.sh/audits/#dangerous-triggers
- warning `.github/workflows/ci.yml:5` `excessive-permissions` — Overly broad permissions — default permissions used due to no permissions: block (medium severity, medium confidence) (zizmor) [default-config]
  - fix: see https://docs.zizmor.sh/audits/#excessive-permissions
- warning `.github/workflows/ci.yml:8` `artipacked` — Credential persistence through GitHub Actions artifacts — does not set persist-credentials: false (medium severity, low confidence) (zizmor) [default-config]
  - fix: see https://docs.zizmor.sh/audits/#artipacked
- warning `.github/workflows/ci.yml:8` `unpinned-uses` — Unpinned action reference — action is not pinned to a hash (required by blanket policy) (high severity, high confidence) (zizmor) [default-config]
  - fix: see https://docs.zizmor.sh/audits/#unpinned-uses
- error `src/config.py:13` `B602` — subprocess call with shell=True identified, security issue. (high severity, high confidence) (bandit) [default-config]
  - fix: see https://bandit.readthedocs.io/en/1.9.4/plugins/b602_subprocess_popen_with_shell_equals_true.html

**Advisory findings — reported, not counted toward the grade** (1)

- info `src/config.py:3` `B404` — Consider possible security implications associated with the subprocess module. (low severity, high confidence) (bandit) [default-config] [advisory]
  - fix: see https://bandit.readthedocs.io/en/1.9.4/blacklists/blacklist_imports.html#b404-import-subprocess

Evidence: [raw/root/bandit.json](raw/root/bandit.json) · [raw/repo/zizmor.json](raw/repo/zizmor.json) · [raw/repo/zizmor.stderr.txt](raw/repo/zizmor.stderr.txt)

## types — A

Nothing counted toward the grade.

Graded on weighted findings per KLOC: A ≤0, B ≤1, C ≤5, D ≤15, else F.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| pyright | not available | [default-config] | — (pinned 1.1.411) | standing down: this project has no virtualenv, so ty type-checks it |
| tsc | not available | [default-config] | — (pinned 7.0.2) | no tsconfig.json and no TypeScript sources — nothing owns the types category |
| ty | ok | [default-config] | 0.0.66 | — |

Evidence: [raw/root/ty.gitlab.json](raw/root/ty.gitlab.json)

## dead code — A

Nothing counted toward the grade.

Graded on weighted findings per KLOC: A ≤0.5, B ≤2, C ≤5, D ≤10, else F.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| fallow-dead-code | ok | [default-config] | 3.14.0 | — |
| knip | ok | [default-config] | 6.31.0 | — |
| vulture | ok | [default-config] | 2.16 | — |

Evidence: [raw/root/fallow-dead-code.json](raw/root/fallow-dead-code.json) · [raw/root/fallow-dead-code.stderr.txt](raw/root/fallow-dead-code.stderr.txt) · [raw/root/knip.json](raw/root/knip.json) · [raw/root/vulture.txt](raw/root/vulture.txt)

## complexity — A

0 of 5 functions over cognitive complexity 15 (0.0%). 2 advisory findings did not count toward the grade.

Graded on the measured percentage: A ≤2, B ≤5, C ≤10, D ≤20, else F.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| complexipy | ok | [default-config] | 6.2.0 | — |
| fallow-health | ok | [default-config] | 3.14.0 | — |
| fta | ok | [default-config] | 3.0.0 | — |

**Advisory findings — reported, not counted toward the grade** (2)

- info `src/handler.js:5` `fallow/complexity` — Function `summarize` has cognitive complexity 5 (cyclomatic 5); the ceiling is 15 (fallow-health) [default-config] [advisory]
- info `src/report.js:1` `fallow/complexity` — Function `summarize` has cognitive complexity 5 (cyclomatic 5); the ceiling is 15 (fallow-health) [default-config] [advisory]

Evidence: [raw/root/complexipy.json](raw/root/complexipy.json) · [raw/root/complexipy.sarif.json](raw/root/complexipy.sarif.json) · [raw/root/fallow-health.json](raw/root/fallow-health.json) · [raw/root/fallow-health.stderr.txt](raw/root/fallow-health.stderr.txt) · [raw/root/fta.json](raw/root/fta.json)

## duplication — F

47.0% of tokens duplicated; the 2 clones below are the evidence, not the grade. 2 advisory findings did not count toward the grade.

Graded on the measured percentage: A ≤3, B ≤5, C ≤10, D ≤20, else F.

**Remediation.** Extract the duplicated block into one shared function or module and call it from both sites. The grade is the duplicated-token share, so the largest clones move it most.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| jscpd | ok | [default-config] | 5.0.14 | — |

**Advisory findings — reported, not counted toward the grade** (2)

- warning `src/handler.js:5` `jscpd/duplicate-block` — 11 lines (111 tokens) duplicated from src/report.js:1-11 (jscpd) [default-config] [advisory]
  - fix: Extract the duplicated block into a shared function or module
- warning `src/report.js:1` `jscpd/duplicate-block` — 11 lines (111 tokens) duplicated from src/handler.js:5-15 (jscpd) [default-config] [advisory]
  - fix: Extract the duplicated block into a shared function or module

Evidence: [raw/root/jscpd-report.json](raw/root/jscpd-report.json)

## lint — F

1 graded finding (1 error), weighted total 5 (error ×5, warning ×1, info ×0.2).

Graded on weighted findings per KLOC: A ≤1, B ≤5, C ≤15, D ≤40, else F.

**Remediation.** Fix the reported violations. Where a rule is wrong for this repo, configure it in the repo’s own lint config rather than suppressing it line by line.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| oxlint | ok | [default-config] | 1.77.0 | — |
| react-doctor | not available | [default-config] | — (pinned 0.9.5) | no React dependency detected |
| ruff-lint | ok | [default-config] | 0.16.1 | — |

**Findings** (1)

- error `src/handler.js:2` `eslint(no-eval)` — eval can be harmful. (oxlint) [default-config]

Evidence: [raw/root/oxlint.sarif.json](raw/root/oxlint.sarif.json) · [raw/root/ruff-lint.json](raw/root/ruff-lint.json)

## format — A

0 of 5 checked files fail the formatter (0.0%).

Graded on the measured percentage: A ≤1, B ≤10, C ≤30, D ≤60, else F.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| prettier | ok | [default-config] | 3.9.6 | — |
| ruff-format | ok | [default-config] | 0.16.1 | — |

Evidence: [raw/root/prettier.txt](raw/root/prettier.txt) · [raw/root/ruff-format.json](raw/root/ruff-format.json)

## test quality — not assessed

Not graded: not assessed — run `--deep`

---
