import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT_PROJECT, nearestProjectMap, repoProject } from './discover.ts'
import { rawPrefix } from './output.ts'
import { mapLimit } from './pool.ts'
import type {
  Category,
  CategoryOutcome,
  DetectContext,
  Detection,
  Finding,
  LanguageAdapter,
  Project,
  RepoContext,
  RunnerScope,
  ToolMetrics,
  ToolResult,
  ToolRunner,
} from './types.ts'
import { CATEGORIES, REPO_SCOPE, categoryRank } from './types.ts'

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
  /**
   * What this run was about: the project's repo-relative path, or
   * {@link REPO_SCOPE} for a run that spanned the repo.
   */
  readonly project: string
  /**
   * True when this run spanned the repo rather than analyzing one project — a
   * {@link ToolRunner.repoScoped} runner's single job, or a repo-wide pass.
   *
   * {@link project} cannot answer this on its own: {@link REPO_SCOPE} is a
   * string a repo may also have a package directory called, and taking one for
   * the other would file two runs' evidence under one name.
   */
  readonly repoWide: boolean
  /**
   * True for the repo-wide pass of a {@link ToolRunner.repoWidePass} runner —
   * the one that measures what no single project can see (a clone *between* two
   * packages). Only the rollup's grade is built from it; no project's is, and
   * the per-project passes it sits beside are the ones the projects grade on.
   */
  readonly rollupOnly: boolean
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
 *
 * The unit of work is a **(runner × project)** pair (see {@link plan}), so a
 * monorepo runs each tool once per project that has its language, under that
 * project's own configuration. The categories and metrics aggregated here are
 * the **rollup's** — the whole repo, which is what a single-project repo has
 * always been; `runs` and `findings` carry the project each of them belongs to,
 * for the per-project half of the report.
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
    findings: sortFindings(attribute(resolved, repo.projects)),
    runs: resolved,
    categories: aggregateCategories(requested, resolved),
    metrics: aggregateMetrics(resolved),
    warnings,
  }
}

/**
 * Stamps every finding with the project it is in and drops the duplicates the
 * project dimension can produce.
 *
 * Attribution is by *path*, never by which run produced it: a repo-scoped
 * secrets scan reports across every package at once, and a reader looking at a
 * package wants its own secret listed there. See {@link nearestProjectMap}.
 *
 * The de-duplication is what makes the repo-wide duplication pass safe to add:
 * it re-reports the clones the per-project passes already found, under the same
 * identity (identity is path-based and the path did not change). One finding
 * with one id is what the report needs, so the first run to report it keeps it —
 * job order is fixed, so which one that is never varies.
 *
 * A path no project in this scan claims carries no attribution at all: the field
 * is optional, and a finding labelled with a project that is not in `projects[]`
 * would send a reader looking for a package this run never graded.
 */
function attribute(records: readonly RunRecord[], projects: readonly Project[]): Finding[] {
  const projectOf = nearestProjectMap(projects)
  const seen = new Set<string>()
  const findings: Finding[] = []
  for (const record of records) {
    for (const finding of record.result.findings) {
      if (seen.has(finding.id)) continue
      seen.add(finding.id)
      const { project: _reported, ...rest } = finding
      const project = projectOf(finding.file)
      findings.push({ ...rest, ...(project === undefined ? {} : { project }) })
    }
  }
  return findings
}

/**
 * Merges the {@link ToolMetrics} of every tool that ran successfully, per
 * category, with one rule per kind of number:
 *
 * - **counts** (`functionsTotal`, `functionsOverCeiling`, `formattableFiles`)
 *   are counts of *things in the repo*, and each tool only counts the things it
 *   was given. Two tools in the same language **in the same project** are looking
 *   at the same files, so the larger measurement wins; two tools in different
 *   languages, or in different projects, are looking at disjoint files, so their
 *   measurements add. Hence: maximum within a language within a project, summed
 *   across projects and languages — which is what keeps a mixed JS+Python repo
 *   from grading its formatting against the file count of whichever language
 *   happens to be bigger, and what makes the rollup of three packages the whole
 *   repo rather than the largest package in it.
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
    const detected = combine(reported, 'mutantsDetected', countAcrossUnits)
    const undetected = combine(reported, 'mutantsUndetected', countAcrossUnits)

    merged[category] = {
      ...combine(reported, 'functionsTotal', countAcrossUnits),
      ...combine(reported, 'functionsOverCeiling', countAcrossUnits),
      ...combine(reported, 'formattableFiles', countAcrossUnits),
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

/** One tool's measurement of one field, tagged with what it measured. */
interface ScopedValue {
  /** The language the measuring runner speaks. */
  readonly scope: RunnerScope
  /** The project it measured, or {@link REPO_SCOPE} for a repo-spanning run. */
  readonly project: string
  readonly value: number
}

