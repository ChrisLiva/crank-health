# Fix plan

`<repo>` @ `<sha>` · crank-health 0.15.1 · quick profile · PR vs `main` (merge-base `<short>`)

Grades: security not assessed · types not assessed · dead code not assessed · complexity not assessed · duplication not assessed · lint F · format not assessed · test quality not assessed

This change: 1 new finding (1 on lines it touched), 1 resolved, 1 unchanged.

## Ground rules

- Findings marked [advisory] did not count toward the grade. Fix one only when the fix is obvious and behaviour-preserving.
- A file row reading `(2 findings, 9 uncounted)` has 9 rows this task’s own count leaves out. They are in `report.json`, and they are not what the task is measured on.
- Change only what a task asks for. No wholesale reformatting, renaming or restructuring — a sweep hides the fix inside it.
- Suppressing a finding (disable comment, `any`, ignore entry) is not fixing it. If a rule is wrong for this repo, change the repo’s config and say so.
- Verify before you call a task done: run its Verify command and read the grade it prints.
- A task’s grade impact is its whole category: `security · F → A` means security reaches A once every security task is done, not this one alone.
- This is a PR delta: the tasks below are what *this change* introduced. Findings that were already there are not yours to fix here.
- Findings marked [in-diff] are on lines this change touched — fix those first. A new finding without the marker was caused from elsewhere in the change; it is still a regression.

## Tasks

### T1 — Fix 1 `eslint(no-unreachable)` finding [in-diff]

Grade impact: lint · F → A

- `src/clean.js:3` `eslint(no-unreachable)` — Unreachable code. [in-diff]

Evidence: [raw/root/oxlint.sarif.json](raw/root/oxlint.sarif.json)

Verify: `npx crank-health --only lint --fail-under A`

## Resolved by this change (1)

Context only — nothing to do here.

- `src/fixed.js:2` `eslint(no-const-assign)` — Unexpected re-assignment of `const` variable limit.

---

Full findings (2) and every tool’s state: [report.json](report.json). Raw tool output: [raw/](raw/).
