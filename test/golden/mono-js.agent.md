# Fix plan

`<repo>` @ `acbb91a96406d62565ed52fa2009a8581e16b023` · crank-health 0.8.0 · quick profile

Grades: security not assessed · types not assessed · dead code A · complexity A · duplication D · lint D · format B · test quality not assessed

> How this run was graded: scan scope: 1 file under a hidden directory was not analyzed by language tools; repo-scoped scanners (gitleaks, osv-scanner) scan the full tree

## Ground rules

- Findings marked [advisory] did not count toward the grade. Fix one only when the fix is obvious and behaviour-preserving.
- Change only what a task asks for. No wholesale reformatting, renaming or restructuring — a sweep hides the fix inside it.
- Suppressing a finding (disable comment, `any`, ignore entry) is not fixing it. If a rule is wrong for this repo, change the repo’s config and say so.
- Verify before you call a task done: run its Verify command and read the grade it prints.
- A task’s grade impact is its whole category: `security · F → A` means security reaches A once every security task is done, not this one alone.

## Tasks

### T1 — Fix 1 `eslint(no-const-assign)` finding

Project: packages/api

Grade impact: lint · F → A

- `packages/api/src/const-assign.js:2` `eslint(no-const-assign)` — Unexpected re-assignment of `const` variable limit.

Evidence: [raw/packages/api/oxlint.sarif.json](raw/packages/api/oxlint.sarif.json)

Verify: `npx crank-health --only lint --project packages/api --fail-under A`

### T2 — Fix 1 `no-unused-vars` finding

Project: packages/web

Grade impact: lint · D → A

- `packages/web/src/lint.js:2` `no-unused-vars` — 'unused' is assigned a value but never used.

Evidence: [raw/packages/web/eslint.json](raw/packages/web/eslint.json)

Verify: `npx crank-health --only lint --project packages/web --fail-under A`

### T3 — Format 1 file

Project: packages/api

Grade impact: format · C → A

- `packages/api/src/unformatted.js` `prettier/format` — File does not match the repo’s prettier configuration

Evidence: [raw/packages/api/prettier.txt](raw/packages/api/prettier.txt)

Verify: `npx crank-health --only format --project packages/api --fail-under A`

---

Full findings (10) and every tool’s state: [report.json](report.json). Raw tool output: [raw/](raw/).
