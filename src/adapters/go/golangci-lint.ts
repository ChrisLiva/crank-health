import { isAbsolute, join } from 'node:path'
import { writeScratchRaw } from '../../core/exec.ts'
import type { PendingFinding, RunContext, ToolResult, ToolRunner } from '../../core/types.ts'
import { pinnedGoSpec, pinnedGoVersion } from '../../manifest.ts'
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  byLocation,
  failed,
  firstLine,
  identify,
  repoRelative,
} from '../support.ts'
import {
  detectGoConfig,
  execGo,
  projectDirectory,
  withGoGate,
  withoutFetchNarration,
} from './go-toolchain.ts'

/**
 * `golangci-lint run` — the lint suite a Go repo chose for itself.
 *
 * It is `repoOwnedOnly` (spec §1): golangci-lint is a *meta*-linter whose whole
 * content is the set of linters and rules a repo enabled, so imposing it on a
 * repo that never configured one would grade that repo against a config it
 * never wrote. A repo that owns a `.golangci.*` gets it, and nobody else does.
 *
 * Because `go run` fetches it, ownership can never include an installed binary
 * — {@link detectGoConfig} reports `installed: false` always — so this runner
 * *claims* `lint` without suppressing crank-health's own Go linters: staticcheck
 * and `go vet` run as standbys and are stood down only once golangci-lint has
 * actually graded the category (`orchestrator.ts`'s `resolveStandby`). A fetch
 * that fails therefore costs the repo a nicer lint report, never the grade.
 */

export const GOLANGCI_LINT_TOOL = 'golangci-lint'

/** The import path `go run` fetches; pinned exactly in `manifest.ts`. */
const GOLANGCI_LINT_PACKAGE = 'github.com/golangci/golangci-lint/v2/cmd/golangci-lint'

/**
 * The config names golangci-lint answers to, in the order it looks for them.
 * Owning any one of them is owning the tool.
 */
const GOLANGCI_LINT_CONFIGS: readonly string[] = [
  '.golangci.yml',
  '.golangci.yaml',
  '.golangci.toml',
  '.golangci.json',
]

/**
 * Five minutes, like staticcheck's: golangci-lint loads the package graph once
 * and then runs every linter the repo enabled over it, and on a cold module
 * cache it builds the meta-linter first. A user's `--timeout` still wins.
 */
const GOLANGCI_LINT_TIMEOUT_MS = 300_000

/** The name the stream is staged under, per project. */
const RAW_NAME = 'golangci-lint.json'

export const golangciLintRunner: ToolRunner = {
  tool: GOLANGCI_LINT_TOOL,
  category: 'lint',
  repoOwnedOnly: true,
  pinnedVersion: pinnedGoVersion(GOLANGCI_LINT_PACKAGE),
  timeoutMs: GOLANGCI_LINT_TIMEOUT_MS,
  // The shared ancestor walk, so a config above the project owns it here the
  // same way golangci-lint itself resolves one.
  detect: (ctx) => detectGoConfig(ctx, GOLANGCI_LINT_CONFIGS),
  run: withGoGate(runGolangciLint),
}

/**
 * The one invocation. `--output.json.path stdout` is v2's spelling — v1's
 * `--out-format json` was removed in v2 — and the run's own directory is the
 * project's, so the paths it prints are the project's.
 */
function invocationArgs(): string[] {
  return ['run', pinnedGoSpec(GOLANGCI_LINT_PACKAGE), 'run', '--output.json.path', 'stdout']
}

/**
 * **The document, not the exit code, says whether the run happened.**
 * golangci-lint exits 1 whenever it reported an issue (`issues-exit-code`
 * defaults to 1), so the exit code alone cannot separate "I found problems"
 * from "I could not run" — the same shape staticcheck's runner takes. What
 * separates them is whether stdout carries a report at all: a config this
 * version rejects exits non-zero having printed none, and that is an `error`.
 */
