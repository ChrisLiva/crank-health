import { mapLimit } from './pool.ts'
import type {
  Category,
  CategoryOutcome,
  Detection,
  Finding,
  LanguageAdapter,
  RepoContext,
  RunnerScope,
  ToolMetrics,
  ToolResult,
  ToolRunner,
} from './types.ts'
import { CATEGORIES, categoryRank } from './types.ts'

/** How many tools run at once. */
export const DEFAULT_CONCURRENCY = 4

/** Per-tool wall clock budget (spec §5). */
export const DEFAULT_TIMEOUT_MS = 120_000

export interface ScanOptions {
  /** Max tools in flight. Default {@link DEFAULT_CONCURRENCY}. */
  readonly concurrency?: number
  /** Per-tool timeout handed to each runner and enforced here as a backstop. */
  readonly timeoutMs?: number
  /** `--only`: restrict the scan to these categories. Default: all of them. */
  readonly only?: readonly Category[]
}

/** One runner's full record: what it was, what it found, how it ended. */
export interface RunRecord {
  readonly tool: string
  readonly category: Category
  readonly scope: RunnerScope
  /** The version this release pins for ephemeral runs of this tool (spec §6). */
  readonly pinnedVersion: string
  readonly detection: Detection | null
  readonly result: ToolResult
  readonly durationMs: number
}

export interface ScanResult {
  /** Every finding from every runner, stable-sorted. */
  readonly findings: readonly Finding[]
  /** One record per runner that was asked to run, in adapter order. */
  readonly runs: readonly RunRecord[]
  /** Pre-grading state for every requested category. */
  readonly categories: Readonly<Record<Category, CategoryOutcome>>
  /** Merged {@link ToolMetrics} per category; see {@link aggregateMetrics}. */
  readonly metrics: Readonly<Record<Category, ToolMetrics>>
  /** Non-fatal problems that belong in the report but broke nothing. */
  readonly warnings: readonly string[]
}

/**
 * Runs detection, then every applicable runner under a concurrency cap and a
 * per-tool timeout, and aggregates the results.
 *
 * Isolation is the point (spec §8): a runner that throws becomes
 * `error`, one that outlives its budget becomes `timeout`, one whose
 * prerequisites are missing becomes `not-available` — and the scan finishes
 * either way. One tool can never abort the run.
 */
export async function runScan(
  repo: RepoContext,
  adapters: readonly LanguageAdapter[],
  options: ScanOptions = {},
): Promise<ScanResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const requested = options.only === undefined ? CATEGORIES : dedupe(options.only)
  const warnings: string[] = []

  const jobs = await plan(repo, adapters, requested, warnings)
  const records = await mapLimit(jobs, options.concurrency ?? DEFAULT_CONCURRENCY, (job) =>
    execute(repo, job, timeoutMs),
  )

  return {
    findings: sortFindings(records.flatMap((record) => record.result.findings)),
    runs: records,
    categories: aggregate(requested, records),
    metrics: aggregateMetrics(records),
    warnings,
  }
}

/**
 * Merges the {@link ToolMetrics} of every tool that ran successfully, per
 * category, with one rule per kind of number:
 *
 * - **counts** (`functionsTotal`, `functionsOverCeiling`, `formattableFiles`)
 *   are counts of *things in the repo*, and each tool only counts the things it
 *   was given. Two tools in the same language are looking at the same files, so
 *   the larger measurement wins; two tools in different languages are looking at
 *   disjoint files, so their measurements add. Hence: maximum within a language,
 *   sum across languages — which is what keeps a mixed JS+Python repo from
 *   grading its formatting against the file count of whichever language happens
 *   to be bigger.
 * - **percentages** (`duplicationPercent`, `mutationScore`) take the maximum:
 *   they are already whole-codebase figures, summing them would be meaningless,
 *   and the maximum is independent of the order tools finished in.
 *
 * A field no tool reported stays absent, which is how a category ends up
 * `not-assessed` rather than falsely graded at zero.
 */
