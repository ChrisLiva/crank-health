import { isAbsolute, join } from 'node:path'
import type { ToolFailure } from '../../core/exec.ts'
import { writeScratchRaw } from '../../core/exec.ts'
import type {
  Category,
  Finding,
  PendingFinding,
  RunContext,
  ToolResult,
  ToolRunner,
} from '../../core/types.ts'
import { pinnedGoSpec, pinnedGoVersion } from '../../manifest.ts'
import {
  asNumber,
  asRecord,
  asString,
  byLocation,
  failed,
  firstLine,
  identify,
  repoRelative,
  scanMemo,
} from '../support.ts'
import {
  detectGoConfig,
  execGo,
  projectDirectory,
  withGoGate,
  withoutFetchNarration,
} from './go-toolchain.ts'

/**
 * `staticcheck -f json ./...` — one process, three categories.
 *
 * staticcheck answers three of spec §3's questions in a single analysis: the
 * `compile` records are the type checker's (`types`), the `U1000` family is the
 * unused-code pass (`dead-code`), and everything else is its lint suite
 * (`lint`). Running it three times would be three package-graph loads of the
 * same code for the same answers, so it runs **once per project** and the three
 * runners share the result — the `dotnet build` shape (`csharp/build.ts`),
 * through the memo both now use ({@link scanMemo}).
 *
 * Refusal beats a flattering grade. When the module graph will not load, the
 * compile record is about a *missing dependency* rather than about the repo's
 * own code, so all three runners report `error` with that sentence instead of
 * grading `types` a D on a check that never ran — the `NU1102` precedent
 * (`csharp/build.ts`'s `UNRESOLVED_PIN_REASON`).
 */

export const STATICCHECK_TOOL = 'staticcheck'

/** The import path `go run` fetches; pinned exactly in `manifest.ts`. */
const STATICCHECK_PACKAGE = 'honnef.co/go/tools/cmd/staticcheck'

/** The config file a repo owns staticcheck through, and its only name. */
const STATICCHECK_CONFIG = 'staticcheck.conf'

/**
 * Five minutes, like govulncheck's: this loads the whole package graph and, on
 * a cold module cache, downloads the analyzer first. `--timeout` still wins.
 */
const STATICCHECK_TIMEOUT_MS = 300_000

/** The name the one shared stream is staged under, per project. */
const RAW_NAME = 'staticcheck.jsonl'

/**
 * What one project's `staticcheck` run produced, shared by the three runners:
 * the findings of every category, identified once, plus the single staged
 * stream all three name as their evidence.
 */
interface StaticcheckScan {
  readonly findings: readonly Finding[]
  readonly rawFiles: readonly string[]
  /** Set when no category can be graded from this run; all three report it. */
  readonly failure?: ToolFailure
  /** Set when the run was fine but had nothing to look at. */
  readonly emptyReason?: string
}

/** What the parser reads off one stream; see {@link parseStaticcheckStream}. */
export interface StaticcheckOutcome {
  /**
   * The compile record's message when the run could not load the module graph.
   * Present *instead of* findings, never beside them.
   */
  readonly moduleGraphFailure?: string
  readonly findings: readonly PendingFinding[]
}

/** One scan's staticcheck runs; released by {@link forgetStaticcheck}. */
const scans = scanMemo<StaticcheckScan>()

/**
 * Releases every staticcheck run memoized under a scan's scratch dir — called
 * from `run.ts`'s and `run-pr.ts`'s teardowns beside `forgetBuilds`. Wiring
 * only one of the two would leak a PR run's base findings into its head pass.
 */
export function forgetStaticcheck(runScratch: string): void {
  scans.forget(runScratch)
}

/** `types` from the one memoized run: the compile records. */
export const staticcheckTypesRunner: ToolRunner = staticcheckRunner('types')

/** `dead-code` from the one memoized run: the `U`-prefixed unused checks. */
export const staticcheckDeadCodeRunner: ToolRunner = staticcheckRunner('dead-code')

/** `lint` from the one memoized run: every other check staticcheck ran. */
export const staticcheckLintRunner: ToolRunner = staticcheckRunner('lint')

/** The shape the three share; only the category — and its slice — differ. */
function staticcheckRunner(category: StaticcheckCategory): ToolRunner {
  return {
    tool: STATICCHECK_TOOL,
    category,
    pinnedVersion: pinnedGoVersion(STATICCHECK_PACKAGE),
    timeoutMs: STATICCHECK_TIMEOUT_MS,
    // The shared ancestor walk, so the three agree about ownership and
    // `Detection.configFiles` is filled by the one place that fills it.
    detect: (ctx) => detectGoConfig(ctx, [STATICCHECK_CONFIG]),
    run: withGoGate(async (ctx) => resultFor(await scans.for(ctx, runStaticcheck), category, ctx)),
  }
}

/** The three categories one staticcheck run answers for. */
type StaticcheckCategory = Extract<Category, 'types' | 'dead-code' | 'lint'>