async function runGolangciLint(ctx: RunContext): Promise<ToolResult> {
  if (ctx.files.length === 0) {
    return { state: 'ok', findings: [], rawFiles: [], reason: 'no Go files', configOwned: true }
  }

  const execution = await execGo(ctx, invocationArgs())
  if (execution.failure !== undefined) {
    return { ...failed(execution.failure), configOwned: true }
  }

  const rawFiles = [await writeScratchRaw(ctx.scratch, RAW_NAME, execution.stdout)]

  if (reportIn(execution.stdout) === undefined) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason:
        `golangci-lint exited ${execution.exitCode ?? 'signal'} with nothing to report: ` +
        // Stripped of fetch narration first: on a cold cache the literal first
        // line is `go: downloading …`, and `reason` is a `report.json` field —
        // a cold run must not differ from a warm one.
        firstLine(withoutFetchNarration(execution.stderr)),
      configOwned: true,
    }
  }

  // Only the files this scan owns: a generated or vendored file discovery
  // excluded is not the repo's to answer for, whatever the repo's config asked
  // golangci-lint to look at.
  const analyzed = new Set(ctx.files)
  const pending = parseGolangciJson(execution.stdout, projectDirectory(ctx), ctx.repoRoot).filter(
    (finding) => analyzed.has(finding.file),
  )
  return {
    state: 'ok',
    findings: await identify(ctx.repoRoot, pending.toSorted(byLocation)),
    rawFiles,
    // `go run <import-path>@<version>` is an exact spec with no resolution step
    // that could land elsewhere, so the pin is what ran (spec §6). Asking the
    // binary is no better: a `go run` golangci-lint says "(unknown)" about
    // itself, because its version is stamped in at release-build time.
    toolVersion: pinnedGoVersion(GOLANGCI_LINT_PACKAGE),
    configOwned: true,
  }
}

/**
 * `--output.json.path stdout` → findings.
 *
 * The stream is a JSON document *and then some prose*: v2.12.2 prints the
 * report on one line and follows it with the human summary it always prints
 * (`2 issues:` / `* staticcheck: 1`), so `JSON.parse` over the whole stream
 * fails and would silently cost every finding. The document is therefore found
 * rather than assumed — see {@link reportIn}.
 *
 * `FromLinter` is the rule: golangci-lint's unit of configuration is the
 * linter, which is what a repo enables, disables and excludes by. `Text` keeps
 * the check's own code where the linter puts one there (`S1002: …`).
 *
 * Severity is `warning` throughout. golangci-lint carries a `Severity` field,
 * but it is empty unless the repo configured a severity mapping, and grading a
 * style opinion as an `error` would put a D on a repo for one
 * (`core/grade.ts` reads severity, not counts, for its worst grades).
 *
 * @param projectDir absolute directory the run happened in: `Pos.Filename` is
 * relative to it (v2.12.2 prints an absolute path only for a file outside it)
 */
export function parseGolangciJson(
  stdout: string,
  projectDir: string,
  repoRoot: string,
): readonly PendingFinding[] {
  const issues = asArray(reportIn(stdout)?.['Issues']) ?? []
  const findings: PendingFinding[] = []
  for (const entry of issues) {
    const finding = toPendingFinding(asRecord(entry), projectDir, repoRoot)
    if (finding !== undefined) findings.push(finding)
  }
  return findings
}

/**
 * The report document inside the stream, or `undefined` where there is none.
 *
 * The whole stream is tried first — a future release that stops appending its
 * summary is then read by the plain path — and then each line on its own,
 * because that is the shape v2.12.2 produces: one line of JSON, then prose. A
 * document is recognized by carrying `Issues`, so a summary line that happened
 * to parse as JSON cannot stand in for the report.
 */
function reportIn(stdout: string): Record<string, unknown> | undefined {
  for (const candidate of [stdout, ...stdout.split('\n')]) {
    const record = asRecord(parseJson(candidate))
    if (record !== undefined && 'Issues' in record) return record
  }
  return undefined
}

/** One candidate, or `undefined` where it was not JSON after all. */
function parseJson(text: string): unknown {
  if (text.trim().length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * One issue in the core's vocabulary, or `undefined` where it carried no place
 * or nothing to say. Provenance is always `repo-config`: this runner only ever
 * runs where the repo owns a `.golangci.*`, and that config is what decided
 * every linter that spoke.
 */
function toPendingFinding(
  issue: Record<string, unknown> | undefined,
  projectDir: string,
  repoRoot: string,
): PendingFinding | undefined {
  if (issue === undefined) return undefined
  const rule = asString(issue['FromLinter'])
  const message = asString(issue['Text'])
  const position = asRecord(issue['Pos'])
  const file = asString(position?.['Filename'])
  if (rule === undefined || message === undefined || file === undefined || file === '') {
    return undefined
  }

  // golangci-lint reports one point per issue, never a span, so the start
  // stands in for the end — as it does for staticcheck's symbol-level checks.
  const line = asNumber(position?.['Line']) ?? 1
  const column = asNumber(position?.['Column']) ?? 1
  return {
    category: 'lint',
    tool: GOLANGCI_LINT_TOOL,
    rule,
    severity: 'warning',
    file: underRoot(file, projectDir, repoRoot),
    range: { startLine: line, startCol: column, endLine: line, endCol: column },
    message,
    provenance: 'repo-config',
    gradeScope: true,
  }
}

/** A tool-reported path — relative to the run, or absolute — as the repo sees it. */
function underRoot(file: string, projectDir: string, repoRoot: string): string {
  return repoRelative(isAbsolute(file) ? file : join(projectDir, file), repoRoot)
}