export function aggregateMetrics(records: readonly RunRecord[]): Record<Category, ToolMetrics> {
  const merged = {} as Record<Category, ToolMetrics>
  for (const category of CATEGORIES) {
    const reported = records.filter(
      (record) => record.category === category && record.result.state === 'ok',
    )

    merged[category] = {
      ...combine(reported, 'functionsTotal', countAcrossScopes),
      ...combine(reported, 'functionsOverCeiling', countAcrossScopes),
      ...combine(reported, 'formattableFiles', countAcrossScopes),
      ...combine(reported, 'duplicationPercent', highest),
      ...combine(reported, 'mutationScore', highest),
    }
  }
  return merged
}

/** One tool's measurement of one field, tagged with the language it measured. */
interface ScopedValue {
  readonly scope: RunnerScope
  readonly value: number
}

function combine(
  reported: readonly RunRecord[],
  field: keyof ToolMetrics,
  fold: (values: readonly ScopedValue[]) => number,
): ToolMetrics {
  const values = reported.flatMap((record) => {
    const value = record.result.metrics?.[field]
    return value === undefined || !Number.isFinite(value)
      ? []
      : [{ scope: record.scope, value } satisfies ScopedValue]
  })
  return values.length === 0 ? {} : { [field]: fold(values) }
}

/** Maximum within each language, summed across them. See {@link aggregateMetrics}. */
function countAcrossScopes(values: readonly ScopedValue[]): number {
  const perScope = new Map<RunnerScope, number>()
  for (const { scope, value } of values) {
    perScope.set(scope, Math.max(perScope.get(scope) ?? Number.NEGATIVE_INFINITY, value))
  }
  return [...perScope.values()].reduce((total, value) => total + value, 0)
}

function highest(values: readonly ScopedValue[]): number {
  return values.reduce((best, { value }) => Math.max(best, value), Number.NEGATIVE_INFINITY)
}

/**
 * Stable finding order: category priority, then file, start line, rule, id.
 * Nothing here depends on the order runners happened to finish in.
 */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return findings.toSorted(
    (a, b) =>
      categoryRank(a.category) - categoryRank(b.category) ||
      compare(a.file, b.file) ||
      a.range.startLine - b.range.startLine ||
      compare(a.rule, b.rule) ||
      compare(a.id, b.id),
  )
}

interface Job {
  readonly runner: ToolRunner
  readonly scope: RunnerScope
  readonly detection: Detection | null
  /** Files this runner gets: its language's subset, or everything for `common`. */
  readonly files: readonly string[]
}

/** Detects languages, then per-runner ownership. Detection never runs a tool. */
async function plan(
  repo: RepoContext,
  adapters: readonly LanguageAdapter[],
  requested: readonly Category[],
  warnings: string[],
): Promise<Job[]> {
  const jobs: Job[] = []

  for (const adapter of adapters) {
    const runners = adapter.runners.filter((runner) => requested.includes(runner.category))
    if (runners.length === 0) continue

    const files =
      adapter.language === 'common' ? repo.files.all : repo.files.byLanguage[adapter.language]

    let applies: boolean
    try {
      // Detection is cheap and ordered; the concurrency cap covers the runs.
      // eslint-disable-next-line no-await-in-loop
      applies = await adapter.detect(repo)
    } catch (error) {
      warnings.push(`${adapter.language}: language detection failed: ${describe(error)}`)
      continue
    }
    if (!applies) continue

    const candidates: Job[] = []
    for (const runner of runners) {
      let detection: Detection | null = null
      try {
        // eslint-disable-next-line no-await-in-loop
        detection = await runner.detect(repo)
      } catch (error) {
        warnings.push(`${runner.tool}: detection failed, using default config: ${describe(error)}`)
      }
      // A tool crank-health never imposes as a default is simply absent from a
      // repo that did not choose it — not a failure, and not a reason for the
      // category to degrade (spec §1: `ToolRunner.repoOwnedOnly`).
      if (runner.repoOwnedOnly === true && detection === null) continue
      candidates.push({ runner, scope: adapter.language, detection, files })
    }

    jobs.push(...withoutRedundantDefaults(candidates))
  }

  return jobs
}

