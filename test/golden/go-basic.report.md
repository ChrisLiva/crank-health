# Codebase health

`<repo>` @ `c6b2ce11ad8d7de03a6e6e6aa092c789e3b5d7d0` · crank-health 0.12.0 · quick profile

## Grades

| Category | Grade | Basis |
| --- | --- | --- |
| security | B — 1 graded finding | 1 graded finding (1 warning). |
| types | F — 5 weighted findings per 0.13 KLOC | 1 graded finding (1 error), weighted total 5 (error ×5, warning ×1, info ×0.2). |
| dead code | D — 1 weighted finding per 0.13 KLOC | 1 graded finding (1 warning), weighted total 1 (error ×5, warning ×1, info ×0.2). |
| complexity | D — 1 of 8 functions over cognitive complexity 15 | 1 of 8 functions over cognitive complexity 15 (12.5%). |
| duplication | D — 19.8% of tokens duplicated | 19.8% of tokens duplicated; the clone below is the evidence, not the grade. 1 advisory finding did not count toward the grade. |
| lint | D — 3 weighted findings per 0.13 KLOC | 3 graded findings (3 warning), weighted total 3 (error ×5, warning ×1, info ×0.2). |
| format | C — 1 of 7 files failing the formatter | 1 of 7 checked files fail the formatter (14.3%). |
| test quality | not assessed | not assessed — run `--deep` |

### Measurements

- Complexity: 1 of 8 functions over cognitive complexity 15 (12.5%).
- Duplication: 19.8% of tokens duplicated.
- Format: 7 files checked by a formatter.

## Projects

2 projects, each graded on its own files, its own toolchain and its own denominators; the grades above are the repo as a whole. A category marked `repo-scoped` is one a repo-spanning scan answered — secrets, dependency audits, workflow checks — so it is graded once, above, and not per project.

### repo root

`go.mod` · go

| Category | Grade | Basis |
| --- | --- | --- |
| security | B | 1 graded finding (1 warning). |
| types | A | Nothing counted toward the grade. |
| dead code | D | 1 graded finding (1 warning), weighted total 1 (error ×5, warning ×1, info ×0.2). |
| complexity | D | 1 of 7 functions over cognitive complexity 15 (14.3%). |
| duplication | D | 19.8% of tokens duplicated; the clone below is the evidence, not the grade. 1 advisory finding did not count toward the grade. |
| lint | D | 3 graded findings (3 warning), weighted total 3 (error ×5, warning ×1, info ×0.2). |
| format | C | 1 of 6 checked files fail the formatter (16.7%). |
| test quality | not assessed | not assessed — run `--deep` |

This project declares no tool of its own: it was analyzed on crank-health’s defaults.

### brokenpkg

`brokenpkg/go.mod` · go

| Category | Grade | Basis |
| --- | --- | --- |
| security | not assessed | repo-scoped |
| types | F | 1 graded finding (1 error), weighted total 5 (error ×5, warning ×1, info ×0.2). |
| dead code | A | Nothing counted toward the grade. |
| complexity | A | 0 of 1 function over cognitive complexity 15 (0.0%). |
| duplication | A | 0.0% of tokens duplicated. |
| lint | A | Nothing counted toward the grade. |
| format | A | 0 of 1 checked file fail the formatter (0.0%). |
| test quality | not assessed | not assessed — run `--deep` |

This project declares no tool of its own: it was analyzed on crank-health’s defaults.

## security — B