/**
 * One category's view of the shared run. Every runner reports the same state
 * and the same reason — they read one process's outcome — and each returns only
 * the findings that are its own.
 */
async function resultFor(
  scan: StaticcheckScan,
  category: StaticcheckCategory,
  ctx: RunContext,
): Promise<ToolResult> {
  const configOwned = ctx.detection !== null
  if (scan.failure !== undefined) {
    return { ...failed(scan.failure, scan.rawFiles), configOwned }
  }
  return Promise.resolve({
    state: 'ok',
    findings: scan.findings.filter((finding) => finding.category === category),
    rawFiles: scan.rawFiles,
    // `go run <import-path>@<version>` is an exact spec with no resolution step
    // that could land elsewhere, so the pin is what ran (spec §6).
    toolVersion: pinnedGoVersion(STATICCHECK_PACKAGE),
    ...(scan.emptyReason === undefined ? {} : { reason: scan.emptyReason }),
    configOwned,
  })
}

/**
 * The one invocation. `./...` is every package of the module at `cwd` and stops
 * at a nested module's boundary, so a project's run measures the project.
 */
function invocationArgs(): string[] {
  return ['run', pinnedGoSpec(STATICCHECK_PACKAGE), '-f', 'json', './...']
}

/**
 * The run itself, memoized: spawn once, stage the stream once, identify once.
 *
 * **Exit 1 is not a failure.** staticcheck exits 1 whenever it reported
 * anything at all (probed on v0.7.0), so the exit code alone cannot separate "I
 * found problems" from "I could not run". What separates them is whether the
 * stream carries records: exit non-zero with nothing parsed is the tool failing
 * and says so with its own stderr.
 */
async function runStaticcheck(ctx: RunContext): Promise<StaticcheckScan> {
  if (ctx.files.length === 0) {
    return { findings: [], rawFiles: [], emptyReason: 'no Go files' }
  }

  const execution = await execGo(ctx, invocationArgs())
  if (execution.failure !== undefined) {
    return { findings: [], rawFiles: [], failure: execution.failure }
  }

  // Staged once, inside the memoized run, so all three runners' records name
  // this one file rather than three copies of the same bytes.
  const rawFiles = [await writeScratchRaw(ctx.scratch, RAW_NAME, execution.stdout)]

  const outcome = parseStaticcheckStream(execution.stdout, projectDirectory(ctx), ctx.repoRoot)
  if (outcome.moduleGraphFailure !== undefined) {
    return {
      findings: [],
      rawFiles,
      failure: {
        state: 'error',
        reason: `staticcheck could not load the module graph: ${outcome.moduleGraphFailure}`,
      },
    }
  }
  if (outcome.findings.length === 0 && execution.exitCode !== 0) {
    return {
      findings: [],
      rawFiles,
      failure: {
        state: 'error',
        reason:
          `staticcheck exited ${execution.exitCode ?? 'signal'} with nothing to report: ` +
          // Stripped of fetch narration first: on a cold cache the literal
          // first line is `go: downloading …`, which would explain the failure
          // with whatever `go` was fetching at the time — and `reason` is a
          // `report.json` field, so a cold run would differ from a warm one.
          firstLine(withoutFetchNarration(execution.stderr)),
      },
    }
  }

  // Only the files this scan owns: `./...` walks the project's directories, and
  // a vendored or generated file discovery excluded is not the repo's to answer
  // for. The repo's own config decides the findings when it owns one.
  const analyzed = new Set(ctx.files)
  const repoConfig = ctx.detection !== null
  const pending = outcome.findings
    .filter((finding) => analyzed.has(finding.file))
    .map((finding) => (repoConfig ? { ...finding, provenance: 'repo-config' as const } : finding))
  return { findings: await identify(ctx.repoRoot, pending.toSorted(byLocation)), rawFiles }
}

/**
 * One record per line, routed by its `code`, with the refusal verdict and the
 * findings read off the same records — one function, because no caller may take
 * one without the other: findings from a run whose module graph collapsed are
 * findings about a package set that was never fully loaded.
 *
 * `code` is what decides the category: `compile` is the type checker's,
 * anything under `U` is the unused pass's (`U1000`), and every other check
 * staticcheck ships — `SA`, `S1`, `ST1`, `QF1` — is lint. The fallback is lint
 * rather than a drop, so a check family added in a later staticcheck release
 * lands in a report instead of vanishing from one.
 *
 * @param projectDir absolute directory the run happened in, which is what the
 * tool's relative paths are relative to
 */
