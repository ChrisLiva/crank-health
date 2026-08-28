# Fix plan

`<repo>` @ `1e84ef63f0b7067eb8e22569987523f55a14d47c` · crank-health 0.15.0 · quick profile

Grades: security A · types F · dead code A · complexity A · duplication A · lint F · format A · test quality not assessed

## Ground rules

- Findings marked [advisory] did not count toward the grade. Fix one only when the fix is obvious and behaviour-preserving.
- Change only what a task asks for. No wholesale reformatting, renaming or restructuring — a sweep hides the fix inside it.
- Suppressing a finding (disable comment, `any`, ignore entry) is not fixing it. If a rule is wrong for this repo, change the repo’s config and say so.
- Verify before you call a task done: run its Verify command and read the grade it prints.
- A task’s grade impact is its whole category: `security · F → A` means security reaches A once every security task is done, not this one alone.

## Tasks

### T1 — Fix 1 `unresolved-reference` type error, and 1 finding in lint at the same place

Project: services/api

Grade impact: types · F → A

- `services/api/greet.py:2` `unresolved-reference` — Name `missing_name` used when not defined
- `services/api/greet.py:2` `F821` — Undefined name `missing_name`

Evidence: [raw/services/api/ruff-lint.json](raw/services/api/ruff-lint.json) · [raw/services/api/ty.gitlab.json](raw/services/api/ty.gitlab.json)

Verify: `npx crank-health --only types --project services/api --fail-under A`

### T2 — Fix 1 `eslint(no-dupe-keys)` finding

Project: services/web

Grade impact: lint · F → A

- `services/web/src/dupe-keys.js:2` `eslint(no-dupe-keys)` — Duplicate key 'home'

Evidence: [raw/services/web/oxlint.sarif.json](raw/services/web/oxlint.sarif.json)

Verify: `npx crank-health --only lint --project services/web --fail-under A`

---

Full findings (3) and every tool’s state: [report.json](report.json). Raw tool output: [raw/](raw/).