function combine(
  reported: readonly RunRecord[],
  field: keyof ToolMetrics,
  fold: (values: readonly ScopedValue[]) => number,
): ToolMetrics {
  const measured = reported.filter((record) => {
    const value = record.result.metrics?.[field]
    return value !== undefined && Number.isFinite(value)
  })

  // A repo-wide pass measured this field over the whole repo, which is what a
  // rollup metric *is* — so when one ran it decides, and the per-project passes
  // beside it (whose numbers are their own projects') are not merged in. Without
  // this, one small package's 40 % duplication would become the repo's.
  const rollup = measured.filter((record) => record.rollupOnly)
  const values = (rollup.length > 0 ? rollup : measured).map(
    (record) =>
      ({
        scope: record.scope,
        project: record.project,
        value: record.result.metrics?.[field] ?? 0,
      }) satisfies ScopedValue,
  )
  return values.length === 0 ? {} : { [field]: fold(values) }
}

/**
 * Maximum within one language in one project, summed across every such unit.
 * See {@link aggregateMetrics}; a single-project repo has one unit per language,
 * which is the rule it has always been graded under.
 */
function countAcrossUnits(values: readonly ScopedValue[]): number {
  const perUnit = new Map<string, number>()
  for (const { scope, project, value } of values) {
    const unit = `${scope} ${project}`
    perUnit.set(unit, Math.max(perUnit.get(unit) ?? Number.NEGATIVE_INFINITY, value))
  }
  return [...perUnit.values()].reduce((total, value) => total + value, 0)
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
  /**
   * The project this job analyzes — the whole repo as one project when it is
   * repo-spanning ({@link repoWide}).
   */
  readonly project: Project
  /** Spans the repo: a {@link ToolRunner.repoScoped} run, or a rollup pass. */
  readonly repoWide: boolean
  /** The repo-wide pass of a {@link ToolRunner.repoWidePass} runner. */
  readonly rollupOnly: boolean
  readonly detection: Detection | null
  /** Files this runner gets: its language's subset, or everything for `common`. */
  readonly files: readonly string[]
  /** Our default, running behind an owner that may not manage to. */
  readonly standby: boolean
}

/** What one job's results are attributed to: a project path, or the repo. */
function attributionOf(job: Job): string {
  return job.repoWide ? REPO_SCOPE : job.project.path
}

/**
 * The work of a scan: one job per **(runner, project)** pair, plus the
 * repo-spanning ones.
 *
 * Three kinds of job come out of this, and the difference is what each tool can
 * answer about:
 *
 * - **per project** — every language-scoped runner, in each project whose own
 *   inventory has its language, detected against that project (ownership
 *   inherits from its ancestors — see `DetectContext`). This is what makes a
 *   package's grade its package's: its own config, its own files, its own
 *   toolchain.
 * - **repo-spanning** — one job for each {@link ToolRunner.repoScoped} runner,
 *   over the whole inventory, however many projects there are.
 * - **the rollup pass** — one extra whole-repo job for a
 *   {@link ToolRunner.repoWidePass} runner, and only in a repo that has more
 *   than one project to be *between*.
 *
 * Jobs are grouped by runner and then by project, so a single-project repo
 * produces exactly the sequence it always has. Detection never runs a tool.
 */
