import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execTool, ephemeralCommand, repoCommand, writeScratchRaw } from '../../core/exec.ts'
import { computeAnchors } from '../../core/fingerprint.ts'
import { readSources } from '../../core/discover.ts'
import type {
  Detection,
  Finding,
  PendingFinding,
  RepoContext,
  RunContext,
  Severity,
  ToolResult,
  ToolRunner,
} from '../../core/types.ts'
import { pinnedVersion } from '../../manifest.ts'

/**
 * oxlint — crank-health's default JS/TS linter (spec "Categories and tools").
 *
 * Three run modes, per spec §1:
 * 1. repo-owned and installed → their binary, their config, `repo-config`
 * 2. repo-owned, not installed → our pinned oxlint, still their config
 * 3. not repo-owned → our pinned oxlint with {@link DEFAULT_CONFIG} written
 *    into the scratch dir, `default-config`, and only correctness-class rules
 *    count toward the grade
 */

export const OXLINT_TOOL = 'oxlint'

/** Root config artifacts that make oxlint repo-owned (spec §1, first check). */
export const OXLINT_CONFIG_FILES: readonly string[] = [
  '.oxlintrc.json',
  '.oxlintrc.jsonc',
  'oxlint.config.js',
  'oxlint.config.mjs',
  'oxlint.config.cjs',
  'oxlint.config.ts',
  'oxlint.config.mts',
  'oxlint.config.json',
  'oxlint.config.jsonc',
]

/**
 * Our bundled default config, materialized into the scratch dir for mode 3 —
 * never written into the target repo.
 *
 * `correctness` findings are things that are outright wrong, so they are graded;
 * `suspicious` and `perf` are reported as advisory signal. Deliberately no
 * `style`/`pedantic`: a repo that never opted into an opinionated style should
 * not be graded (or nagged) on one.
 */
export const DEFAULT_CONFIG = {
  plugins: ['typescript', 'unicorn', 'oxc'],
  categories: { correctness: 'error', suspicious: 'warn', perf: 'warn' },
  env: { builtin: true, node: true, browser: true, es2024: true },
} as const

/** oxlint rule categories that count toward the grade on our default config. */
const GRADED_RULE_CATEGORIES: ReadonlySet<string> = new Set(['correctness'])

/**
 * Adapter-owned severity mapping (spec §2). oxlint reports SARIF levels; lint
 * never produces `critical`, which the absolute security shape reserves for
 * secrets.
 */
const SEVERITY_BY_LEVEL: Readonly<Record<string, Severity>> = {
  error: 'error',
  warning: 'warning',
  note: 'info',
  none: 'info',
}

/**
 * Argument-list budget for one oxlint invocation. Real repos have more files
 * than a command line can hold, so the file list is spent across several runs
 * and their findings merged.
 */
const MAX_ARGS_BYTES = 100_000

export const oxlintRunner: ToolRunner = {
  tool: OXLINT_TOOL,
  category: 'lint',
  pinnedVersion: pinnedVersion('oxlint'),
  detect: detectOxlint,
  run: runOxlint,
}

/**
 * Repo-owned when a config artifact exists or oxlint is a declared dependency.
 * `package.json` scripts corroborate but never decide (spec §1), so they are
 * not consulted here at all.
 */
async function detectOxlint(repo: RepoContext): Promise<Detection | null> {
  const configFiles = OXLINT_CONFIG_FILES.filter((file) => repo.files.all.includes(file))
  const declared = await isDeclaredDependency(repo.repoRoot)
  if (configFiles.length === 0 && !declared) return null

  const reason: Detection['reason'] =
    configFiles.length > 0 && declared
      ? 'config+dependency'
      : configFiles.length > 0
        ? 'config'
        : 'dependency'

  const binPath = join(repo.repoRoot, 'node_modules', '.bin', OXLINT_TOOL)
  const installed = await exists(binPath)
  const version = installed ? await installedVersion(repo.repoRoot) : undefined

  return {
    reason,
    configFiles,
    installed,
    ...(installed ? { binPath } : {}),
    ...(version === undefined ? {} : { version }),
  }
}

