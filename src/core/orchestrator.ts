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

/**
 * Per-tool budget for a {@link ToolRunner.deepOnly} runner — spec §5's "much
 * larger budget". A mutation run executes the repo's whole test suite once per
 * mutant; two minutes is not a timeout for that, it is a guarantee of one.
 * Fifteen minutes is generous enough that a real suite finishes and small enough
 * that a wedged one still ends.
 */
export const DEEP_TIMEOUT_MS = 900_000

export interface ScanOptions {
  /** Max tools in flight. Default {@link DEFAULT_CONCURRENCY}. */
  readonly concurrency?: number
  /** Per-tool timeout handed to each runner and enforced here as a backstop. */
  readonly timeoutMs?: number
  /** The same, for deep runners. Default {@link DEEP_TIMEOUT_MS}. */
  readonly deepTimeoutMs?: number
  /** `--only`: restrict the scan to these categories. Default: all of them. */
  readonly only?: readonly Category[]
  /** `--deep` (spec §5): also run the {@link ToolRunner.deepOnly} runners. */
  readonly deep?: boolean
  /** PR mode: the paths this change touched; see {@link RunContext.changedFiles}. */
  readonly changedFiles?: readonly string[]
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
  /**
   * True when this runner is our default, scheduled behind an owner that might
   * not manage to run — see {@link withoutRedundantDefaults}. Internal to the
   * scan: it is resolved away by {@link resolveStandby} before anything reads
   * the records, and it is never serialized.
   */
  readonly standby: boolean
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
  const deep = options.deep === true
  const budgets: Budgets = {
    normal: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    deep: options.deepTimeoutMs ?? DEEP_TIMEOUT_MS,
  }
  const requested = options.only === undefined ? CATEGORIES : dedupe(options.only)
  const warnings: string[] = []

  const jobs = await plan(repo, adapters, requested, deep, warnings)
  const records = await mapLimit(jobs, options.concurrency ?? DEFAULT_CONCURRENCY, (job) =>
    execute(repo, job, budgets, {
      deep,
      ...(options.changedFiles === undefined ? {} : { changedFiles: options.changedFiles }),
    }),
  )
  const resolved = resolveStandby(jobs, records, warnings)

  return {
    findings: sortFindings(resolved.flatMap((record) => record.result.findings)),
    runs: resolved,
    categories: aggregate(requested, resolved),
    metrics: aggregateMetrics(resolved),
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
 * - **percentages** (`duplicationPercent`, `lineCoveragePercent`) take the
 *   maximum: they are already whole-codebase figures, summing them would be
 *   meaningless, and the maximum is independent of the order tools finished in.
 * - **the mutation score** is the one percentage that is *recomputed* rather
 *   than merged, out of the detected and undetected counts — see
 *   {@link combinedMutationScore}.
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
    const detected = combine(reported, 'mutantsDetected', countAcrossScopes)
    const undetected = combine(reported, 'mutantsUndetected', countAcrossScopes)

    merged[category] = {
      ...combine(reported, 'functionsTotal', countAcrossScopes),
      ...combine(reported, 'functionsOverCeiling', countAcrossScopes),
      ...combine(reported, 'formattableFiles', countAcrossScopes),
      ...combine(reported, 'duplicationPercent', highest),
      ...combinedMutationScore(reported, detected, undetected),
      ...detected,
      ...undetected,
      ...combine(reported, 'lineCoveragePercent', highest),
    }
  }
  return merged
}

/**
 * The mutation score over every language at once: detected mutants as a share
 * of the mutants that had a verdict either way.
 *
 * The maximum rule the other percentages use would be wrong here, and wrong in
 * the flattering direction: a repo whose JavaScript scores 90 and whose Python
 * scores 20 does not have a 90 test-quality. Re-deriving it from the counts is
 * the same arithmetic each tool did, applied once over the union — which is
 * exactly spec §3's "one grade per category over combined normalized findings".
 *
 * A tool that reported a score but no counts (a format we could not break down)
 * still contributes through the fallback.
 */
function combinedMutationScore(
  reported: readonly RunRecord[],
  detected: ToolMetrics,
  undetected: ToolMetrics,
): ToolMetrics {
  const total = (detected.mutantsDetected ?? 0) + (undetected.mutantsUndetected ?? 0)
  if (total <= 0) return combine(reported, 'mutationScore', highest)
  return { mutationScore: ((detected.mutantsDetected ?? 0) / total) * 100 }
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
  /** Our default, running behind an owner that may not manage to. */
  readonly standby: boolean
}

