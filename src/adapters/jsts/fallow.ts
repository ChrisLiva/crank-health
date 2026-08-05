import { execTool, ephemeralCommand, repoCommand, writeScratchRaw } from '../../core/exec.ts'
import { COMPLEXITY_CEILING } from '../../core/grade.ts'
import type {
  Detection,
  PendingFinding,
  RepoContext,
  RunContext,
  Severity,
  ToolResult,
  ToolRunner,
} from '../../core/types.ts'
import { pinnedVersion } from '../../manifest.ts'
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  byLocation,
  firstLine,
  identify,
  repoRelative,
} from '../support.ts'
import { detectNodeTool } from './node-package.ts'

/**
 * fallow — `dead-code` and `health` (spec "Categories and tools"). One file,
 * two runners: same binary, same detection, same JSON envelope, different
 * subcommand and category.
 *
 * fallow discovers its own files rather than taking a list, as every
 * whole-project analyzer must — dead code and complexity are global metrics
 * (spec §4). The guarantee discovery exists to give is restored on the way out
 * instead: results are filtered to the paths crank-health discovered, so
 * gitignored files and dependencies can never reach a report.
 */

export const FALLOW_DEAD_CODE_TOOL = 'fallow-dead-code'
export const FALLOW_HEALTH_TOOL = 'fallow-health'

/** npm package name; fallow's command and package names coincide. */
const FALLOW_PACKAGE = 'fallow'
const FALLOW_BIN = 'fallow'

export const FALLOW_CONFIG_FILES: readonly string[] = [
  '.fallowrc.json',
  '.fallowrc.jsonc',
  'fallow.toml',
  '.fallow.toml',
]

/**
 * Flags shared by both subcommands.
 *
 * Zero footprint (spec §7): `--no-cache` is what stops fallow writing its
 * incremental cache into the target repo, and neither `fix` nor
 * `--save-snapshot` nor `--save-baseline` — all of which write — is ever
 * reachable from here. `-q` drops the progress output that would otherwise mix
 * into stdout.
 */
const BASE_ARGS: readonly string[] = ['--format', 'json', '--no-cache', '-q']

/** fallow severities → the core's vocabulary (spec §2). */
const SEVERITY_BY_LEVEL: Readonly<Record<string, Severity>> = {
  // `critical` is reserved for leaked secrets in the absolute security shape,
  // so fallow's worst complexity verdict maps to `error`, not `critical`.
  critical: 'error',
  high: 'warning',
  moderate: 'info',
}

export const fallowDeadCodeRunner: ToolRunner = {
  tool: FALLOW_DEAD_CODE_TOOL,
  category: 'dead-code',
  pinnedVersion: pinnedVersion(FALLOW_PACKAGE),
  detect: detectFallow,
  run: runDeadCode,
}

export const fallowHealthRunner: ToolRunner = {
  tool: FALLOW_HEALTH_TOOL,
  category: 'complexity',
  pinnedVersion: pinnedVersion(FALLOW_PACKAGE),
  detect: detectFallow,
  run: runHealth,
}

function detectFallow(repo: RepoContext): Promise<Detection | null> {
  return detectNodeTool(repo, {
    configFiles: FALLOW_CONFIG_FILES,
    packageName: FALLOW_PACKAGE,
    binName: FALLOW_BIN,
  })
}

async function runDeadCode(ctx: RunContext): Promise<ToolResult> {
  const run = await invoke(ctx, FALLOW_DEAD_CODE_TOOL, ['dead-code'])
  if (run.failure !== undefined) return run.failure

  let report: FallowDeadCode
  try {
    report = parseDeadCode(run.stdout)
  } catch (error) {
    return failed(FALLOW_DEAD_CODE_TOOL, run.rawFiles, error)
  }

  const analyzed = new Set(ctx.files)
  return {
    state: 'ok',
    findings: await identify(
      ctx.repoRoot,
      toDeadCodeFindings(report, ctx.detection !== null).filter((finding) =>
        analyzed.has(finding.file),
      ),
    ),
    ...(report.version === undefined ? {} : { toolVersion: report.version }),
    rawFiles: run.rawFiles,
  }
}

async function runHealth(ctx: RunContext): Promise<ToolResult> {
  // `--complexity` selects the one section we grade on. The sections it turns
  // off — hotspots, churn, ownership — read git history through a *relative*
  // time window (`--since 6m`), which would make the report depend on the wall
  // clock and break the determinism contract (spec §6).
  const run = await invoke(ctx, FALLOW_HEALTH_TOOL, [
    'health',
    '--complexity',
    '--max-cognitive',
    String(COMPLEXITY_CEILING),
  ])
  if (run.failure !== undefined) return run.failure

  let report: FallowHealth
  try {
    report = parseHealth(run.stdout)
  } catch (error) {
    return failed(FALLOW_HEALTH_TOOL, run.rawFiles, error)
  }

  const analyzed = new Set(ctx.files)
  const overCeiling = report.findings.filter((finding) => finding.exceedsCognitive)
  return {
    state: 'ok',
    findings: await identify(
      ctx.repoRoot,
      toHealthFindings(report, ctx.detection !== null).filter((finding) =>
        analyzed.has(finding.file),
      ),
    ),
    ...(report.version === undefined ? {} : { toolVersion: report.version }),
    rawFiles: run.rawFiles,
    // Spec §3's complexity ratio, exactly: % of functions over cognitive 15.
    metrics: {
      functionsTotal: report.functionsAnalyzed,
      functionsOverCeiling: overCeiling.length,
    },
  }
}