async function runOxlint(ctx: RunContext): Promise<ToolResult> {
  if (ctx.files.length === 0) {
    return { state: 'ok', findings: [], rawFiles: [], reason: 'no JavaScript or TypeScript files' }
  }

  const useRepoConfig = ctx.detection !== null
  const configArgs = useRepoConfig ? [] : await materializeDefaultConfig(ctx.scratch)
  const command =
    ctx.detection?.installed === true && ctx.detection.binPath !== undefined
      ? repoCommand(ctx.detection.binPath, [])
      : ephemeralCommand(OXLINT_TOOL, [])

  const batches = batchFiles(ctx.files)
  const pending: PendingFinding[] = []
  const rawFiles: string[] = []
  let toolVersion: string | undefined

  for (const [index, batch] of batches.entries()) {
    const suffix = batches.length === 1 ? '' : `.${index + 1}`
    // Sequential by design: one tool, one machine — the orchestrator provides
    // the parallelism, and batches share the raw-output namespace.
    // eslint-disable-next-line no-await-in-loop
    const execution = await execTool(
      { ...command, args: [...command.args, ...BASE_ARGS, ...configArgs, ...batch] },
      { cwd: ctx.repoRoot, timeoutMs: ctx.timeoutMs },
    )

    // eslint-disable-next-line no-await-in-loop
    rawFiles.push(...(await stageRaw(ctx.scratch, suffix, execution.stdout, execution.stderr)))

    if (execution.failure !== undefined) {
      return {
        state: execution.failure.state,
        findings: [],
        rawFiles,
        reason: execution.failure.reason,
      }
    }

    // A run that matched no files after the repo's own ignore patterns prints
    // nothing at all; that is an empty result, not a broken one.
    if (execution.stdout.trim().length === 0) {
      if (execution.exitCode === 0) continue
      return {
        state: 'error',
        findings: [],
        rawFiles,
        reason: `oxlint produced no output (exit ${execution.exitCode ?? 'signal'}): ${firstLine(execution.stderr)}`,
      }
    }

    let report: SarifReport
    try {
      report = parseSarif(execution.stdout)
    } catch (error) {
      return {
        state: 'error',
        findings: [],
        rawFiles,
        reason: `could not parse oxlint output: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    toolVersion ??= report.version
    pending.push(...toPendingFindings(report, useRepoConfig))
  }

  return {
    state: 'ok',
    findings: await identify(ctx.repoRoot, pending),
    ...(toolVersion === undefined ? {} : { toolVersion }),
    rawFiles,
  }
}

/**
 * Flags shared by every invocation. SARIF is the parse target because it is the
 * one oxlint format carrying exact ranges, the rule's category (which decides
 * `gradeScope` on default configs) and the resolved tool version.
 */
const BASE_ARGS: readonly string[] = [
  '--format',
  'sarif',
  // We hand oxlint an explicit, already gitignore-filtered file list; a path
  // that the repo's own ignore patterns then drop must not fail the run.
  '--no-error-on-unmatched-pattern',
]

/** What a parsed SARIF run tells us. Everything else in the document is noise. */
export interface SarifReport {
  readonly version: string | undefined
  readonly results: readonly SarifFinding[]
}

export interface SarifFinding {
  readonly ruleId: string
  /** The oxlint rule category (`correctness`, `perf`, …), when SARIF has one. */
  readonly ruleCategory: string | undefined
  readonly level: string
  readonly message: string
  readonly file: string
  readonly startLine: number
  readonly startCol: number
  readonly endLine: number
  readonly endCol: number
}

/**
 * Parses one oxlint SARIF document. Exported so the wrapper can be tested
 * against captured raw output (plan M4 checks, applied from M3 on): a format
 * shift then fails a test instead of corrupting a report.
 *
 * @throws {Error} when the payload is not a SARIF document we recognize
 */
export function parseSarif(stdout: string): SarifReport {
  const document: unknown = JSON.parse(stdout)
  const run = asRecord(asArray(asRecord(document)?.['runs'])?.[0])
  if (run === undefined) throw new Error('no SARIF run in output')

  const driver = asRecord(asRecord(run['tool'])?.['driver'])
  const rules = asArray(driver?.['rules']) ?? []
  const categories = rules.map((rule) =>
    asString(asRecord(asRecord(rule)?.['properties'])?.['category']),
  )

  const results = (asArray(run['results']) ?? []).flatMap((entry) => {
    const result = asRecord(entry)
    if (result === undefined) return []

    const physical = asRecord(asRecord(asArray(result['locations'])?.[0])?.['physicalLocation'])
    const region = asRecord(physical?.['region'])
    const file = asString(asRecord(physical?.['artifactLocation'])?.['uri'])
    const ruleId = asString(result['ruleId'])
    if (file === undefined || ruleId === undefined) return []

    const startLine = asNumber(region?.['startLine']) ?? 1
    const startCol = asNumber(region?.['startColumn']) ?? 1
    const ruleIndex = asNumber(result['ruleIndex'])
    return [
      {
        ruleId,
        ruleCategory: ruleIndex === undefined ? undefined : categories[ruleIndex],
        level: asString(result['level']) ?? 'warning',
        message: asString(asRecord(result['message'])?.['text']) ?? '',
        file: normalizePath(file),
        startLine,
        startCol,
        endLine: asNumber(region?.['endLine']) ?? startLine,
        endCol: asNumber(region?.['endColumn']) ?? startCol,
      } satisfies SarifFinding,
    ]
  })

  return { version: asString(driver?.['version']), results }
}

/**
 * SARIF findings → the core's vocabulary.
 *
 * On a repo's own config every finding is graded: the repo chose these rules and
 * is violating them. On our default config only correctness-class rules count;
 * the rest stay advisory (spec §1). oxlint's own diagnostics (syntax errors,
 * which carry no rule category) are graded — a file that will not parse is
 * broken by anyone's standard.
 */
export function toPendingFindings(report: SarifReport, repoConfig: boolean): PendingFinding[] {
  return report.results
    .map((result) => ({
      category: 'lint' as const,
      tool: OXLINT_TOOL,
      rule: result.ruleId,
      severity: SEVERITY_BY_LEVEL[result.level] ?? 'warning',
      file: result.file,
      range: {
        startLine: result.startLine,
        startCol: result.startCol,
        endLine: result.endLine,
        endCol: result.endCol,
      },
      message: result.message,
      provenance: repoConfig ? ('repo-config' as const) : ('default-config' as const),
      gradeScope:
        repoConfig ||
        result.ruleCategory === undefined ||
        GRADED_RULE_CATEGORIES.has(result.ruleCategory),
    }))
    .toSorted(byLocation)
}

/**
 * Identity is the core's job (`hash(category, tool, rule, file, anchor)`), and
 * it needs the flagged source lines — so the files that actually carry findings
 * are read here, and only those.
 */
async function identify(repoRoot: string, pending: readonly PendingFinding[]): Promise<Finding[]> {
  if (pending.length === 0) return []
  const sources = await readSources(
    repoRoot,
    pending.map((finding) => finding.file),
  )
  return computeAnchors(pending, sources)
}

/**
 * oxlint lints files in parallel, so its output order is not guaranteed. Sort
 * before the core sees them: occurrence numbering must not depend on which
 * worker thread finished first.
 */
function byLocation(a: PendingFinding, b: PendingFinding): number {
  return (
    compare(a.file, b.file) ||
    a.range.startLine - b.range.startLine ||
    a.range.startCol - b.range.startCol ||
    compare(a.rule, b.rule) ||
    compare(a.message, b.message)
  )
}

/** Writes {@link DEFAULT_CONFIG} into scratch and returns the `-c` arguments. */
async function materializeDefaultConfig(scratch: string): Promise<string[]> {
  const directory = join(scratch, OXLINT_TOOL)
  await mkdir(directory, { recursive: true })
  const target = join(directory, 'oxlintrc.json')
  await writeFile(target, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8')
  // Nested configs would let the target repo influence a run it does not own.
  return ['--config', target, '--disable-nested-config']
}

/** Raw evidence for the run directory (spec §8: stderr is always kept). */
async function stageRaw(
  scratch: string,
  suffix: string,
  stdout: string,
  stderr: string,
): Promise<string[]> {
  const staged = [await writeScratchRaw(scratch, `oxlint${suffix}.sarif.json`, stdout)]
  if (stderr.trim().length > 0) {
    staged.push(await writeScratchRaw(scratch, `oxlint${suffix}.stderr.txt`, stderr))
  }
  return staged
}

/** Splits the file list so no single command line exceeds {@link MAX_ARGS_BYTES}. */
export function batchFiles(files: readonly string[], budget = MAX_ARGS_BYTES): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  let size = 0

  for (const file of files) {
    const cost = Buffer.byteLength(file, 'utf8') + 1
    if (current.length > 0 && size + cost > budget) {
      batches.push(current)
      current = []
      size = 0
    }
    current.push(file)
    size += cost
  }
  if (current.length > 0) batches.push(current)
  return batches
}

async function isDeclaredDependency(repoRoot: string): Promise<boolean> {
  const manifest = asRecord(await readJson(join(repoRoot, 'package.json')))
  if (manifest === undefined) return false
  return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some(
    (field) => asRecord(manifest[field])?.[OXLINT_TOOL] !== undefined,
  )
}

/** The installed version, read from disk — detection never spawns a process. */
async function installedVersion(repoRoot: string): Promise<string | undefined> {
  const manifest = asRecord(
    await readJson(join(repoRoot, 'node_modules', OXLINT_TOOL, 'package.json')),
  )
  return asString(manifest?.['version'])
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function normalizePath(file: string): string {
  return file.replace(/^\.\//, '')
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}

function compare(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