1 graded finding (1 warning).

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| bandit | not available | [default-config] | — (pinned 1.9.4) | no Python files, so bandit assessed nothing |
| gitleaks | not available | [default-config] | — (pinned 8.30.1) | gitleaks is not on PATH — install it (brew install gitleaks, or see https://github.com/gitleaks/gitleaks#installing) to assess this, or leave it out and the rest of the scan is unaffected |
| gosec | ok | [default-config] | v2.28.0 | (repo root) |
| gosec | error | [default-config] | — (pinned v2.28.0) | ./broken.go:5:9: cannot use "forty-two" (untyped string constant) as int value in return statement (brokenpkg) |
| govulncheck | ok | [default-config] | v1.7.0 | govulncheck analyzed nothing in brokenpkg (exit 1): govulncheck: loading packages:  |
| opengrep | not available | [default-config] | — (pinned 1.26.0) | no JavaScript, TypeScript or Python files, so opengrep assessed nothing |
| osv-scanner | not available | [default-config] | — (pinned 2.5.0) | osv-scanner is not on PATH — install it (brew install osv-scanner, or see https://google.github.io/osv-scanner/installation/) to assess this, or leave it out and the rest of the scan is unaffected |
| zizmor | not available | [default-config] | — (pinned 1.29.0) | no GitHub Actions workflows or composite actions, so zizmor assessed nothing |

**Findings** (1)

- warning `main.go:5` `G101` — Potential hardcoded credentials (high severity, low confidence) (gosec) [default-config]
  - fix: see https://cwe.mitre.org/data/definitions/798.html

Evidence: [raw/root/gosec.json](raw/root/gosec.json) · [raw/brokenpkg/gosec.json](raw/brokenpkg/gosec.json) · [raw/repo/govulncheck-brokenpkg.json](raw/repo/govulncheck-brokenpkg.json) · [raw/repo/govulncheck-brokenpkg.stderr.txt](raw/repo/govulncheck-brokenpkg.stderr.txt) · [raw/repo/govulncheck.json](raw/repo/govulncheck.json) · [raw/repo/govulncheck-vendor-example.com-dep.json](raw/repo/govulncheck-vendor-example.com-dep.json)

## types — F

1 graded finding (1 error), weighted total 5 (error ×5, warning ×1, info ×0.2).

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| staticcheck | ok | [default-config] | v0.8.1 | (repo root, brokenpkg) |

**Findings** (1)

- error `brokenpkg/broken.go:5` `compile` — cannot use "forty-two" (untyped string constant) as int value in return statement (staticcheck) [default-config]

Evidence: [raw/root/staticcheck.jsonl](raw/root/staticcheck.jsonl) · [raw/brokenpkg/staticcheck.jsonl](raw/brokenpkg/staticcheck.jsonl)

## dead code — D

1 graded finding (1 warning), weighted total 1 (error ×5, warning ×1, info ×0.2).

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| staticcheck | ok | [default-config] | v0.8.1 | (repo root, brokenpkg) |

**Findings** (1)

- warning `checks.go:12` `U1000` — func unusedHelper is unused (staticcheck) [default-config]

Evidence: [raw/root/staticcheck.jsonl](raw/root/staticcheck.jsonl) · [raw/brokenpkg/staticcheck.jsonl](raw/brokenpkg/staticcheck.jsonl)

## complexity — D

1 of 8 functions over cognitive complexity 15 (12.5%).

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| gocognit | ok | [default-config] | v1.2.1 | (repo root, brokenpkg) |

Evidence: [raw/root/gocognit.json](raw/root/gocognit.json) · [raw/brokenpkg/gocognit.json](raw/brokenpkg/gocognit.json)

## duplication — D

19.8% of tokens duplicated; the clone below is the evidence, not the grade. 1 advisory finding did not count toward the grade.

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| jscpd | ok | [default-config] | 5.0.15 | (repo root, brokenpkg) |

**Advisory findings** (1) — reported, not counted toward the grade: 1 × `jscpd` `jscpd/duplicate-block`.

- warning `dupe_a.go:4` `jscpd/duplicate-block` — 20 lines (85 tokens) duplicated from dupe_b.go:4-23 (jscpd) [default-config] [advisory]
  - fix: Extract the duplicated block into a shared function or module

Evidence: [raw/root/jscpd-report.json](raw/root/jscpd-report.json) · [raw/brokenpkg/jscpd-report.json](raw/brokenpkg/jscpd-report.json) · [raw/repo/jscpd-report.json](raw/repo/jscpd-report.json)

## lint — D

3 graded findings (3 warning), weighted total 3 (error ×5, warning ×1, info ×0.2).

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| aislop | ok | [default-config] | 0.14.1 | (repo root, brokenpkg) |
| go-vet | ok | [default-config] | — (pinned 1.25) | (repo root) |
| go-vet | error | [default-config] | — (pinned 1.25) | # example.com/go-basic/brokenpkg (brokenpkg) |
| staticcheck | ok | [default-config] | v0.8.1 | (repo root, brokenpkg) |

**Findings** (3)

- warning `checks.go:5` `S1002` — should omit comparison to bool constant, can be simplified to verbose (staticcheck) [default-config]
- warning `main.go:13` `SA5009` — Printf format %d has arg #1 of wrong type string (staticcheck) [default-config]
- warning `main.go:13` `printf` — fmt.Printf format %d has arg "not-an-int" of wrong type string (go-vet) [default-config]

Evidence: [raw/root/aislop.json](raw/root/aislop.json) · [raw/brokenpkg/aislop.json](raw/brokenpkg/aislop.json) · [raw/root/go-vet.json](raw/root/go-vet.json) · [raw/root/staticcheck.jsonl](raw/root/staticcheck.jsonl) · [raw/brokenpkg/staticcheck.jsonl](raw/brokenpkg/staticcheck.jsonl)

## format — C

1 of 7 checked files fail the formatter (14.3%).

| Tool | State | Config | Version | Notes |
| --- | --- | --- | --- | --- |
| gofmt | ok | [default-config] | — (pinned 1.25) | (repo root, brokenpkg) |

**Findings** (1)

- warning `unformatted.go` `gofmt/unformatted` — File does not match gofmt’s formatting (gofmt) [default-config]
  - fix: gofmt -w unformatted.go

Evidence: [raw/root/gofmt.txt](raw/root/gofmt.txt)

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