interface Invocation {
  readonly stdout: string
  readonly rawFiles: string[]
  readonly failure?: ToolResult
}

async function invoke(ctx: RunContext, tool: string, args: string[]): Promise<Invocation> {
  const command =
    ctx.detection?.installed === true && ctx.detection.binPath !== undefined
      ? repoCommand(ctx.detection.binPath, args)
      : ephemeralCommand(FALLOW_PACKAGE, args, FALLOW_BIN)

  const execution = await execTool(
    { ...command, args: [...command.args, ...BASE_ARGS] },
    { cwd: ctx.repoRoot, timeoutMs: ctx.timeoutMs },
  )

  const rawFiles = [await writeScratchRaw(ctx.scratch, `${tool}.json`, execution.stdout)]
  if (execution.stderr.trim().length > 0) {
    rawFiles.push(await writeScratchRaw(ctx.scratch, `${tool}.stderr.txt`, execution.stderr))
  }

  if (execution.failure !== undefined) {
    return {
      stdout: execution.stdout,
      rawFiles,
      failure: {
        state: execution.failure.state,
        findings: [],
        rawFiles,
        reason: execution.failure.reason,
      },
    }
  }
  // fallow exits 1 whenever it found anything, so only an empty stdout is a
  // real failure.
  if (execution.stdout.trim().length === 0) {
    return {
      stdout: '',
      rawFiles,
      failure: {
        state: 'error',
        findings: [],
        rawFiles,
        reason: `${tool} produced no output (exit ${execution.exitCode ?? 'signal'}): ${firstLine(execution.stderr)}`,
      },
    }
  }
  return { stdout: execution.stdout, rawFiles }
}

function failed(tool: string, rawFiles: string[], error: unknown): ToolResult {
  return {
    state: 'error',
    findings: [],
    rawFiles,
    reason: `could not parse ${tool} output: ${error instanceof Error ? error.message : String(error)}`,
  }
}

/** The parts of `fallow dead-code --format json` we report on. */
export interface FallowDeadCode {
  readonly version: string | undefined
  /**
   * How many entry points fallow discovered. Zero means it had nowhere to start
   * from, which makes every file "unused" — see {@link toDeadCodeFindings}.
   */
  readonly entryPoints: number
  readonly unusedFiles: readonly string[]
  readonly unusedExports: readonly FallowSymbol[]
  readonly unusedDependencies: readonly string[]
}

export interface FallowSymbol {
  readonly file: string
  readonly name: string
  readonly line: number
  readonly column: number
}

/** Exported so a fallow format shift fails a test (plan M4 checks). */
export function parseDeadCode(stdout: string): FallowDeadCode {
  const document = asRecord(JSON.parse(stdout))
  if (document === undefined || document['kind'] !== 'dead-code') {
    throw new Error('not a fallow dead-code report')
  }
  return {
    version: asString(document['version']),
    entryPoints: asNumber(asRecord(document['entry_points'])?.['total']) ?? 0,
    unusedFiles: paths(document['unused_files']),
    unusedExports: [
      ...symbols(document['unused_exports']),
      ...symbols(document['unused_types']),
    ].toSorted((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name)),
    unusedDependencies: [
      ...names(document['unused_dependencies']),
      ...names(document['unused_dev_dependencies']),
    ].toSorted(),
  }
}

/**
 * Dead-code results → the core's vocabulary, with spec §3's "high-confidence
 * only" rule applied through `gradeScope`:
 *
 * - **unused exports and types** are high confidence — fallow resolved the
 *   import graph and nothing reaches them — so they are graded.
 * - **unused files** are graded only when fallow found at least one entry
 *   point. With zero entry points every file is trivially unreachable, and a
 *   library or a fixture with no `main` would grade F for having no `main`.
 * - **unused dependencies** are dependency hygiene rather than dead code, and
 *   the false-positive rate without per-framework plugins is high, so they are
 *   reported as `info` and never graded.
 *
 * File- and symbol-level results carry an explicit anchor, so identity survives
 * every edit that does not move the symbol.
 */
