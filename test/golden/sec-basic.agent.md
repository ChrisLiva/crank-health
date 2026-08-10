# Fix plan

`<repo>` @ `1cb090abdb6af232c7f51dac1b38b5ec22c2e25f` · crank-health 0.4.0 · quick profile

Grades: security D · types A · dead code A · complexity A · duplication F · lint F · format A · test quality not assessed

## Ground rules

- Findings marked [advisory] did not count toward the grade. Fix one only when the fix is obvious and behaviour-preserving.
- Change only what a task asks for. No wholesale reformatting, renaming or restructuring — a sweep hides the fix inside it.
- Suppressing a finding (disable comment, `any`, ignore entry) is not fixing it. If a rule is wrong for this repo, change the repo’s config and say so.
- Verify before you call a task done: run its Verify command and read the grade it prints.
- A task’s grade impact is its whole category: `security · F → A` means security reaches A once every security task is done, not this one alone.

## Tasks

### T1 — Fix 1 `B602` finding reported by bandit

Grade impact: security · D → A

- `src/config.py:13` `B602` — subprocess call with shell=True identified, security issue. (high severity, high confidence)

Evidence: [raw/root/bandit.json](raw/root/bandit.json)

Verify: `npx crank-health --only security --fail-under A`

### T2 — Fix 1 `dangerous-triggers` finding reported by zizmor

Grade impact: security · D → A

- `.github/workflows/ci.yml:2` `dangerous-triggers` — Use of fundamentally insecure workflow trigger — pull_request_target is almost always used insecurely (high severity, medium confidence)

Evidence: [raw/repo/zizmor.json](raw/repo/zizmor.json) · [raw/repo/zizmor.stderr.txt](raw/repo/zizmor.stderr.txt)

Verify: `npx crank-health --only security --fail-under A`

### T3 — Fix 1 `artipacked` finding reported by zizmor

Grade impact: security · D → A

- `.github/workflows/ci.yml:8` `artipacked` — Credential persistence through GitHub Actions artifacts — does not set persist-credentials: false (medium severity, low confidence)

Evidence: [raw/repo/zizmor.json](raw/repo/zizmor.json) · [raw/repo/zizmor.stderr.txt](raw/repo/zizmor.stderr.txt)

Verify: `npx crank-health --only security --fail-under A`

### T4 — Fix 1 `excessive-permissions` finding reported by zizmor

Grade impact: security · D → A

- `.github/workflows/ci.yml:5` `excessive-permissions` — Overly broad permissions — default permissions used due to no permissions: block (medium severity, medium confidence)

Evidence: [raw/repo/zizmor.json](raw/repo/zizmor.json) · [raw/repo/zizmor.stderr.txt](raw/repo/zizmor.stderr.txt)

Verify: `npx crank-health --only security --fail-under A`

### T5 — Fix 1 `unpinned-uses` finding reported by zizmor

Grade impact: security · D → A

- `.github/workflows/ci.yml:8` `unpinned-uses` — Unpinned action reference — action is not pinned to a hash (required by blanket policy) (high severity, high confidence)

Evidence: [raw/repo/zizmor.json](raw/repo/zizmor.json) · [raw/repo/zizmor.stderr.txt](raw/repo/zizmor.stderr.txt)

Verify: `npx crank-health --only security --fail-under A`

### T6 — Fix 1 `B404` finding reported by bandit

Grade impact: security · D → A

- `src/config.py:3` `B404` — Consider possible security implications associated with the subprocess module. (low severity, high confidence) [advisory]

Evidence: [raw/root/bandit.json](raw/root/bandit.json)

Verify: `npx crank-health --only security --fail-under A`

### T7 — De-duplicate 2 copied blocks

Grade impact: duplication · F → A

- `src/handler.js:5` `jscpd/duplicate-block` — 11 lines (111 tokens) duplicated from src/report.js:1-11 [advisory]
- `src/report.js:1` `jscpd/duplicate-block` — 11 lines (111 tokens) duplicated from src/handler.js:5-15 [advisory]

Evidence: [raw/root/jscpd-report.json](raw/root/jscpd-report.json)

Verify: `npx crank-health --only duplication --fail-under A`

### T8 — Fix 1 `eslint(no-eval)` finding

Grade impact: lint · F → A

- `src/handler.js:2` `eslint(no-eval)` — eval can be harmful.

Evidence: [raw/root/oxlint.sarif.json](raw/root/oxlint.sarif.json)

Verify: `npx crank-health --only lint --fail-under A`

---

Full findings (11) and every tool’s state: [report.json](report.json). Raw tool output: [raw/](raw/).