async function plan(
  repo: RepoContext,
  adapters: readonly LanguageAdapter[],
  requested: readonly Category[],
  deep: boolean,
  warnings: string[],
): Promise<Job[]> {
  const jobs: Job[] = []
  const wholeRepo = repoProject(repo.files)

  for (const adapter of adapters) {
    const runners = adapter.runners.filter(
      // A deep runner in a quick scan is not a job that declined; it is not a
      // job (spec §5). Nothing is recorded for it, so the category degrades with
      // the profile's own reason rather than with a tool's.
      (runner) => requested.includes(runner.category) && (deep || runner.deepOnly !== true),
    )
    if (runners.length === 0) continue

    // Which projects this adapter has anything to say about, decided once per
    // project rather than once per runner.
    // eslint-disable-next-line no-await-in-loop
    const targets = await applicableProjects(adapter, repo, warnings)

    const candidates: Job[] = []
    for (const runner of runners) {
      for (const unit of unitsFor(runner, targets, wholeRepo, repo.projects.length)) {
        // eslint-disable-next-line no-await-in-loop
        const job = await candidate(runner, adapter, unit, repo, warnings)
        if (job !== undefined) candidates.push(job)
      }
    }

    jobs.push(...withoutRedundantDefaults(candidates))
  }

  return jobs
}

/** One thing a runner is asked about: which project, and on whose behalf. */
interface Unit {
  readonly project: Project
  readonly repoWide: boolean
  readonly rollupOnly: boolean
}

/** The units one runner is planned for; see {@link plan} for the three kinds. */
function unitsFor(
  runner: ToolRunner,
  targets: readonly Project[],
  wholeRepo: Project,
  projectCount: number,
): Unit[] {
  // A repo-scoped runner is asked once, and only where its adapter applies at all.
  if (runner.repoScoped === true) {
    return targets.length === 0 ? [] : [{ project: wholeRepo, repoWide: true, rollupOnly: false }]
  }

  const perProject = targets.map((project) => ({
    project,
    repoWide: false,
    rollupOnly: false,
  }))
  // Plus, for the runner that measures across projects, the pass that sees what
  // none of them can. A single-project repo has no "across" to measure.
  return runner.repoWidePass === true && projectCount > 1
    ? [...perProject, { project: wholeRepo, repoWide: true, rollupOnly: true }]
    : perProject
}

/**
 * The projects this adapter applies to, in `RepoContext.projects` order. A
 * detector that throws takes only its own adapter out of the scan, with a
 * warning — as it always has.
 */
async function applicableProjects(
  adapter: LanguageAdapter,
  repo: RepoContext,
  warnings: string[],
): Promise<Project[]> {
  const applicable: Project[] = []
  for (const project of repo.projects) {
    try {
      // Detection is cheap and ordered; the concurrency cap covers the runs.
      // eslint-disable-next-line no-await-in-loop
      if (await adapter.detect(detectContextFor(repo, project))) applicable.push(project)
    } catch (error) {
      warnings.push(
        `${adapter.language}: language detection failed in ${project.path}: ${describe(error)}`,
      )
    }
  }
  return applicable
}

/** One job, or nothing when the repo did not choose a tool we never impose. */
async function candidate(
  runner: ToolRunner,
  adapter: LanguageAdapter,
  unit: Unit,
  repo: RepoContext,
  warnings: string[],
): Promise<Job | undefined> {
  const project = unit.project
  let detection: Detection | null = null
  try {
    detection = await runner.detect(detectContextFor(repo, project))
  } catch (error) {
    warnings.push(`${runner.tool}: detection failed, using default config: ${describe(error)}`)
  }
  // A tool crank-health never imposes as a default is simply absent from a
  // repo that did not choose it — not a failure, and not a reason for the
  // category to degrade (spec §1: `ToolRunner.repoOwnedOnly`). Ownership is the
  // project's: a package that owns ESLint gets it, its sibling does not.
  if (runner.repoOwnedOnly === true && detection === null) return undefined

  return {
    runner,
    scope: adapter.language,
    project,
    repoWide: unit.repoWide,
    rollupOnly: unit.rollupOnly,
    detection,
    files:
      adapter.language === 'common'
        ? project.files.all
        : project.files.byLanguage[adapter.language],
    standby: false,
  }
}

/** Detection's view: one project, the repo it sits in, the whole inventory. */
function detectContextFor(repo: RepoContext, project: Project): DetectContext {
  return { repoRoot: repo.repoRoot, project, files: repo.files }
}

