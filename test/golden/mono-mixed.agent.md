# Fix plan

`<repo>` @ `f389aa7331d4f802ed030124af51109abf22c9d6` · crank-health 0.15.1 · quick profile

Grades: security A · types F · dead code A · complexity A · duplication A · lint F · format A · test quality not assessed

## Ground rules

- Findings marked [advisory] did not count toward the grade. Fix one only when the fix is obvious and behaviour-preserving.
- A file row reading `(2 findings, 9 uncounted)` has 9 rows this task’s own count leaves out. They are in `report.json`, and they are not what the task is measured on.
- Change only what a task asks for. No wholesale reformatting, renaming or restructuring — a sweep hides the fix inside it.
- Suppressing a finding (disable comment, `any`, ignore entry) is not fixing it. If a rule is wrong for this repo, change the repo’s config and say so.
- Verify before you call a task done: run its Verify command and read the grade it prints.
- A task’s grade impact is its whole category: `security · F → A` means security reaches A once every security task is done, not this one alone. `lint · already A` is work the letter does not depend on.

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
