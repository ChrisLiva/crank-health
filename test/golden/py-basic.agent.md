# Fix plan

`<repo>` @ `b56bfa4385957a69ba6c188096dd29abd4eecf1b` · crank-health 0.4.0 · quick profile

Grades: security A · types F · dead code F · complexity D · duplication A · lint F · format C · test quality not assessed

## Ground rules

- Findings marked [advisory] did not count toward the grade. Fix one only when the fix is obvious and behaviour-preserving.
- Change only what a task asks for. No wholesale reformatting, renaming or restructuring — a sweep hides the fix inside it.
- Suppressing a finding (disable comment, `any`, ignore entry) is not fixing it. If a rule is wrong for this repo, change the repo’s config and say so.
- Verify before you call a task done: run its Verify command and read the grade it prints.
- A task’s grade impact is its whole category: `security · F → A` means security reaches A once every security task is done, not this one alone.

## Tasks

### T1 — Fix 1 `unresolved-reference` type error

Grade impact: types · F → A

- `undefined_name.py:2` `unresolved-reference` — Name `missing_name` used when not defined

Evidence: [raw/root/ty.gitlab.json](raw/root/ty.gitlab.json)

Verify: `npx crank-health --only types --fail-under A`

### T2 — Remove 1 unused import

Grade impact: dead code · F → A

- `dead.py` `vulture/unused-import` — Unused import `os` (90% confidence)

Evidence: [raw/root/vulture.txt](raw/root/vulture.txt)

### T3 — Remove 1 unused function

- `dead.py:8` `vulture/unused-function` — Unused function `never_called` (60% confidence) [advisory]

Evidence: [raw/root/vulture.txt](raw/root/vulture.txt)

Verify: `npx crank-health --only dead-code --fail-under A`

### T4 — Reduce the complexity of 1 function

Grade impact: complexity · D → A

- `complex.py:1` `complexipy/cognitive-complexity` — Function 'classify' has a cognitive complexity of 38, which exceeds the maximum allowed complexity of 15.

Evidence: [raw/root/complexipy.json](raw/root/complexipy.json) · [raw/root/complexipy.sarif.json](raw/root/complexipy.sarif.json)

Verify: `npx crank-health --only complexity --fail-under A`

### T5 — Fix 1 `F821` finding

Grade impact: lint · F → A

- `undefined_name.py:2` `F821` — Undefined name `missing_name`

Evidence: [raw/root/ruff-lint.json](raw/root/ruff-lint.json)

### T6 — Fix 1 `F401` finding

- `dead.py:1` `F401` — `os` imported but unused

Evidence: [raw/root/ruff-lint.json](raw/root/ruff-lint.json)

Verify: `npx crank-health --only lint --fail-under A`

### T7 — Format 1 file

Grade impact: format · C → A

- `unformatted.py` `ruff/format` — File does not match ruff’s default formatting

Evidence: [raw/root/ruff-format.json](raw/root/ruff-format.json)

Verify: `npx crank-health --only format --fail-under A`

---

Full findings (7) and every tool’s state: [report.json](report.json). Raw tool output: [raw/](raw/).
