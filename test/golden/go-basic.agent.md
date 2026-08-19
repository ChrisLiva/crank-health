# Fix plan

`<repo>` @ `c6b2ce11ad8d7de03a6e6e6aa092c789e3b5d7d0` · crank-health 0.10.0 · quick profile

Grades: security B · types F · dead code D · complexity D · duplication D · lint D · format C · test quality not assessed

## Ground rules

- Findings marked [advisory] did not count toward the grade. Fix one only when the fix is obvious and behaviour-preserving.
- Change only what a task asks for. No wholesale reformatting, renaming or restructuring — a sweep hides the fix inside it.
- Suppressing a finding (disable comment, `any`, ignore entry) is not fixing it. If a rule is wrong for this repo, change the repo’s config and say so.
- Verify before you call a task done: run its Verify command and read the grade it prints.
- A task’s grade impact is its whole category: `security · F → A` means security reaches A once every security task is done, not this one alone.

## Tasks

### T1 — Fix 1 `compile` type error

Project: brokenpkg

Grade impact: types · F → A

- `brokenpkg/broken.go:5` `compile` — cannot use "forty-two" (untyped string constant) as int value in return statement

Evidence: [raw/brokenpkg/staticcheck.jsonl](raw/brokenpkg/staticcheck.jsonl)

Verify: `npx crank-health --only types --project brokenpkg --fail-under A`

### T2 — Remove 1 U1000

Project: repo root

Grade impact: dead code · D → A

- `checks.go:12` `U1000` — func unusedHelper is unused

Evidence: [raw/root/staticcheck.jsonl](raw/root/staticcheck.jsonl)

Verify: `npx crank-health --only dead-code --project . --fail-under A`

### T3 — De-duplicate 1 copied block

Project: repo root

Grade impact: duplication · D → A

- `dupe_a.go:4` `jscpd/duplicate-block` — 20 lines (85 tokens) duplicated from dupe_b.go:4-23 [advisory]

Evidence: [raw/repo/jscpd-report.json](raw/repo/jscpd-report.json) · [raw/root/jscpd-report.json](raw/root/jscpd-report.json)

Verify: `npx crank-health --only duplication --project . --fail-under A`

### T4 — Format 1 file

Project: repo root

Grade impact: format · C → A

- `unformatted.go` `gofmt/unformatted` — File does not match gofmt’s formatting

Evidence: [raw/root/gofmt.txt](raw/root/gofmt.txt)

Verify: `npx crank-health --only format --project . --fail-under A`

### T5 — Fix 1 `G101` finding reported by gosec

Project: repo root

Grade impact: security · B → A

- `main.go:5` `G101` — Potential hardcoded credentials (high severity, low confidence)

Evidence: [raw/root/gosec.json](raw/root/gosec.json)

Verify: `npx crank-health --only security --fail-under A`

### T6 — Fix 1 `S1002` finding

Project: repo root

Grade impact: lint · D → A

- `checks.go:5` `S1002` — should omit comparison to bool constant, can be simplified to verbose

Evidence: [raw/root/staticcheck.jsonl](raw/root/staticcheck.jsonl)

Verify: `npx crank-health --only lint --project . --fail-under A`

### T7 — Fix 1 `SA5009` finding

Project: repo root

Grade impact: lint · D → A

- `main.go:13` `SA5009` — Printf format %d has arg #1 of wrong type string

Evidence: [raw/root/staticcheck.jsonl](raw/root/staticcheck.jsonl)

Verify: `npx crank-health --only lint --project . --fail-under A`

### T8 — Fix 1 `printf` finding

Project: repo root

Grade impact: lint · D → A

- `main.go:13` `printf` — fmt.Printf format %d has arg "not-an-int" of wrong type string

Evidence: [raw/root/go-vet.json](raw/root/go-vet.json)

Verify: `npx crank-health --only lint --project . --fail-under A`

---

Full findings (8) and every tool’s state: [report.json](report.json). Raw tool output: [raw/](raw/).