/** Detects languages, then per-runner ownership. Detection never runs a tool. */
async function plan(
  repo: RepoContext,
  adapters: readonly LanguageAdapter[],
  requested: readonly Category[],
  deep: boolean,
  warnings: string[],
): Promise<Job[]> {
  const jobs: Job[] = []

  for (const adapter of adapters) {
    const runners = adapter.runners.filter(
      // A deep runner in a quick scan is not a job that declined; it is not a
      // job (spec §5). Nothing is recorded for it, so the category degrades with
      // the profile's own reason rather than with a tool's.
      (runner) => requested.includes(runner.category) && (deep || runner.deepOnly !== true),
    )
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
      candidates.push({ runner, scope: adapter.language, detection, files, standby: false })
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
 *
 * The exception is an owner that may not be able to speak at all. A
 * `repoOwnedOnly` tool the repo declared but did not install has to be fetched
 * before it can grade anything, and that fetch can fail — at which point
 * dropping our default would leave the category ungraded on the strength of a
 * tool that never ran. Such an owner therefore *claims* the category without
 * *suppressing* it: our default is kept as a **standby**, runs, and is resolved
 * afterwards by {@link resolveStandby} — stood down if the owner graded the
 * category, promoted if it did not.
 */
function withoutRedundantDefaults(candidates: readonly Job[]): Job[] {
  const suppressed = new Set(candidates.filter(canRun).map((job) => job.runner.category))
  const claimed = new Set(candidates.filter(owns).map((job) => job.runner.category))

  // A flatMap over the candidates keeps them in candidate order; `runs` is in
  // job order, and appending the kept standbys at the end would reorder it.
  return candidates.flatMap((job) => {
    if (job.detection !== null || job.runner.complementary === true) return [job]
    if (suppressed.has(job.runner.category)) return []
    if (claimed.has(job.runner.category)) return [{ ...job, standby: true }]
    return [job]
  })
}

/** This runner claims its category: the repo chose it, and it is an alternative. */
function owns(job: Job): boolean {
  return job.detection !== null && job.runner.complementary !== true
}

/** …and it can be counted on to actually grade it, without a fetch that may fail. */
function canRun(job: Job): boolean {
  return owns(job) && (job.runner.repoOwnedOnly !== true || (job.detection?.installed ?? false))
}

/**
 * Settles what each standby run was for, once every runner has finished.
 *
 * Owner identity comes from the *jobs*, keyed by category and language scope, so
 * a complementary runner that happened to succeed cannot stand a standby down —
 * it never conferred ownership in the first place — and nothing depends on
 * records and jobs lining up by index.
 *
 * Records are rebuilt, never mutated.
 */
function resolveStandby(
  jobs: readonly Job[],
  records: readonly RunRecord[],
  warnings: string[],
): RunRecord[] {
  if (!jobs.some((job) => job.standby)) return [...records]

  const owners = new Map<string, Set<string>>()
  for (const job of jobs) {
    if (job.standby || job.detection === null || job.runner.complementary === true) continue
    const key = ownerKey(job.runner.category, job.scope)
    const tools = owners.get(key) ?? new Set<string>()
    tools.add(job.runner.tool)
    owners.set(key, tools)
  }

  return records.map((record) => {
    if (!record.standby) return record
    const mine = owners.get(ownerKey(record.category, record.scope)) ?? new Set<string>()
    const ownerRecords = records.filter(
      (other) =>
        other.category === record.category && other.scope === record.scope && mine.has(other.tool),
    )

    const graded = ownerRecords.filter((other) => other.result.state === 'ok')
    if (graded.length > 0) return stoodDown(record, graded)

    // Nobody who claimed the category managed to grade it, so the standby's
    // grade is the one the repo gets — on our config, not theirs. That is a
    // difference the repo has to be told about, in fixed words that name only
    // tools and states: a runner's own reason can carry local paths.
    if (ownerRecords.length > 0 && record.result.state === 'ok') {
      const because = ownerRecords
        .toSorted((a, b) => compare(a.tool, b.tool))
        .map((other) => `${other.tool} reported ${other.result.state}`)
        .join(', ')
      warnings.push(
        `${record.tool}: graded ${record.category} on its default config because ${because}`,
      )
    }
    return record
  })
}

function ownerKey(category: Category, scope: RunnerScope): string {
  return `${category} ${scope}`
}

/**
 * The owner graded the category, so the standby's own verdict is not part of
 * the grade — its findings go, and so do its metrics, which would otherwise
 * merge into a measurement the repo's own tool already made.
 *
 * What stays is the evidence: its state, its raw files, the version that ran.
 * The reason says which tool the grade came from, in fixed words — a runner's
 * own free-text reason can name machine-specific paths and would break
 * determinism.
 */
function stoodDown(record: RunRecord, graded: readonly RunRecord[]): RunRecord {
  const { metrics: _metrics, ...result } = record.result
  const names = graded
    .map((other) => other.tool)
    .toSorted()
    .join(', ')
  return {
    ...record,
    result: {
      ...result,
      findings: [],
      reason: `stood down: ${record.category} graded by ${names}`,
    },
  }
}

/** The two per-tool wall-clock budgets: the quick one, and the deep one. */
interface Budgets {
  readonly normal: number
  readonly deep: number
}

/** What the profile adds to every {@link RunContext} this scan builds. */
interface Profile {
  readonly deep: boolean
  readonly changedFiles?: readonly string[]
}

/** Runs one tool with every failure mode converted into a `ToolResult`. */
async function execute(
  repo: RepoContext,
  job: Job,
  budgets: Budgets,
  profile: Profile,
): Promise<RunRecord> {
  const startedAt = Date.now()
  const timeoutMs = job.runner.deepOnly === true ? budgets.deep : budgets.normal
  const result = await withTimeout(
    () =>
      job.runner.run({
        repoRoot: repo.repoRoot,
        files: job.files,
        scratch: repo.scratch,
        detection: job.detection,
        timeoutMs,
        deep: profile.deep,
        ...(profile.changedFiles === undefined ? {} : { changedFiles: profile.changedFiles }),
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
    standby: job.standby,
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
