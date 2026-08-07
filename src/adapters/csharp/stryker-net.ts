import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execTool, systemCommand, writeScratchRaw } from '../../core/exec.ts'
import type { ToolFailure } from '../../core/exec.ts'
import type { RunContext, ToolResult, ToolRunner } from '../../core/types.ts'
import { verifiedRepoVersion } from '../../manifest.ts'
import {
  SURVIVED_FINDING_LIMIT,
  mutationCounts,
  parseMutationReport,
  toPendingFindings,
} from '../mutation-report.ts'
import type { Mutant } from '../mutation-report.ts'
import { firstLine, identify } from '../support.ts'
import {
  DOTNET,
  DOTNET_TOOLS_MANIFEST,
  detectDotnetTool,
  dotnetExecOptions,
  sdkGate,
} from './dotnet-project.ts'

/**
 * Stryker.NET — mutation testing for C#, and the C# adapter's only runner that
 * executes the repo's own test suite (spec §5: "deep is the only tier that
 * executes repo code").
 *
 * The posture is the StrykerJS one, for the StrykerJS reasons: mutation
 * testing needs the repo's test framework, its project graph and every
 * dependency the tests compile against, so an ephemeral `dnx dotnet-stryker`
 * on a repo that never set it up would produce a confident failure instead of
 * an honest "not available". Hence `repoOwnedOnly` — ownership is the
 * `.config/dotnet-tools.json` local-tool manifest (or a csproj
 * `PackageReference`), and the manifest is also the install declaration:
 * `dotnet tool restore` materializes exactly the version the repo pinned, into
 * the NuGet machine cache, evaluating none of the repo's MSBuild targets.
 *
 * The run itself writes its report into scratch (`--output`); the mutants it
 * reports usually live in a *sibling* project — the test project owns the run,
 * the project under test receives the mutants — so findings are deliberately
 * not filtered to this project's files, and the core attributes each one to
 * the project its path belongs to. Stryker's initial build of the test project
 * does write the repo's ordinary `obj/`/`bin/` output, which discovery already
 * excludes and every C# repo gitignores — the same footprint as running the
 * suite itself, which is what the deep tier is.
 */

export const STRYKER_NET_TOOL = 'stryker-net'

/** NuGet tool id and package id in one — the tools manifest keys it by this. */
const STRYKER_NET_PACKAGE = 'dotnet-stryker'

/** What to tell a repo that has no mutation testing set up. */
export const STRYKER_NET_SETUP_HINT =
  `add ${STRYKER_NET_PACKAGE} to a \`${DOTNET_TOOLS_MANIFEST}\` tools manifest ` +
  `(\`dotnet new tool-manifest && dotnet tool install ${STRYKER_NET_PACKAGE}\`) ` +
  'to enable mutation testing'

/**
 * `dotnet tool restore`: resolves the manifest's pins into the NuGet machine
 * cache. It reads `.config/dotnet-tools.json` from the working directory
 * upward and evaluates no repo project file.
 */
export const TOOL_RESTORE_ARGS: readonly string[] = ['tool', 'restore']

/**
 * The `dotnet stryker` invocation: the repo's own restored Stryker.NET, its
 * whole output tree redirected into scratch (`--output` owns `reports/` and
 * `logs/`, which would otherwise land in a `StrykerOutput/` beside the code),
 * and the JSON reporter alone — the report is the result, and the default
 * reporter set writes an HTML report we would only delete.
 */
export function strykerNetInvocationArgs(scratch: string): readonly string[] {
  return ['stryker', '--output', join(scratch, STRYKER_NET_TOOL), '--reporter', 'json']
}

/** Where the invocation above makes Stryker.NET write its report. */
export function mutationReportPath(scratch: string): string {
  return join(scratch, STRYKER_NET_TOOL, 'reports', 'mutation-report.json')
}

/** The slice of a `ToolExecution` the outcome ladder classifies. */
export interface StrykerNetExecution {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | undefined
  readonly failure?: ToolFailure
}

/**
 * The exhaustive ladder over one `dotnet stryker` run, pure over its execution
 * and the report it did or did not write: process-level failures pass through
 * already classified, a non-zero exit is an `error` quoting the exit code, a
 * missing or unparseable report is an `error` (never "zero mutants and an A"),
 * and a report with no mutants at all measured nothing — also an `error`,
 * because an empty run scored as 0 % would grade the absence of a measurement.
 *
 * @returns the run's mutants when it is usable
 */
export function strykerNetOutcome(
  execution: StrykerNetExecution,
  report: string | undefined,
  repoRoot: string,
): Mutant[] | ToolFailure {
  const failure = commandFailure(execution, 'dotnet stryker')
  if (failure !== undefined) return failure
  if (report === undefined) {
    return {
      state: 'error',
      reason:
        'Stryker.NET wrote no mutation report: ' +
        (firstLine(execution.stderr) || firstLine(execution.stdout) || 'no output'),
    }
  }

  let mutants: Mutant[]
  try {
    mutants = parseMutationReport(report, repoRoot)
  } catch (error) {
    return {
      state: 'error',
      reason: `could not parse Stryker.NET's mutation report: ${describe(error)}`,
    }
  }
  if (mutants.length === 0) {
    return {
      state: 'error',
      reason:
        'the mutation run produced no mutants, so it measured nothing — ' +
        'refusing to read an empty run as a mutation score',
    }
  }
  return mutants
}