/**
 * Spec §1's two branches are exclusive: "Owned → run *their* tool with their
 * config … Not owned → *our* pinned default tool with a bundled config." So a
 * category this language already owns does not also get our default imposed on
 * it — a repo formatted with Biome is not badly formatted for disagreeing with
 * prettier's defaults, and grading it against both would say it was.
 *
 * Ownership is per language, not global: Python owning `ruff format` says
 * nothing about who formats the JavaScript next to it, so this is applied
 * within one adapter's runners.
 *
 * Two repo-owned tools in one category still both run and merge (spec §1's
 * "multiple tools detected for one category → run all"); it is only the
 * *default* that steps aside.
 *
 * None of this applies to runners that are not alternatives to each other; see
 * `ToolRunner.complementary`, which takes them out of the rule on both sides —
 * they neither confer ownership nor are stood down by it.
 */
function withoutRedundantDefaults(candidates: readonly Job[]): Job[] {
  const owned = new Set(
    candidates
      .filter((job) => job.detection !== null && job.runner.complementary !== true)
      .map((job) => job.runner.category),
  )
  return candidates.filter(
    (job) =>
      job.detection !== null ||
      job.runner.complementary === true ||
      !owned.has(job.runner.category),
  )
}

/** Runs one tool with every failure mode converted into a `ToolResult`. */
async function execute(repo: RepoContext, job: Job, timeoutMs: number): Promise<RunRecord> {
  const startedAt = Date.now()
  const result = await withTimeout(
    () =>
      job.runner.run({
        repoRoot: repo.repoRoot,
        files: job.files,
        scratch: repo.scratch,
        detection: job.detection,
        timeoutMs,
      }),
    timeoutMs,
    job.runner.tool,
  )
  return {
    tool: job.runner.tool,
    category: job.runner.category,
    scope: job.scope,
    pinnedVersion: job.runner.pinnedVersion,
    detection: job.detection,
    result,
    durationMs: Date.now() - startedAt,
  }
}

/**
 * Backstop timeout. Runners are expected to bound their own subprocesses
 * (execa `timeout`); this catches the ones that do not, and abandons the
 * pending promise so a wedged tool cannot hold the scan open.
 */
async function withTimeout(
  start: () => Promise<ToolResult>,
  timeoutMs: number,
  tool: string,
): Promise<ToolResult> {
  let timer: NodeJS.Timeout | undefined
  const expiry = new Promise<ToolResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          state: 'timeout',
          findings: [],
          rawFiles: [],
          reason: `${tool} exceeded its ${timeoutMs}ms budget`,
        }),
      timeoutMs,
    )
  })

  try {
    return await Promise.race([run(start, tool), expiry])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function run(start: () => Promise<ToolResult>, tool: string): Promise<ToolResult> {
  try {
    return await start()
  } catch (error) {
    return {
      state: 'error',
      findings: [],
      rawFiles: [],
      reason: `${tool} crashed: ${describe(error)}`,
    }
  }
}

/**
 * Per-category state from the runners that claimed it:
 * - any `ok` → `assessed` (multiple tools merge; a partial failure still grades
 *   on what did run, and the failure is visible in `runs`)
 * - otherwise `error` wins over `timeout` wins over `not-available`, because the
 *   loudest unexplained failure is the one worth reporting
 * - no runner at all → `not-assessed` (that language/tool is not present here)
 */
function aggregate(
  requested: readonly Category[],
  records: readonly RunRecord[],
): Record<Category, CategoryOutcome> {
  const outcomes = {} as Record<Category, CategoryOutcome>

  for (const category of CATEGORIES) {
    if (!requested.includes(category)) {
      outcomes[category] = { status: 'not-assessed', reason: 'not selected by --only' }
      continue
    }
    const mine = records.filter((record) => record.category === category)
    if (mine.length === 0) {
      outcomes[category] = { status: 'not-assessed', reason: 'no tool available for this category' }
      continue
    }
    if (mine.some((record) => record.result.state === 'ok')) {
      outcomes[category] = { status: 'assessed' }
      continue
    }
    const errored = mine.filter((record) => record.result.state === 'error')
    if (errored.length > 0) {
      outcomes[category] = { status: 'error', reason: reasons(errored) }
      continue
    }
    outcomes[category] = { status: 'not-assessed', reason: reasons(mine) }
  }

  return outcomes
}

function reasons(records: readonly RunRecord[]): string {
  return records
    .map((record) => record.result.reason ?? `${record.tool}: ${record.result.state}`)
    .join('; ')
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function dedupe(categories: readonly Category[]): Category[] {
  return CATEGORIES.filter((category) => categories.includes(category))
}

function compare(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
