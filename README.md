# crank-health

Deterministic codebase health grades for JS/TS and Python repos.

`crank-health` runs a fixed set of best-in-class analyzers against a repo — whole-repo or
PR-vs-base — and reports one A–F grade per category, per project in a monorepo plus a whole-repo
rollup, along with an action-ordered report for people and one for coding agents. It installs nothing into the target, writes nothing outside its own
output directory, and produces the same bytes for the same commit.

```
npx crank-health
```

```
crank-health 0.2.0 · /path/to/repo @ 9676d651 · quick

  security      A             no findings
  types         F             1 graded finding
  dead code     A             no findings
  complexity    A             no findings
  duplication   A             no findings
  lint          F             2 graded findings
  format        D             2 graded findings
  test quality  not assessed  not assessed — run `--deep`
```

## Quickstart

```sh
npx crank-health              # quick scan of the current repo
npx crank-health ../other     # …of another checkout
npx crank-health --pr main    # only what this branch changed, vs merge-base with main
npx crank-health --deep       # add the mutation-testing tier
npx crank-health -i           # pick all of the above through guided prompts
```

Requires Node ≥ 20 and `git`. Python analysis additionally requires [`uv`](https://docs.astral.sh/uv/)
on `PATH`; without it the Python categories degrade with an install hint and the rest of the scan
is unaffected.

### Options

| Flag                        | Effect                                                                    |
| --------------------------- | ------------------------------------------------------------------------- |
| `--pr <base>`               | Two-scan delta against `git merge-base <base> HEAD`                       |
| `--project <path>`          | Scope per-project analysis to `<path>`; repeatable (default: every one)   |
| `--deep`                    | Add the mutation-testing / test-suite tier                                |
| `--out <dir>`               | Output directory (default: a dated run dir in `<path>/.codebase-health/`) |
| `--only <cats>`             | Subset, e.g. `--only lint,types,security`                                 |
| `--fail-under <B>`          | Exit 1 if any selected category grades below `B`                          |
| `--allow-missing`           | Not-assessed categories do not trip that gate                             |
| `--json`                    | Print `report.json` to stdout instead of the terminal summary             |
| `--timeout <secs>`          | Per-tool budget for the quick tier (default 120 s)                        |
| `-i`, `--interactive`       | Choose options through guided prompts tailored to the repo                |
| `-h`, `--help`, `--version` |                                                                           |

`--interactive` first probes the target the same way detection does — read-only, no tool ever
executes — and tailors the questions to what it finds: the discovered projects are listed up front, a
PR delta is only offered against branches that actually share history with `HEAD`, the deep tier says
whether a repo-owned mutation tool exists to grade test quality, and a quick-mode gate defaults to
`--allow-missing` so the always-unassessed test-quality category doesn't trip it. When the security
category is selected, the session also shows which of the release-binary security tools (gitleaks,
opengrep, osv-scanner) are on `PATH` and — where Homebrew is available — offers to install the
missing ones, one confirmation per tool; declining leaves the scan to degrade exactly as before.
Flags passed alongside `-i` become the prompts' defaults, and the session ends by printing the
equivalent one-shot command before running (or not — declining just prints the command and exits 0).

### Exit codes

| Code | Meaning                                                                             |
| ---- | ----------------------------------------------------------------------------------- |
| `0`  | Scan completed. Findings never fail a plain run.                                    |
| `1`  | `--fail-under` tripped.                                                             |
| `2`  | crank-health itself errored (bad arguments, not a git repo, unwritable output dir). |

`--fail-under` trips on **any scanned project or the rollup** grading below the threshold — a small
failing package must not hide behind a large healthy one — and the message names the project
(`packages/small lint F`). It treats a not-assessed or errored category as a failure too, since a
missing signal is not a passing one, unless `--allow-missing` is given. Categories excluded by
`--only` are never selected and never trip it, and a project's `not-assessed(repo-scoped)` never
does: that category was answered for the repo, and the repo's answer is gated in the rollup.

## Categories and tools

Eight categories. 23 analyzers run in the quick profile, 3 more in `--deep`.

| Category                | JS/TS                             | Python                                                    | Both                                       |
| ----------------------- | --------------------------------- | --------------------------------------------------------- | ------------------------------------------ |
| Lint                    | oxlint (default) · ESLint · Biome | `ruff check`                                              |                                            |
| Format                  | Prettier (default) · Biome        | `ruff format --check`                                     |                                            |
| Types                   | tsc                               | ty → Pyright when a virtualenv exists · mypy (repo-owned) |                                            |
| Dead code               | fallow · knip                     | vulture (≥90% confidence graded, 60% advisory)            |                                            |
| Complexity              | fallow health · fta               | complexipy                                                |                                            |
| Duplication             |                                   |                                                           | jscpd                                      |
| Security                |                                   | bandit · ruff `S` rules                                   | gitleaks · opengrep · zizmor · osv-scanner |
| Test quality (`--deep`) | StrykerJS                         | cosmic-ray · coverage.py (context only)                   |                                            |

When several tools cover one category they all run and their findings merge; the tool is part of
each finding's identity, so two tools flagging the same line are two findings.

## Provenance: your config, or ours

Detection comes first. A category is **repo-owned** when the repo has a config artifact for a tool
(`eslint.config.*`, `biome.json`, `.prettierrc*`, `tsconfig.json`, `pyproject.toml` `[tool.*]`,
`knip.json`, …) or declares the dependency. `package.json` scripts corroborate but never decide
alone.

- **Owned and installed** → crank-health runs _your_ binary with _your_ config.
- **Owned but not installed** → the pinned version of the same tool runs, honoring your config.
- **Not owned** → crank-health's own pinned default tool runs against a bundled config kept in a
  temp directory, and only correctness-class rules count toward the grade. Style and pedantic
  findings are still reported, marked `[advisory]`.
- **Owned, not installed, and never imposed on you** (ESLint, Biome, mypy) → the owner claims the
  category but might never manage to speak, so our default runs behind it as a **standby** instead
  of standing aside — counted only if no owner graded the category. A standby exists only where
  crank-health has a default of its own, which today means lint, format and types.

Every finding carries `provenance: "repo-config" | "default-config"` and a `gradeScope` flag, and
when a default tool steps aside for a repo-owned one, `report.json` records that it did.

## Monorepos

Discovery partitions the repo into **projects**: every directory holding a `package.json` or a
`pyproject.toml` is a candidate, and each file belongs to the nearest one above it, so every source
file is graded exactly once. A root that keeps no source of its own is a workspace shell rather than
a project — recorded as `rootShell` in `report.json`, not graded as eight empty categories.
Workspace globs (npm/pnpm/yarn/uv) corroborate that classification and never decide which projects
exist, so an unlisted or unbuilt package is still scanned. There is no mode flag: one project
behaves exactly as it always has, and more than one produces per-project output automatically.

Each project is detected, run and graded on its own terms — its own config, its own installed
binaries, its own KLOC and file-count denominators — with ownership inheriting from ancestors, so a
tool hoisted to the workspace root is owned by the packages under it (`tsconfig.json` is the
exception: type ownership is strictly project-local). Alongside them, the report's top-level grades
are the **rollup**: the whole-repo math, unchanged, which is what a single-project repo has always
been. Categories only a repo-spanning tool can answer — secrets, dependency vulnerabilities,
workflow hygiene — read `not-assessed(repo-scoped)` per project, and what those tools _found_ still
counts toward the grade of the package it landed in.

`--project <path>` scopes a run, and it is repeatable:

```sh
npx crank-health --project packages/api --project packages/web
```

Scoping narrows the project dimension and nothing else. Repo-spanning tools still span the whole
repo — a secrets scan that skipped half the tree would be a secrets scan that misses the secret —
and the rollup is then computed over what was scanned: the selected projects' files as the
denominator, plus every finding the run produced — and `report.json` records the selection under
`scopedTo`, so the top-level grades are never mistaken for the whole tree's. An unknown path is a
usage error (exit 2) whose message lists the projects discovery did find.

## Grading

Three formula shapes, one constant table (`src/core/grade.ts`), no composite score. Density
categories weight findings by severity — critical and error ×5, warning ×1, info ×0.2 — and divide
by KLOC of analyzed source. Only `gradeScope` findings count.

| Category     | Measure                                     | A     | B    | C    | D    | F    |
| ------------ | ------------------------------------------- | ----- | ---- | ---- | ---- | ---- |
| Lint         | weighted findings / KLOC                    | ≤ 1   | ≤ 5  | ≤ 15 | ≤ 40 | > 40 |
| Types        | weighted **errors** / KLOC                  | 0     | ≤ 1  | ≤ 5  | ≤ 15 | > 15 |
| Dead code    | weighted findings / KLOC                    | ≤ 0.5 | ≤ 2  | ≤ 5  | ≤ 10 | > 10 |
| Format       | % of checked files failing                  | ≤ 1   | ≤ 10 | ≤ 30 | ≤ 60 | > 60 |
| Complexity   | % of functions over cognitive complexity 15 | ≤ 2   | ≤ 5  | ≤ 10 | ≤ 20 | > 20 |
| Duplication  | % of duplicated tokens (jscpd)              | ≤ 3   | ≤ 5  | ≤ 10 | ≤ 20 | > 20 |
| Test quality | mutation score % (`--deep`)                 | ≥ 80  | ≥ 65 | ≥ 50 | ≥ 35 | < 35 |

Security is never normalized — one leaked secret is an F in a million-line repo:

| Grade | Condition                                       |
| ----- | ----------------------------------------------- |
| F     | Any secret, or any critical finding             |
| D     | Any high-severity finding                       |
| C     | More than 2 medium or more than 10 low findings |
| B     | Some findings, at or under those counts         |
| A     | None                                            |

Two severities are remapped before that table is applied. zizmor's `unpinned-uses` and
`unpinned-images` are a chore — pin the digest — rather than a weakness someone can reach today, so
they count as `warning` whatever severity zizmor gave them; almost no repo hash-pins every `uses:`,
and at `error` they capped every workflow-bearing repo at D. bandit's HIGH tier is an `error` only
at HIGH confidence; below that it is a guess worth reading rather than a proven problem, so it
lands at `warning` — still graded, never silenced.

A category with nothing to measure is **not assessed**, never a flattering A: an absent grade and a
good grade are different answers, and `report.json` says which one it is and why.

The constants are calibrated first guesses; the formula _shapes_ and the rules are fixed. Version
0.1.0's numbers were probed against zustand v5.0.3, requests v2.32.3, datasette 0.65.1 and this
repo; version 0.2.0 re-probed the same three at the same tags, to see what its rule changes did to
the security and dead-code grades. No constant moved in either round — the measurements from both,
and the reasoning, are in the comments on `GRADE_TABLE`. Changing a threshold is a version bump.

One rule depends on what the repo _is_ rather than on what is in it. A root `package.json` that
declares `exports`, `module` or `types` — or a `main` without `private: true` — marks the repo a
**library**, whose published surface is its product rather than dead code. An unused
export in a library is therefore advisory — reported, `gradeScope` false — rather than graded, and
no repo is marked down for publishing what it exists to publish. A repo-owned dead-code config
overrides that: a repo that configured knip or fallow itself has already declared where its entry
points are, so its own tool's findings count. Changing this rule is a version bump too.

## Output

One directory per run. By default each run lands in `.codebase-health/<YYYY-MM-DD>-<xxxx>/` (local
date plus a 4-character run id), so consecutive runs keep their history instead of overwriting each
other; `.codebase-health/` carries a `.gitignore` (`*`) that hides every run from your working tree.
`--out <dir>` writes this run exactly to `<dir>` — no dated subfolder. Each run directory contains:

| File          | For                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `report.json` | The contract. Every finding, category state, metric, resolved tool version — as the rollup at the top level, and again per project under `projects[]` (path, manifests, languages, all eight states, metrics, and the toolchain each one owns). `scopedTo` records a `--project` selection the rollup was computed over.                                           |
| `report.md`   | The human report: grades, provenance tags, remediation.                                                                                                                                                                                                                                                                                                            |
| `agent.md`    | The coding-agent brief: ≤ 20 themed tasks in a deterministic priority order (security → types → dead code → complexity → duplication → lint → format, worst grade first), each with a stable ID, a grade impact, an evidence link and a verify command.                                                                                                            |
| `raw/`        | Each tool's own output, as evidence — source excerpts excepted, see below. Nested by what the run was about: `raw/<project-path>/`, `raw/root/` for the root project, `raw/repo/` for a repo-spanning run, and `raw/base/…` for a `--pr` base scan. A package whose own directory is called `root/` or `repo/` gets a trailing `_`, so nothing shares a directory. |

### Secrets stay in your repo

Nothing crank-health writes quotes a credential. gitleaks runs under `--redact=100`, so the value
never enters this process; a secrets finding is anchored on the rule rather than on the flagged
line, and it tells you where to look instead of what was found. bandit's hardcoded-secret tests
(`B105`/`B106`/`B107`) quote the literal in their message, so the quoted value is replaced with
`<redacted>` before the finding exists.

`raw/` follows the same rule, which is why it is evidence rather than a transcript: the security
scanners that copy source lines into their reports — bandit's `code` window, opengrep's
`extra.lines` — have those excerpts replaced with `<omitted>`. Rules, locations, severities and
messages are all still there, and the file they point at is still in your repo. That is what makes
a run directory safe to attach to a ticket.

## Zero footprint

After a run, `git status --porcelain` in the target is empty and nothing outside `--out` has been
written. This is a hard contract, tested on every fixture:

- Analyzers run from `npx`/`uvx` caches or your own `node_modules`; nothing is installed into the
  target, and dependencies and virtualenvs are never scanned.
- Every tool that wants to write beside your code is redirected: caches to a temp dir, jscpd's
  report to scratch, `.tsbuildinfo` and coverage data files and `__pycache__` and `.pytest_cache`
  suppressed outright. complexipy, whose cache directory cannot be disabled, is run against a copy
  in scratch.
- Repo-mutating commands (`osv-scanner fix`, `trunk init`, `pre-commit install`, …) are never
  invoked.
- Discovery is `git ls-files`-based, so `.gitignore` is respected — including by the tools that
  ignore it natively, which get explicit exclusion flags.

The quick profile never executes your code; it only reads it. `--deep` is the exception, and it says
so below.

## When a tool is missing

One tool can never abort a run. A category is `graded`, `not-assessed(reason)`, or `error(reason)`,
all eight states are always in `report.json`, and the exit code stays 0.

Three security tools ship as release binaries with no npm or PyPI distribution, so crank-health uses
the one already on your machine and degrades with an install hint when there is none:

```sh
brew install gitleaks       # secret scanning
brew install opengrep       # SAST
brew install osv-scanner    # dependency vulnerabilities
```

An owner crank-health declines to impose is the other way a tool goes missing. ESLint and Biome are
never imposed on a repo that did not choose them, and an owner declared without an install may never
manage to run: the ephemeral copy honors your config but can crash on plugins only a real install
provides, and a legacy-only `.eslintrc*` is a config ESLint no longer reads. That no longer silences
the default: our tool runs as a **standby** and is resolved once everything has finished. If the
owner graded the category, the standby is stood down — its findings and metrics drop out, and its
row in the tool table reads `stood down: lint graded by eslint`. If the owner errored or timed out,
the standby's grade is the one the repo gets, on our config rather than yours, and `warnings[]`
says so (`oxlint: graded lint on its default config because eslint reported error`). Either way the
provenance is on the record, in the Notes column and in `warnings[]`.

Missing `uv` degrades the Python categories the same way. A tool that crashes or emits unparseable
output becomes `error` with its stderr in `raw/`; a tool that overruns its budget (120 s by default,
`--timeout <secs>` to change it) becomes `not-assessed(timeout)`.

## The deep tier

`--deep` is the only profile that executes your code, and it runs mutation tools **only where the
repo already owns them** — a stryker config or dependency, cosmic-ray installed in the project's own
virtualenv. This is deliberate rather than shy: mutation testing needs the environment the test
suite needs (a `node_modules` with the right runner plugin, a virtualenv with the project's
dependencies), so an ephemeral install would produce a confident failure instead of an honest "not
available".

On a monorepo it runs in **every** project that owns a mutation tool, with no cap on how many that
is — each invocation bounded by the deep tier's own 15-minute per-tool budget, and no whole-run
ceiling, because a report whose contents depend on how fast the machine was is not a report.
`--project` is the cost control: `crank-health --deep --project packages/api` mutates one package.

**cosmic-ray mutates files in place.** Unlike StrykerJS, which mutates a sandboxed copy, cosmic-ray
edits the file on disk, runs the suite and restores it — a run killed in between leaves mutated
source in the target. crank-health will not do that to a repo that never asked for it, which is why
cosmic-ray requires the project to own it. Everything crank-health does control stays outside the
repo: generated config, session database, and reports all live in scratch.

coverage.py runs in the deep tier as context, not as a grade: test quality is graded on the mutation
score, because a line can be executed by a test that asserts nothing.

In quick mode, test quality reads `not assessed — run --deep`.

## PR mode

`--pr <base>` scans the merge-base in a detached worktree and scans head, then diffs the two finding
sets. Findings are identified by a fingerprint over category, tool, rule, file and a source anchor —
not by line number — so edits above a finding do not churn it, and git's rename detection is applied
before comparing. The result classifies **new** findings (those on lines the diff touched are
flagged directly actionable), **resolved** findings, and each category's grade movement.

Whole-repo measures — duplication, dead code — are computed over the whole tree on both sides, since
a changed-file subset gives the wrong answer for both. In deep mode, mutation is scoped to the files
the diff touched.

Both sides scan every project, so the delta carries each project's own movement as well as the
rollup's: a root config edit shows up in the packages it reached, a file moved across a package
boundary is the same finding re-attributed rather than churn, and a project this change added or
removed is labeled as such — so deleting a package never reads as the best work in the PR.

## Determinism

Same crank-health version + same commit + same repo toolchain ⇒ byte-identical `report.json`, apart
from the `timings` block and the repo's absolute path. Every ephemeral tool is pinned to an exact
version in a per-release manifest (`npx --yes oxlint@1.77.0`, `uvx ruff@0.16.1`) — never `@latest`,
never a range. Repo-owned tools run at your installed version, and every resolved version is
recorded in the report. No AI, no sampling, stable sort everywhere.

## Platform support

macOS and Linux. Windows is untested — crank-health assumes POSIX paths and a working `git`, `npx`
and (for Python) `uvx`.

## Licensing

crank-health is MIT-licensed. The bundled SAST ruleset that `opengrep` runs is original work by this
project and ships under the same MIT license: the semgrep registry's packs carry terms restricting
redistribution and competing use, and those terms follow the rules into any engine, so crank-health
does not fetch or bundle them. `--config auto` is unreachable — opengrep always points at the
bundled rules materialized in scratch, and no invocation contacts a rule registry.
