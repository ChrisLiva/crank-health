# Fix plan

`<repo>` @ `1624281eaabc18eb08af09502955981d65aa1ca4` · crank-health 0.10.0 · quick profile

Grades: security not assessed · types not assessed · dead code not assessed · complexity not assessed · duplication D · lint not assessed · format C · test quality not assessed

## Ground rules

- Findings marked [advisory] did not count toward the grade. Fix one only when the fix is obvious and behaviour-preserving.
- Change only what a task asks for. No wholesale reformatting, renaming or restructuring — a sweep hides the fix inside it.
- Suppressing a finding (disable comment, `any`, ignore entry) is not fixing it. If a rule is wrong for this repo, change the repo’s config and say so.
- Verify before you call a task done: run its Verify command and read the grade it prints.
- A task’s grade impact is its whole category: `security · F → A` means security reaches A once every security task is done, not this one alone.

## Tasks

### T1 — De-duplicate 1 copied block

Grade impact: duplication · D → A

- `dupe-a.cs:4` `jscpd/duplicate-block` — 30 lines (100 tokens) duplicated from dupe-b.cs:4-33 [advisory]

Evidence: [raw/root/jscpd-report.json](raw/root/jscpd-report.json)

Verify: `npx crank-health --only duplication --fail-under A`

### T2 — Format 1 file

Grade impact: format · C → A

- `unformatted.cs` `dotnet-format/whitespace` — File does not match the repo’s .editorconfig whitespace conventions

Evidence: [raw/root/dotnet-format.json](raw/root/dotnet-format.json)

Verify: `npx crank-health --only format --fail-under A`

---

Full findings (2) and every tool’s state: [report.json](report.json). Raw tool output: [raw/](raw/).
