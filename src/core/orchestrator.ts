import { mapLimit } from './pool.ts'
import type {
  Category,
  CategoryOutcome,
  Detection,
  Finding,
  LanguageAdapter,
  RepoContext,
  RunnerScope,
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
    warnings,
  }
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

    for (const runner of runners) {
      let detection: Detection | null = null
      try {
        // eslint-disable-next-line no-await-in-loop
        detection = await runner.detect(repo)
      } catch (error) {
        warnings.push(`${runner.tool}: detection failed, using default config: ${describe(error)}`)
      }
      jobs.push({ runner, scope: adapter.language, detection, files })
    }
  }

  return jobs
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
