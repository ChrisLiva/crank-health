# Codebase health

`<repo>` @ `1624281eaabc18eb08af09502955981d65aa1ca4` · crank-health 0.9.0 · quick profile

## Grades

| Category | Grade | Basis |
| --- | --- | --- |
| security | not assessed | gitleaks is not on PATH — install it (brew install gitleaks, or see https://github.com/gitleaks/gitleaks#installing) to assess this, or leave it out and the rest of the scan is unaffected; no JavaScript, TypeScript or Python files, so opengrep assessed nothing; no GitHub Actions workflows or composite actions, so zizmor assessed nothing; no Python files, so bandit assessed nothing; osv-scanner is not on PATH — install it (brew install osv-scanner, or see https://google.github.io/osv-scanner/installation/) to assess this, or leave it out and the rest of the scan is unaffected; no go.mod in this repo, so govulncheck assessed no Go dependencies |
| types | not assessed | not assessed — run `--deep` |
| dead code | not assessed | not assessed — run `--deep` |
| complexity | not assessed | not assessed — run `--deep` |
| duplication | D — 18.4% of tokens duplicated | 18.4% of tokens duplicated; the clone below is the evidence, not the grade. 1 advisory finding did not count toward the grade. |
| lint | not assessed | not assessed — run `--deep` |
| format | C — 1 of 8 files failing the formatter | 1 of 8 checked files fail the formatter (12.5%). |
| test quality | not assessed | not assessed — run `--deep` |

### Measurements

- Duplication: 18.4% of tokens duplicated.
- Format: 8 files checked by a formatter.

## security — not assessed

Not graded: gitleaks is not on PATH — install it (brew install gitleaks, or see https://github.com/gitleaks/gitleaks#installing) to assess this, or leave it out and the rest of the scan is unaffected; no JavaScript, TypeScript or Python files, so opengrep assessed nothing; no GitHub Actions workflows or composite actions, so zizmor assessed nothing; no Python files, so bandit assessed nothing; osv-scanner is not on PATH — install it (brew install osv-scanner, or see https://google.github.io/osv-scanner/installation/) to assess this, or leave it out and the rest of the scan is unaffected; no go.mod in this repo, so govulncheck assessed no Go dependencies

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| bandit | not available | [default-config] | — (pinned 1.9.4) | no Python files, so bandit assessed nothing |
| gitleaks | not available | [default-config] | — (pinned 8.30.1) | gitleaks is not on PATH — install it (brew install gitleaks, or see https://github.com/gitleaks/gitleaks#installing) to assess this, or leave it out and the rest of the scan is unaffected |
| govulncheck | not available | [default-config] | — (pinned v1.7.0) | no go.mod in this repo, so govulncheck assessed no Go dependencies |
| opengrep | not available | [default-config] | — (pinned 1.26.0) | no JavaScript, TypeScript or Python files, so opengrep assessed nothing |
| osv-scanner | not available | [default-config] | — (pinned 2.4.0) | osv-scanner is not on PATH — install it (brew install osv-scanner, or see https://google.github.io/osv-scanner/installation/) to assess this, or leave it out and the rest of the scan is unaffected |
| zizmor | not available | [default-config] | — (pinned 1.29.0) | no GitHub Actions workflows or composite actions, so zizmor assessed nothing |

## types — not assessed

Not graded: not assessed — run `--deep`

## dead code — not assessed

Not graded: not assessed — run `--deep`

## complexity — not assessed

Not graded: not assessed — run `--deep`

## duplication — D

18.4% of tokens duplicated; the clone below is the evidence, not the grade. 1 advisory finding did not count toward the grade.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| jscpd | ok | [default-config] | 5.0.14 | — |

**Advisory findings** (1) — reported, not counted toward the grade: 1 × `jscpd` `jscpd/duplicate-block`.

- warning `dupe-a.cs:4` `jscpd/duplicate-block` — 30 lines (100 tokens) duplicated from dupe-b.cs:4-33 (jscpd) [default-config] [advisory]
  - fix: Extract the duplicated block into a shared function or module

Evidence: [raw/root/jscpd-report.json](raw/root/jscpd-report.json)

## lint — not assessed

Not graded: not assessed — run `--deep`

## format — C

1 of 8 checked files fail the formatter (12.5%).

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| dotnet-format | ok | [repo-config] | — (pinned 10.0.203) | — |

**Findings** (1)

- warning `unformatted.cs` `dotnet-format/whitespace` — File does not match the repo’s .editorconfig whitespace conventions (dotnet-format) [repo-config]
  - fix: dotnet format whitespace . --folder --include <file>

Evidence: [raw/root/dotnet-format.json](raw/root/dotnet-format.json)

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
