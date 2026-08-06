# Fix plan

`<repo>` @ `7efc798a8272cfcfaa35d9bb77747075e07febd6` · crank-health 0.3.0 · quick profile

Grades: security not assessed · types not assessed · dead code A · complexity A · duplication F · lint F · format C · test quality not assessed

## Ground rules

- Findings marked [advisory] did not count toward the grade. Fix one only when the fix is obvious and behaviour-preserving.
- Change only what a task asks for. No wholesale reformatting, renaming or restructuring — a sweep hides the fix inside it.
- Suppressing a finding (disable comment, `any`, ignore entry) is not fixing it. If a rule is wrong for this repo, change the repo’s config and say so.
- Verify before you call a task done: run its Verify command and read the grade it prints.
- A task’s grade impact is its whole category: `security · F → A` means security reaches A once every security task is done, not this one alone.

## Tasks

### T1 — De-duplicate 1 copied block

Project: packages/api

Grade impact: duplication · A → A

- `packages/api/src/shared.js:1` `jscpd/duplicate-block` — 11 lines (124 tokens) duplicated from packages/web/src/shared.js:1-11 [advisory]

Evidence: [raw/packages/api/jscpd-report.json](raw/packages/api/jscpd-report.json)

Verify: `npx crank-health --only duplication --project packages/api --fail-under A`

### T2 — De-duplicate 1 copied block

Project: packages/web

Grade impact: duplication · A → A

- `packages/web/src/shared.js:1` `jscpd/duplicate-block` — 11 lines (124 tokens) duplicated from packages/api/src/shared.js:1-11 [advisory]

Evidence: [raw/packages/web/jscpd-report.json](raw/packages/web/jscpd-report.json)

Verify: `npx crank-health --only duplication --project packages/web --fail-under A`

### T3 — Fix 1 `eslint(no-const-assign)` finding

Project: packages/api

Grade impact: lint · F → A

- `packages/api/src/const-assign.js:2` `eslint(no-const-assign)` — Unexpected re-assignment of `const` variable limit.

Evidence: [raw/packages/api/oxlint.sarif.json](raw/packages/api/oxlint.sarif.json)

Verify: `npx crank-health --only lint --project packages/api --fail-under A`

### T4 — Fix 1 `no-unused-vars` finding

Project: packages/web

Grade impact: lint · F → A

- `packages/web/src/lint.js:2` `no-unused-vars` — 'unused' is assigned a value but never used.

Evidence: [raw/packages/web/eslint.json](raw/packages/web/eslint.json)

Verify: `npx crank-health --only lint --project packages/web --fail-under A`

### T5 — Format 1 file

Project: packages/api

Grade impact: format · C → A

- `packages/api/src/unformatted.js` `prettier/format` — File does not match the repo’s prettier configuration

Evidence: [raw/packages/api/prettier.txt](raw/packages/api/prettier.txt)

Verify: `npx crank-health --only format --project packages/api --fail-under A`

---

Full findings (5) and every tool’s state: [report.json](report.json). Raw tool output: [raw/](raw/).
