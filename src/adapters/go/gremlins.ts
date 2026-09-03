import { join } from 'node:path'
import { writeScratchRaw } from '../../core/exec.ts'
import type { ToolFailure } from '../../core/exec.ts'
import type { RunContext, ToolResult, ToolRunner } from '../../core/types.ts'
import { pinnedGoSpec, pinnedGoVersion } from '../../manifest.ts'
import { mutationCounts } from '../mutation-report.ts'
import type { Mutant, MutantStatus } from '../mutation-report.ts'
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  compare,
  firstLine,
  readFileOrUndefined,
  unavailable,
  underProject,
} from '../support.ts'
import { detectGoConfig, execGo, withGoGate, withoutFetchNarration } from './go-toolchain.ts'

/**
 * gremlins — mutation testing for Go, and the Go adapter's only runner that
 * executes the repo's own tests (spec §5: deep is the only tier that runs repo
 * code).
 *
 * The posture is every mutation runner's, for every mutation runner's reason:
 * `deepOnly`, because it runs the suite, and `repoOwnedOnly`, because mutation
 * testing needs a suite the repo actually maintains — imposing it on a repo
 * that never chose it produces a confident failure where an honest "not
 * available" belongs. Ownership is a `.gremlins.yaml`/`.gremlins.yml`, the only
 * declaration gremlins has: `go run` fetches the binary, so no repo ever
 * installs one and there is no dependency to look for (`detectGoConfig`).
 *
 * **The report is the result.** gremlins prints its verdicts to the terminal
 * and writes the machine-readable copy only where `--output` says, so the run
 * writes into scratch and the parser reads that file. Nothing is graded from
 * the human stream.
 *
 * **Counts only, no per-mutant findings.** The shared `toPendingFindings` mints
 * `stryker/…` rule ids, and renaming them would churn the fingerprint of every
 * mutation finding this tool never reported; the score is what test-quality is
 * graded on, and it comes from the two counts. `mutationScore` itself is
 * deliberately absent from the metrics — the orchestrator recomputes it across
 * languages (`combinedMutationScore`), exactly as Stryker.NET's runner does.
 *
 * **No `timeoutMs`.** A `deepOnly` runner takes the deep budget before its own
 * declaration is looked at (`orchestrator.ts` `budgetFor`), so a per-runner
 * override here would be dead configuration.
 */

export const GREMLINS_TOOL = 'gremlins'

/** The import path `go run` fetches; pinned exactly in `manifest.ts`. */
const GREMLINS_PACKAGE = 'github.com/go-gremlins/gremlins/cmd/gremlins'

/** The config names gremlins answers to, and the repo's declaration of it. */
const GREMLINS_CONFIG_FILES: readonly string[] = ['.gremlins.yaml', '.gremlins.yml']

/** What to tell a Go repo that has no mutation testing set up. */
const GREMLINS_SETUP_HINT = 'add a `.gremlins.yaml` to this module to enable mutation testing'

/** The name the machine-readable report is staged under, per project. */
const RAW_NAME = 'gremlins.json'

export const gremlinsRunner: ToolRunner = {
  tool: GREMLINS_TOOL,
  category: 'test-quality',
  pinnedVersion: pinnedGoVersion(GREMLINS_PACKAGE),
  deepOnly: true,
  repoOwnedOnly: true,
  detect: (ctx) => detectGoConfig(ctx, GREMLINS_CONFIG_FILES),
  run: withGoGate(runGremlins),
}

/**
 * gremlins' status vocabulary → the shared one. Every string here was
 * transcribed from a real v0.6.0 report (`test/captured/gremlins-0.6.0.json`)
 * or from the tool's own summary line; anything else is refused rather than
 * guessed at, because a status silently outside both counts is a mutation
 * score that flatters the suite.
 */
const STATUS_BY_GREMLIN: Readonly<Record<string, MutantStatus>> = {
  KILLED: 'Killed',
  LIVED: 'Survived',
  'NOT COVERED': 'NoCoverage',
  'TIMED OUT': 'Timeout',
  'NOT VIABLE': 'CompileError',
  SKIPPED: 'Ignored',
}

/** What {@link parseGremlinsReport} answers: mutants, or the word it could not read. */
export type GremlinsReport =
  { readonly mutants: readonly Mutant[] } | { readonly unknownStatus: string }

/**
 * Reads gremlins' `--output` document — `{go_module, files: [{file_name,
 * mutations: [{type, status, line, column}]}], …}` as v0.6.0 writes it.
 *
 * A union rather than a list, so an unrecognised status cannot be dropped into
 * a count by accident: the caller has to look at it. A document that is not a
 * gremlins report at all — empty, truncated, or some other tool's JSON — is no
 * mutants, which the runner reads as a run that measured nothing.
 *
 * gremlins reports each file relative to the module it ran in, so the project
 * is what turns `calc.go` into a path the rest of the report can speak about.
 *
 * @param projectPath repo-relative posix project directory, `.` for the root
 */
export function parseGremlinsReport(json: string, projectPath = '.'): GremlinsReport {
  const files = asArray(asRecord(parseDocument(json))?.['files'])
  if (files === undefined) return { mutants: [] }

  const mutants: Mutant[] = []
  for (const entry of files) {
    const found = mutantsInFile(asRecord(entry), projectPath)
    if (!Array.isArray(found)) return found
    mutants.push(...found)
  }

  return {
    mutants: mutants.toSorted(
      (a, b) => compare(a.file, b.file) || a.startLine - b.startLine || a.startCol - b.startCol,
    ),
  }
}