/**
 * Spec §1's two branches are exclusive: "Owned → run *their* tool with their
 * config … Not owned → *our* pinned default tool with a bundled config." So a
 * category this language already owns does not also get our default imposed on
 * it — a repo formatted with Biome is not badly formatted for disagreeing with
 * prettier's defaults, and grading it against both would say it was.
 *
 * Ownership is per language and per project, not global: Python owning `ruff
 * format` says nothing about who formats the JavaScript next to it, and one
 * package owning ESLint says nothing about its sibling. So this is applied
 * within one adapter's runners, keyed by the project each job is for — a
 * package that owns ESLint stands oxlint down *there*, and the sibling that
 * does not still gets it.
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
  const suppressed = new Set(candidates.filter(canRun).map(ownershipKey))
  const claimed = new Set(candidates.filter(owns).map(ownershipKey))

  // A flatMap over the candidates keeps them in candidate order; `runs` is in
  // job order, and appending the kept standbys at the end would reorder it.
  return candidates.flatMap((job) => {
    if (job.detection !== null || job.runner.complementary === true) return [job]
    if (suppressed.has(ownershipKey(job))) return []
    if (claimed.has(ownershipKey(job))) return [{ ...job, standby: true }]
    return [job]
  })
}

/** A category in one project: the unit ownership is decided over. */
function ownershipKey(job: Job): string {
  return `${job.runner.category} ${attributionOf(job)}`
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
 * Owner identity comes from the *jobs*, keyed by category, language scope and
 * project, so a complementary runner that happened to succeed cannot stand a
 * standby down — it never conferred ownership in the first place — a package's
 * owner cannot settle its sibling's standby, and nothing depends on records and
 * jobs lining up by index.
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
    const key = ownerKey(job.runner.category, job.scope, attributionOf(job))
    const tools = owners.get(key) ?? new Set<string>()
    tools.add(job.runner.tool)
    owners.set(key, tools)
  }

  return records.map((record) => {
    if (!record.standby) return record
    const mine =
      owners.get(ownerKey(record.category, record.scope, record.project)) ?? new Set<string>()
    const ownerRecords = records.filter(
      (other) =>
        other.category === record.category &&
        other.scope === record.scope &&
        other.project === record.project &&
        mine.has(other.tool),
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

function ownerKey(category: Category, scope: RunnerScope, project: string): string {
  return `${category} ${scope} ${project}`
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

/**
 * Runs one tool with every failure mode converted into a `ToolResult`.
 *
 * The scratch directory is the job's, not the scan's: it mirrors the `raw/`
 * nesting the pipeline adopts these files into ({@link rawPrefix}), so two
 * projects running the same tool cannot write over each other's evidence. It is
 * created here because runners are entitled to a working directory that exists —
 * several start their tool with `cwd` set to it.
 */
async function execute(
  repo: RepoContext,
  job: Job,
  budgets: Budgets,
  profile: Profile,
): Promise<RunRecord> {
  const startedAt = Date.now()
  const timeoutMs = job.runner.deepOnly === true ? budgets.deep : budgets.normal
  const project = attributionOf(job)
  const scratch = join(repo.scratch, ...rawPrefix(project, job.repoWide).split('/'))
  await mkdir(scratch, { recursive: true })

  const result = await withTimeout(
    () =>
      job.runner.run({
        repoRoot: repo.repoRoot,
        project: job.project,
        nestedProjects: nestedProjectsOf(repo, job),
        files: job.files,
        scratch,
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
    project,
    repoWide: job.repoWide,
    rollupOnly: job.rollupOnly,
    pinnedVersion: job.runner.pinnedVersion,
    detection: job.detection,
    result,
    durationMs: Date.now() - startedAt,
    standby: job.standby,
  }
}

/**
 * The projects nested inside this job's, in `RepoContext.projects` order — what
 * a runner handed a *directory* rather than a file list has to leave to them
 * (see `RunContext.nestedProjects`). A repo-spanning job gets none: measuring
 * what the per-project passes cannot see is the whole reason it exists.
 */
function nestedProjectsOf(repo: RepoContext, job: Job): readonly string[] {
  if (job.repoWide) return []
  const prefix = job.project.path === ROOT_PROJECT ? '' : `${job.project.path}/`
  return repo.projects
    .filter((project) => project.path !== job.project.path && project.path.startsWith(prefix))
    .map((project) => project.path)
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
 *
 * Exported because a project's categories are the same question asked of its
 * own records: one rule, so a per-project state and the rollup's cannot drift.
 */
export function aggregateCategories(
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
