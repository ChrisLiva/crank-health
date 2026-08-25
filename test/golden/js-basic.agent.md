# Fix plan

`<repo>` @ `7884bf13b6a45757e42ccadd6d59cf21fd559a20` · crank-health 0.12.0 · quick profile

Grades: security not assessed · types not assessed · dead code D · complexity D · duplication A · lint F · format C · test quality not assessed

## Ground rules

- Findings marked [advisory] did not count toward the grade. Fix one only when the fix is obvious and behaviour-preserving.
- Change only what a task asks for. No wholesale reformatting, renaming or restructuring — a sweep hides the fix inside it.
- Suppressing a finding (disable comment, `any`, ignore entry) is not fixing it. If a rule is wrong for this repo, change the repo’s config and say so.
- Verify before you call a task done: run its Verify command and read the grade it prints.
- A task’s grade impact is its whole category: `security · F → A` means security reaches A once every security task is done, not this one alone.

## Tasks

### T1 — Remove 1 unused export

Grade impact: dead code · D → A

- `src/clean.js:5` `fallow/unused-export` — Export `subtract` is never used

Evidence: [raw/root/fallow-dead-code.json](raw/root/fallow-dead-code.json) · [raw/root/fallow-dead-code.stderr.txt](raw/root/fallow-dead-code.stderr.txt)

Verify: `npx crank-health --only dead-code --fail-under A`

### T2 — Reduce the complexity of 1 function

Grade impact: complexity · D → A

- `src/complex.js:1` `fallow/complexity` — Function `classify` has cognitive complexity 29 (cyclomatic 18); the ceiling is 15

Evidence: [raw/root/fallow-health.json](raw/root/fallow-health.json) · [raw/root/fallow-health.stderr.txt](raw/root/fallow-health.stderr.txt)

Verify: `npx crank-health --only complexity --fail-under A`

### T3 — Format 1 file

Grade impact: format · C → A

- `src/unformatted.js` `prettier/format` — File does not match prettier’s default formatting

Evidence: [raw/root/prettier.txt](raw/root/prettier.txt)

Verify: `npx crank-health --only format --fail-under A`

### T4 — Fix 1 `eslint(no-const-assign)` finding

Grade impact: lint · F → A

- `src/const-assign.js:2` `eslint(no-const-assign)` — Unexpected re-assignment of `const` variable limit.

Evidence: [raw/root/oxlint.sarif.json](raw/root/oxlint.sarif.json)

Verify: `npx crank-health --only lint --fail-under A`

### T5 — Fix 1 `eslint(no-dupe-keys)` finding

Grade impact: lint · F → A

- `src/dupe-keys.js:2` `eslint(no-dupe-keys)` — Duplicate key 'home'

Evidence: [raw/root/oxlint.sarif.json](raw/root/oxlint.sarif.json)

Verify: `npx crank-health --only lint --fail-under A`

### T6 — Fix 1 `eslint(no-unreachable)` finding

Grade impact: lint · F → A

- `src/unreachable.js:6` `eslint(no-unreachable)` — Unreachable code.

Evidence: [raw/root/oxlint.sarif.json](raw/root/oxlint.sarif.json)

Verify: `npx crank-health --only lint --fail-under A`

---

Full findings (7) and every tool’s state: [report.json](report.json). Raw tool output: [raw/](raw/).