export function parseStaticcheckStream(
  jsonl: string,
  projectDir: string,
  repoRoot: string,
): StaticcheckOutcome {
  const findings: PendingFinding[] = []
  for (const line of jsonl.split('\n')) {
    const record = asRecord(parseLine(line))
    if (record === undefined) continue
    const code = asString(record['code'])
    const message = asString(record['message'])
    if (code === undefined || message === undefined) continue

    if (code === COMPILE_CODE && isModuleGraphFailure(message)) {
      return { moduleGraphFailure: message, findings: [] }
    }
    const placed = place(record, message, projectDir, repoRoot)
    if (placed === undefined) continue
    findings.push(toPendingFinding(code, placed))
  }
  return { findings }
}

/** staticcheck's own code for a record the type checker produced. */
const COMPILE_CODE = 'compile'

/**
 * The three sentences `go` uses for "this package is not in the module graph",
 * quoted from the toolchain: a missing dependency, a dependency the graph does
 * not provide, and the `-mod=readonly` refusal to add one (probed on go 1.26.6
 * with a `staticcheck v0.7.0` run against an absent import).
 */
const MODULE_GRAPH_FAILURES: readonly string[] = [
  'cannot find module providing package',
  'no required module provides',
  'import lookup disabled',
]

function isModuleGraphFailure(message: string): boolean {
  return MODULE_GRAPH_FAILURES.some((phrase) => message.includes(phrase))
}

/** A record's line, ignoring the blank ones and anything that is not an object. */
function parseLine(line: string): unknown {
  if (line.trim().length === 0) return undefined
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/** Where a record points and what it says, once the location is resolved. */
interface Placed {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly endLine: number
  readonly endColumn: number
  readonly message: string
}

/**
 * A record's place in the repo. staticcheck reports it three ways (probed on
 * v0.7.0): an **absolute** path for a check it ran, a path **relative** to the
 * run's directory for a module-graph compile error, and an **empty** one for an
 * in-package type error — whose message carries `# <package>` and then
 * `file:line:col: …` instead. All three land on one repo-relative posix path.
 */
function place(
  record: Record<string, unknown>,
  message: string,
  projectDir: string,
  repoRoot: string,
): Placed | undefined {
  const location = asRecord(record['location'])
  const end = asRecord(record['end'])
  const file = asString(location?.['file']) ?? ''
  if (file !== '') {
    // `end` is zeroed on the checks that flag a symbol rather than a span
    // (`U1000`), and a zero line is not a place: the start stands in for it.
    const line = asNumber(location?.['line']) ?? 1
    const column = asNumber(location?.['column']) ?? 1
    return {
      file: underRoot(file, projectDir, repoRoot),
      line,
      column,
      endLine: positive(asNumber(end?.['line'])) ?? line,
      endColumn: positive(asNumber(end?.['column'])) ?? column,
      message,
    }
  }

  const embedded = EMBEDDED_LOCATION.exec(message)?.groups
  if (embedded === undefined) return undefined
  const line = Number(embedded['line'])
  const column = Number(embedded['column'])
  return {
    file: underRoot(embedded['file'] ?? '', projectDir, repoRoot),
    line,
    column,
    endLine: line,
    endColumn: column,
    message: embedded['message'] ?? message,
  }
}

/** A one-based coordinate, or `undefined` where the tool reported none. */
function positive(value: number | undefined): number | undefined {
  return value !== undefined && value > 0 ? value : undefined
}

/**
 * The `file:line:col: message` an in-package compile record embeds, after the
 * `# <package>` line the toolchain heads it with — matched by name, and
 * multiline so the package header is skipped rather than parsed.
 */
const EMBEDDED_LOCATION = /^(?<file>[^\n:]+\.go):(?<line>\d+):(?<column>\d+): (?<message>[^\n]*)$/m

/** A tool-reported path — absolute or relative to the run — as the repo sees it. */
function underRoot(file: string, projectDir: string, repoRoot: string): string {
  return repoRelative(isAbsolute(file) ? file : join(projectDir, file), repoRoot)
}

/**
 * The core's vocabulary. Severity is the category's and not staticcheck's,
 * which labels every record `error`: a compile record *is* an error, while a
 * simplification suggestion graded as one would put a D on a repo for a style
 * note (`core/grade.ts` reads severity, not counts, for its worst grades).
 */
function toPendingFinding(code: string, placed: Placed): PendingFinding {
  const category = categoryOf(code)
  return {
    category,
    tool: STATICCHECK_TOOL,
    rule: code,
    severity: category === 'types' ? 'error' : 'warning',
    file: placed.file,
    range: {
      startLine: placed.line,
      startCol: placed.column,
      endLine: placed.endLine,
      endCol: placed.endColumn,
    },
    message: placed.message,
    // Overridden by the runner when the repo owns a `staticcheck.conf`.
    provenance: 'default-config',
    gradeScope: true,
  }
}

function categoryOf(code: string): StaticcheckCategory {
  if (code === COMPILE_CODE) return 'types'
  return UNUSED_CODE.test(code) ? 'dead-code' : 'lint'
}

/** staticcheck's unused pass: `U1000` and anything else it adds under `U`. */
const UNUSED_CODE = /^U\d/