/**
 * The C# test-quality runner: `repoOwnedOnly` + `deepOnly`, the never-imposed
 * pair every mutation runner carries.
 */
export const strykerNetRunner: ToolRunner = {
  tool: STRYKER_NET_TOOL,
  category: 'test-quality',
  pinnedVersion: verifiedRepoVersion(STRYKER_NET_PACKAGE),
  repoOwnedOnly: true,
  deepOnly: true,
  detect: (ctx) =>
    detectDotnetTool(ctx, { toolId: STRYKER_NET_PACKAGE, packageName: STRYKER_NET_PACKAGE }),
  run: runStrykerNet,
}

async function runStrykerNet(ctx: RunContext): Promise<ToolResult> {
  if (!ctx.deep) {
    return unavailable('mutation testing runs in the deep profile only — pass `--deep`')
  }
  // Unreachable through the orchestrator — a `repoOwnedOnly` runner without a
  // detection is never planned — but the honest answer if reached anyway.
  if (ctx.detection === null) return unavailable(STRYKER_NET_SETUP_HINT)

  // Built once, handed to the gate and both commands, so the gate answers for
  // the directory the run uses (see `dotnet-project.ts`). The working
  // directory is the project's own: that is where `dotnet stryker` looks for
  // the test project, and where `dotnet tool restore` starts its manifest walk.
  const options = dotnetExecOptions(ctx, join(ctx.repoRoot, ctx.project.path))
  const gate = await sdkGate(options)
  if (gate !== undefined) {
    return { state: gate.state, findings: [], rawFiles: [], reason: gate.reason }
  }

  const restore = await execTool(systemCommand(DOTNET.binary, TOOL_RESTORE_ARGS), options)
  const restoreFailure = commandFailure(restore, 'dotnet tool restore')
  if (restoreFailure !== undefined) {
    return {
      state: restoreFailure.state,
      findings: [],
      rawFiles: [],
      reason: restoreFailure.reason,
    }
  }

  const execution = await execTool(
    systemCommand(DOTNET.binary, strykerNetInvocationArgs(ctx.scratch)),
    options,
  )

  const rawFiles: string[] = []
  const report = await readFileOrUndefined(mutationReportPath(ctx.scratch))
  if (report !== undefined) {
    rawFiles.push(await writeScratchRaw(ctx.scratch, 'stryker-net-mutation-report.json', report))
  }
  if (execution.stdout.trim().length > 0) {
    rawFiles.push(await writeScratchRaw(ctx.scratch, 'stryker-net.txt', execution.stdout))
  }
  if (execution.stderr.trim().length > 0) {
    rawFiles.push(await writeScratchRaw(ctx.scratch, 'stryker-net.stderr.txt', execution.stderr))
  }

  const outcome = strykerNetOutcome(execution, report, ctx.repoRoot)
  if (!Array.isArray(outcome)) {
    return { state: outcome.state, findings: [], rawFiles, reason: outcome.reason }
  }

  const counts = mutationCounts(outcome)
  const survived = outcome.filter((mutant) => mutant.status === 'Survived')
  return {
    state: 'ok',
    // Not filtered to `ctx.files`: the mutants live in the project under
    // test, a sibling of the test project this run belongs to (module note).
    findings: await identify(ctx.repoRoot, toPendingFindings(outcome, STRYKER_NET_TOOL)),
    rawFiles,
    ...(survived.length > SURVIVED_FINDING_LIMIT
      ? {
          reason: `listing the first ${SURVIVED_FINDING_LIMIT} of ${survived.length} survived mutants; the rest are in the raw report`,
        }
      : {}),
    // `mutationScore` is deliberately absent: the orchestrator recomputes it
    // from these counts across every language (`combinedMutationScore`).
    metrics: { mutantsDetected: counts.detected, mutantsUndetected: counts.undetected },
  }
}

/** The first two rungs, shared by both commands the runner spawns. */
function commandFailure(execution: StrykerNetExecution, label: string): ToolFailure | undefined {
  if (execution.failure !== undefined) return execution.failure
  if (execution.exitCode !== 0) {
    return {
      state: 'error',
      reason:
        `${label} failed (exit ${execution.exitCode ?? 'signal'}): ` +
        (firstLine(execution.stderr) || firstLine(execution.stdout)),
    }
  }
  return undefined
}

function unavailable(reason: string): ToolResult {
  return { state: 'not-available', findings: [], rawFiles: [], reason }
}

async function readFileOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