/**
 * One `files[]` entry's mutants, or the status word this release cannot count —
 * which stops the whole report rather than being dropped from a score. An entry
 * without a `file_name` names nothing placeable and contributes no mutants.
 */
function mutantsInFile(
  record: Record<string, unknown> | undefined,
  projectPath: string,
): Mutant[] | { readonly unknownStatus: string } {
  const name = asString(record?.['file_name'])
  if (name === undefined) return []
  const file = underProject(projectPath, name)

  const mutants: Mutant[] = []
  for (const raw of asArray(record?.['mutations']) ?? []) {
    const mutation = asRecord(raw)
    const reported = asString(mutation?.['status'])
    if (mutation === undefined || reported === undefined) continue

    const status = STATUS_BY_GREMLIN[reported]
    if (status === undefined) return { unknownStatus: reported }

    const startLine = asNumber(mutation['line']) ?? 1
    const startCol = asNumber(mutation['column']) ?? 1
    mutants.push({
      file,
      mutatorName: asString(mutation['type']) ?? 'unknown',
      // gremlins names the mutator and never quotes the source it wrote.
      replacement: '',
      status,
      startLine,
      startCol,
      endLine: startLine,
      endCol: startCol,
    })
  }
  return mutants
}

/** The slice of a `ToolExecution` the outcome ladder classifies. */
export interface GremlinsExecution {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | undefined
  readonly failure?: ToolFailure
}

/**
 * The exhaustive ladder over one `gremlins unleash` run, pure over its
 * execution and the report it did or did not write — the Stryker.NET shape, and
 * for the same reasons: a process-level failure passes through classified, a
 * missing report is an `error` (never "zero mutants and an A"), an unrecognised
 * status is an `error` naming the string, and a run with no mutants at all
 * measured nothing.
 *
 * **The report outranks the exit code**, which is gosec's precedent in this
 * adapter: gremlins' thresholds are a configurable quality gate that makes it
 * exit non-zero on a perfectly complete run (`--threshold-efficacy`), so a
 * repo that set one would otherwise have its every mutation run reported as an
 * error. A run that wrote no report is where the exit code gets quoted.
 *
 * @returns the run's mutants when it is usable
 */
export function gremlinsOutcome(
  execution: GremlinsExecution,
  report: string | undefined,
  projectPath = '.',
): Mutant[] | ToolFailure {
  if (execution.failure !== undefined) return execution.failure
  if (report === undefined) {
    return {
      state: 'error',
      reason:
        `${GREMLINS_TOOL} wrote no mutation report (exit ${execution.exitCode ?? 'signal'}): ` +
        // Stripped of fetch narration first: on a cold module cache the literal
        // first line is `go: downloading …`, and `reason` is a `report.json`
        // field, so a cold run must not differ from a warm one.
        (firstLine(withoutFetchNarration(execution.stderr)) ||
          firstLine(execution.stdout) ||
          'no output'),
    }
  }

  const parsed = parseGremlinsReport(report, projectPath)
  if ('unknownStatus' in parsed) {
    return {
      state: 'error',
      reason:
        `${GREMLINS_TOOL} reported the mutant status \`${parsed.unknownStatus}\`, which this ` +
        'release does not know how to count — refusing to score a run it cannot read',
    }
  }
  if (parsed.mutants.length === 0) {
    return {
      state: 'error',
      reason:
        'the mutation run produced no mutants, so it measured nothing — ' +
        'refusing to read an empty run as a mutation score',
    }
  }
  return [...parsed.mutants]
}

async function runGremlins(ctx: RunContext): Promise<ToolResult> {
  if (!ctx.deep) {
    return unavailable('mutation testing runs in the deep profile only — pass `--deep`')
  }
  // Unreachable through the orchestrator — a `repoOwnedOnly` runner without a
  // detection is never planned — but the honest answer if reached anyway.
  if (ctx.detection === null) return unavailable(GREMLINS_SETUP_HINT)
  if (ctx.files.length === 0) {
    return { state: 'ok', findings: [], rawFiles: [], reason: 'no Go files' }
  }

  const reportPath = join(ctx.scratch, `${GREMLINS_TOOL}-output.json`)
  const execution = await execGo(ctx, invocationArgs(reportPath))

  const report = await readFileOrUndefined(reportPath)
  const rawFiles =
    report === undefined ? [] : [await writeScratchRaw(ctx.scratch, RAW_NAME, report)]

  const outcome = gremlinsOutcome(execution, report, ctx.project.path)
  if (!Array.isArray(outcome)) {
    return { state: outcome.state, findings: [], rawFiles, reason: outcome.reason }
  }

  const counts = mutationCounts(outcome)
  return {
    state: 'ok',
    findings: [],
    // `go run <import-path>@<version>` is an exact spec with no resolution step
    // that could land elsewhere, so the pin is what ran (spec §6).
    toolVersion: pinnedGoVersion(GREMLINS_PACKAGE),
    rawFiles,
    // `mutationScore` is deliberately absent: the orchestrator recomputes it
    // from these counts across every language (`combinedMutationScore`).
    metrics: { mutantsDetected: counts.detected, mutantsUndetected: counts.undetected },
  }
}

/**
 * The one invocation. gremlins takes the module it is pointed at from its
 * working directory — which `goExecOptions` already makes the project's — and
 * writes machine-readable results only where `--output` says.
 */
function invocationArgs(reportPath: string): string[] {
  return ['run', pinnedGoSpec(GREMLINS_PACKAGE), 'unleash', '--output', reportPath]
}

/** The document as JSON, or `undefined` where it was not JSON at all. */
function parseDocument(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return undefined
  }
}
