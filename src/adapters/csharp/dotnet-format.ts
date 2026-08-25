import { mkdir, readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { execTool, systemCommand, writeScratchRaw } from '../../core/exec.ts'
import type { PendingFinding, RunContext, ToolResult, ToolRunner } from '../../core/types.ts'
import { verifiedVersion } from '../../manifest.ts'
import {
  asArray,
  asRecord,
  asString,
  byLocation,
  firstLine,
  identify,
  repoRelative,
} from '../support.ts'
import { DOTNET, dotnetExecOptions, sdkGate } from './dotnet-project.ts'

/**
 * `dotnet format whitespace` — the C# formatter check (spec "Categories and
 * tools").
 *
 * Folder mode (`--folder`) treats the workspace argument as a plain folder of
 * files: no project load, no restore, no repo code executed — source text only,
 * which is why this runner may run in the quick profile. `--verify-no-changes`
 * is the flag this runner cannot be correct without (zero footprint): without
 * it, `dotnet format` rewrites the files in place.
 *
 * The oxlint 2×2 (binary × config) collapses on both axes here: the machine's
 * SDK is the only binary there is, and the repo's `.editorconfig` — which
 * `dotnet format` reads on its own — is the only config. Every run is the
 * repo's own conventions, so findings are `repo-config` and the tool record
 * says `configOwned: true`, always.
 */

const DOTNET_FORMAT_TOOL = 'dotnet-format'

/** The one rule id every whitespace finding reports under. */
const DOTNET_FORMAT_RULE = 'dotnet-format/whitespace'

/** 0 = already formatted; 2 = "would reformat", which is a finding, not a failure. */
const EXPECTED_EXIT_CODES: ReadonlySet<number> = new Set([0, 2])

/** MSBuild output, excluded wherever in the tree it appears. */
const BUILD_OUTPUT_EXCLUDES: readonly string[] = ['bin', 'obj']

/** The report file name dotnet format derives from the `--report` directory. */
const REPORT_FILE = 'format-report.json'

export const dotnetFormatRunner: ToolRunner = {
  tool: DOTNET_FORMAT_TOOL,
  category: 'format',
  // Not a pin crank-health can enforce — the formatter is the machine's SDK;
  // see `SYSTEM_TOOL_MANIFEST`.
  pinnedVersion: verifiedVersion('dotnet'),
  // The SDK is the only binary and the repo's `.editorconfig` the only config
  // (see the file comment), so there is no ownership to detect — and detection
  // never spawns. The run reports `configOwned: true` instead.
  detect: () => Promise.resolve(null),
  run: runDotnetFormat,
}

async function runDotnetFormat(ctx: RunContext): Promise<ToolResult> {
  if (ctx.files.length === 0) {
    return { state: 'ok', findings: [], rawFiles: [], reason: 'no C# files' }
  }

  const options = dotnetExecOptions(ctx, ctx.repoRoot)
  const gate = await sdkGate(options)
  if (gate !== undefined)
    return { state: gate.state, findings: [], rawFiles: [], reason: gate.reason }

  const reportDir = join(ctx.scratch, DOTNET_FORMAT_TOOL)
  await mkdir(reportDir, { recursive: true })
  const projectDir = ctx.project.path === '.' ? ctx.repoRoot : join(ctx.repoRoot, ctx.project.path)
  const excludes = [
    ...BUILD_OUTPUT_EXCLUDES,
    // Folder mode takes the whole tree, so a nested project's files — its own
    // run's to measure — are excluded here, relative to this project's dir.
    ...(ctx.nestedProjects ?? []).map((nested) => posix.relative(ctx.project.path, nested)),
  ]
  const execution = await execTool(
    systemCommand(DOTNET.binary, formatInvocationArgs(projectDir, excludes, reportDir)),
    options,
  )
  const rawFiles: string[] = []
  if (execution.failure !== undefined) {
    return {
      state: execution.failure.state,
      findings: [],
      rawFiles,
      reason: execution.failure.reason,
    }
  }

  // Exhaustive by construction: an unexpected exit, or an expected exit whose
  // report never landed, is an `error` — a silently missing report must never
  // become zero findings and a flattering A.
  const report =
    execution.exitCode !== undefined && EXPECTED_EXIT_CODES.has(execution.exitCode)
      ? await readReport(join(reportDir, REPORT_FILE))
      : undefined
  if (report === undefined) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason:
        `dotnet format exited ${execution.exitCode ?? 'signal'} without a report: ` +
        firstLine(execution.stderr),
    }
  }
  rawFiles.push(await writeScratchRaw(ctx.scratch, 'dotnet-format.json', report))

  let pending: PendingFinding[]
  try {
    pending = parseDotnetFormatReport(report, ctx.repoRoot)
  } catch (error) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason: `could not parse dotnet format output: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const analyzed = new Set(ctx.files)
  return {
    state: 'ok',
    findings: await identify(
      ctx.repoRoot,
      pending.filter((finding) => analyzed.has(finding.file)),
    ),
    rawFiles,
    // The `format` denominator (spec §3: "% files failing"): every path handed
    // to this runner is a C# source and dotnet format checks all of them.
    metrics: { formattableFiles: ctx.files.length },
    configOwned: true,
  }
}

/**
 * The command line, exported so tests can assert its shape without running the
 * SDK. `--verify-no-changes` is the flag this runner cannot be correct without
 * (zero footprint): without it the run rewrites files in place. `--folder` is
 * what keeps the run source-text only — no project load, no restore (SDK 10
 * rejects an explicit `--no-restore` beside `--folder` as redundant). The
 * report goes to a scratch directory; dotnet format names the file inside it.
 *
 * @param excludes paths relative to `projectDir`: MSBuild output and each
 * nested project
 */
export function formatInvocationArgs(
  projectDir: string,
  excludes: readonly string[],
  reportDir: string,
): readonly string[] {
  return [
    'format',
    'whitespace',
    projectDir,
    '--folder',
    '--verify-no-changes',
    ...(excludes.length === 0 ? [] : ['--exclude', ...excludes]),
    '--report',
    reportDir,
  ]
}

/** The report's bytes, or `undefined` when the tool never wrote it. */
async function readReport(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Parses `--report`'s `format-report.json` — an array of
 * `{ FilePath, FileChanges[] }` with absolute paths — into one finding per
 * failing file, never one per change: the `format` grade is a share of files
 * (prettier/ruff-format parity), and the captured report carries 15 changes in
 * one file. The explicit empty anchor keeps identity at
 * `(category, tool, rule, file)`.
 *
 * A file listed without any changes is not failing and produces nothing. Paths
 * are relativized without judging: a path outside the repo relativizes to a
 * `../…` form no inventory contains, and the runner's `analyzed` filter is
 * what drops it.
 *
 * @throws {Error} when the payload is not the report array
 */
export function parseDotnetFormatReport(json: string, repoRoot: string): PendingFinding[] {
  const document: unknown = JSON.parse(json)
  const entries = asArray(document)
  if (entries === undefined) throw new Error('dotnet format output is not an array of file reports')

  const failing = entries.flatMap((entry) => {
    const record = asRecord(entry)
    const file = asString(record?.['FilePath'])
    const changes = asArray(record?.['FileChanges'])
    if (file === undefined || changes === undefined || changes.length === 0) return []
    return [repoRelative(file, repoRoot)]
  })

  return [...new Set(failing)]
    .map((file) => ({
      category: 'format' as const,
      tool: DOTNET_FORMAT_TOOL,
      rule: DOTNET_FORMAT_RULE,
      severity: 'warning' as const,
      file,
      range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
      message: 'File does not match the repo’s .editorconfig whitespace conventions',
      provenance: 'repo-config' as const,
      gradeScope: true,
      anchor: '',
      fixHint: 'dotnet format whitespace . --folder --include <file>',
    }))
    .toSorted(byLocation)
}