export function toDeadCodeFindings(report: FallowDeadCode, repoConfig: boolean): PendingFinding[] {
  const provenance = repoConfig ? ('repo-config' as const) : ('default-config' as const)
  const fileLevel = report.entryPoints > 0

  const files = report.unusedFiles.map((file) => ({
    category: 'dead-code' as const,
    tool: FALLOW_DEAD_CODE_TOOL,
    rule: 'fallow/unused-file',
    severity: 'warning' as const,
    file,
    range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
    message: fileLevel
      ? 'File is never imported from any entry point'
      : 'File is never imported (advisory: fallow found no entry point to start from)',
    provenance,
    gradeScope: fileLevel,
    anchor: '',
  }))

  const exports = report.unusedExports.map((symbol) => ({
    category: 'dead-code' as const,
    tool: FALLOW_DEAD_CODE_TOOL,
    rule: 'fallow/unused-export',
    severity: 'warning' as const,
    file: symbol.file,
    range: {
      startLine: symbol.line,
      startCol: symbol.column,
      endLine: symbol.line,
      endCol: symbol.column,
    },
    message: `Export \`${symbol.name}\` is never used`,
    provenance,
    gradeScope: true,
    anchor: symbol.name,
  }))

  return [...files, ...exports].toSorted(byLocation)
}

/** The parts of `fallow health --complexity --format json` we report on. */
export interface FallowHealth {
  readonly version: string | undefined
  /** The `complexity` denominator: every function fallow measured. */
  readonly functionsAnalyzed: number
  readonly findings: readonly FallowComplexity[]
}

export interface FallowComplexity {
  readonly file: string
  readonly name: string
  readonly line: number
  readonly column: number
  readonly cognitive: number
  readonly cyclomatic: number
  readonly severity: string
  /** True when this function is over the cognitive ceiling, not just the others. */
  readonly exceedsCognitive: boolean
}

/** Exported so a fallow format shift fails a test (plan M4 checks). */
export function parseHealth(stdout: string): FallowHealth {
  const document = asRecord(JSON.parse(stdout))
  if (document === undefined || document['kind'] !== 'health') {
    throw new Error('not a fallow health report')
  }
  const summary = asRecord(document['summary'])
  const ceiling = asNumber(summary?.['max_cognitive_threshold']) ?? COMPLEXITY_CEILING

  const findings = (asArray(document['findings']) ?? []).flatMap((entry) => {
    const finding = asRecord(entry)
    const file = asString(finding?.['path'])
    if (finding === undefined || file === undefined) return []
    const cognitive = asNumber(finding['cognitive']) ?? 0
    return [
      {
        file: repoRelative(file),
        name: asString(finding['name']) ?? '',
        line: asNumber(finding['line']) ?? 1,
        column: asNumber(finding['col']) ?? 1,
        cognitive,
        cyclomatic: asNumber(finding['cyclomatic']) ?? 0,
        severity: asString(finding['severity']) ?? 'moderate',
        // fallow gates on several ceilings at once (cyclomatic, cognitive,
        // CRAP, unit size) and names the ones a function tripped; spec §3
        // grades on the cognitive one alone.
        exceedsCognitive: cognitive > ceiling,
      } satisfies FallowComplexity,
    ]
  })

  return {
    version: asString(document['version']),
    functionsAnalyzed: asNumber(summary?.['functions_analyzed']) ?? 0,
    findings,
  }
}

/**
 * Complexity results → the core's vocabulary. The grade is a ratio over the
 * metrics, not a count of findings, so `gradeScope` here is a label for the
 * reader: it marks the functions that actually drive the grade.
 */
export function toHealthFindings(report: FallowHealth, repoConfig: boolean): PendingFinding[] {
  return report.findings
    .map((finding) => ({
      category: 'complexity' as const,
      tool: FALLOW_HEALTH_TOOL,
      rule: 'fallow/complexity',
      severity: SEVERITY_BY_LEVEL[finding.severity] ?? 'info',
      file: finding.file,
      range: {
        startLine: finding.line,
        startCol: finding.column,
        endLine: finding.line,
        endCol: finding.column,
      },
      message:
        `Function \`${finding.name}\` has cognitive complexity ${finding.cognitive} ` +
        `(cyclomatic ${finding.cyclomatic}); the ceiling is ${COMPLEXITY_CEILING}`,
      provenance: repoConfig ? ('repo-config' as const) : ('default-config' as const),
      gradeScope: finding.exceedsCognitive,
      anchor: finding.name,
    }))
    .toSorted(byLocation)
}

function paths(value: unknown): string[] {
  return (asArray(value) ?? []).flatMap((entry) => {
    const path = asString(asRecord(entry)?.['path']) ?? asString(entry)
    return path === undefined ? [] : [repoRelative(path)]
  })
}

function names(value: unknown): string[] {
  return (asArray(value) ?? []).flatMap((entry) => {
    const name = asString(asRecord(entry)?.['name']) ?? asString(entry)
    return name === undefined ? [] : [name]
  })
}

function symbols(value: unknown): FallowSymbol[] {
  return (asArray(value) ?? []).flatMap((entry) => {
    const symbol = asRecord(entry)
    const file = asString(symbol?.['path']) ?? asString(symbol?.['file'])
    const name = asString(symbol?.['export_name']) ?? asString(symbol?.['name'])
    if (symbol === undefined || file === undefined || name === undefined) return []
    return [
      {
        file: repoRelative(file),
        name,
        line: asNumber(symbol['line']) ?? 1,
        column: asNumber(symbol['col']) ?? asNumber(symbol['column']) ?? 1,
      } satisfies FallowSymbol,
    ]
  })
}
