# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`crank-health` — a CLI that runs a fixed set of pinned analyzers (oxlint, tsc, ruff, gitleaks, jscpd, StrykerJS, …) against a JS/TS or Python repo and emits deterministic A–F grades per category, whole-repo or PR-vs-base. Node ≥ 20, ESM, TypeScript throughout (imports use explicit `.ts` extensions).

## Commands

```sh
npm test                          # vitest run (all tests)
npx vitest run test/grade.test.ts # single test file
npm run typecheck                 # tsc --noEmit
npm run lint                      # oxlint --deny-warnings
npm run format:check              # prettier (format to write)
npm run build                     # tsdown → dist/cli.js (single-file ESM bin)
CRANK_PERF=1 npm test             # opt-in perf gate (quick profile < 60 s)
```

Some tests are end-to-end: they execute the real pinned tools via `npx`/`uvx`, so a cold cache downloads first. Python-side tests need `uv` on `PATH`.

## Architecture

Data flows one direction; `core/types.ts` is the stable vocabulary at the center. Grading, delta and renderers consume those types only — they never see a runner, and runners never see each other.

- `src/cli.ts` → `src/args.ts` → `src/run.ts` (whole-repo) or `src/run-pr.ts` (PR delta). `cli.ts` is a thin shell: options in, exit code out (0 = completed, 1 = `--fail-under` tripped, 2 = crank-health errored). Fixture tests drive `run.ts` directly, so what the tests prove is what the CLI does.
- `src/core/orchestrator.ts` takes `LanguageAdapter`s (`src/adapters/index.ts`: jsts, python, common — fixed order for determinism), runs each `ToolRunner` under a concurrency cap and per-tool timeout. A runner that throws/overruns/lacks prerequisites becomes `error`/`timeout`/`not-available`; one tool can never abort the run.
- Each `ToolRunner` (in `src/adapters/{jsts,python,common}/`) does `detect()` (is the tool repo-owned? never runs anything) then `run()`. Runner flags matter: `repoOwnedOnly` (ESLint/Biome/Stryker are never imposed on repos that didn't choose them), `complementary` (security tools union rather than suppress each other), `deepOnly` (only `--deep` may execute the repo's code).
- `src/core/grade.ts` holds the one constant table (`GRADE_TABLE`). Changing a threshold is a crank-health version bump; calibration evidence lives in its comments.
- `src/core/fingerprint.ts`: finding identity is hash(category, tool, rule, file, source-anchor, occurrence) — **not** line numbers — so PR deltas (`src/core/delta.ts`, rename-aware) don't churn on edits above a finding.
- `src/manifest.ts` pins every ephemeral tool version exactly (never `@latest`). Bumping a version can change grades → version bump + re-captured fixtures under `test/captured/`.
- `src/render/`: terminal, `report.json` (the contract), `report.md` (human), `agent.md` (coding-agent tasks).

Comments cite "spec §N" — the design spec is not checked in; the README documents the same contracts and is kept accurate.

## Hard contracts (tested, do not weaken)

- **Determinism**: same crank-health version + commit + repo toolchain ⇒ byte-identical `report.json` (minus timings/abs path). No `Date.now()`-dependent output, stable sort everywhere.
- **Zero footprint**: after a run, `git status --porcelain` in the target is empty; all writes go to the scratch dir or `--out`. Tools that want to write beside the code get redirected or run against a copy.
- **Secrets never quoted**: gitleaks runs `--redact=100`; bandit B105–B107 messages and raw-output source excerpts are redacted before a finding exists. Nothing written to the run dir may quote a credential.
- **Quick profile never executes repo code**; only `--deep` does, and deep mutation tools run only where the repo already owns them (an ephemeral install would produce a confident failure instead of an honest "not available").
- A category with nothing to measure is `not-assessed(reason)`, never a flattering A. All eight category states always appear in `report.json`.

## Testing conventions

- **Parse tests** run against captured real tool output in `test/captured/` (files named `tool-version.ext`). Re-capture when bumping a manifest version.
- **Fixture repos** in `test/fixtures/` are plain trees; `test/support/fixture.ts` turns them into real git repos with a frozen identity/date so the commit sha is byte-reproducible — that's what lets `test/golden/` snapshots contain real shas.
- **Golden snapshots** only assert on the `GOLDEN_TOOLCHAIN` (machine has none of gitleaks/opengrep/osv-scanner on `PATH` — see `test/support/system-tools.ts`), because an installed system tool is a different toolchain and a different report. Determinism, zero-footprint and planted-finding assertions run unconditionally.
- Findings constructed by hand in tests use `test/factories.ts`.
