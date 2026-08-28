import type { CategoryMovement, DeltaResult, ProjectChurn } from '../core/delta.ts'
import type { RootShell } from '../core/discover.ts'
import { languageOf } from '../core/discover.ts'
import { linkRelated } from '../core/fingerprint.ts'
import type { RunRecord } from '../core/orchestrator.ts'
import { sortFindings } from '../core/orchestrator.ts'
import type {
  Category,
  CategoryState,
  Finding,
  Language,
  PackageAdvisory,
  Project,
  RunnerScope,
  ToolMetrics,
} from '../core/types.ts'
import { CATEGORIES, LANGUAGES, categoryRank } from '../core/types.ts'
import { VERSION } from '../version.ts'

/**
 * `report.json` — the machine-readable artifact and the determinism contract
 * (spec §6): same crank-health version + same commit + same repo toolchain ⇒
 * byte-identical bytes.
 *
 * Two rules make that hold, and both are enforced here rather than left to
 * callers:
 * - every object is rebuilt in a fixed key order, so serialization never
 *   inherits the order some adapter happened to use
 * - everything that varies between two identical runs (wall-clock time, run
 *   durations) lives under the single top-level `timings` key, which the
 *   byte-identity test strips
 */

/** Bumped whenever the shape below changes incompatibly. */
const SCHEMA_VERSION = 2

/**
 * One finding as `report.json` carries it.
 *
 * Two fields of the core's {@link Finding} are deliberately not on the wire:
 * `identity` is the internal material the fingerprint was hashed from, and
 * `gradeScope` is what the top-level split now says — a row in
 * {@link Report.findings} counted toward its grade and a row in
 * {@link Report.advisories} did not, so a boolean repeating that would be a
 * second place for the same fact to be wrong.
 *
 * The delta's lists are the exception: they are not partitioned — "what this
 * change added" is one question about both kinds — so their rows carry
 * {@link ReportFinding.advisory} to say which they are.
 */
export type ReportFinding = Omit<Finding, 'gradeScope' | 'identity'> & {
  /**
   * Present and `true` only where membership cannot carry the flag: the delta's
   * `newFindings` and `resolvedFindings`. Never emitted at the top level, where
   * the array a row is in already says it.
   */
  readonly advisory?: true
}

export interface Report {
  readonly schemaVersion: number
  readonly crankHealth: string
  readonly repo: ReportRepo
  readonly profile: 'quick' | 'deep'
  readonly mode: 'whole-repo' | 'pr'
  /** The categories this run was asked to assess (`--only`, or all of them). */
  readonly selected: readonly Category[]
  /**
   * The `--project` selection this run was scoped to, stable-sorted; absent
   * when every discovered project was scanned.
   *
   * Everything above {@link projects} is the rollup, and under scoping the
   * rollup is computed over the selection rather than over the whole repo — so
   * without this field nothing in the report says which. Additive: a reader that
   * does not know the key sees the report it always saw.
   */
  readonly scopedTo?: readonly string[]
  /** All eight states, always — including the ones nothing assessed (spec §8). */
  readonly categories: Readonly<Record<Category, CategoryState>>
  /**
   * The arithmetic behind each grade above, in {@link CATEGORIES} order and only
   * for the categories that have one; see {@link ReportGradeBasis}.
   */
  readonly gradeBasis: Readonly<Partial<Record<Category, ReportGradeBasis>>>
  /**
   * The tool-reported measurements behind the ratio grades, for the categories
   * where a tool reported any. A grade of "complexity: C" is unreadable without
   * the numbers it came from.
   */
  readonly metrics: Readonly<Partial<Record<Category, ToolMetrics>>>
  /**
   * The per-language breakdown spec §3 asks for in a mixed repo: how many
   * findings each language contributed to each category. The *grade* is one
   * number over the combined findings — "one grade per category over combined
   * normalized findings" — and this is what tells a reader which language it
   * came from.
   */
  readonly languages: Readonly<Partial<Record<Language, Partial<Record<Category, number>>>>>
  /**
   * How much of the tree the grades above are actually about; see
   * {@link ReportCoverage}.
   */
  readonly coverage: ReportCoverage
  /**
   * The same questions answered per project, ordered by path and never empty.
   *
   * Everything above this key is the **rollup**: the whole repo, which is what
   * a single-project repo has always been and what its grade still means. These
   * are the packages inside it, each graded on its own files, its own tools and
   * its own denominators — so one bad package cannot hide behind a large good
   * one, and a reader can see which package a grade belongs to.
   */
  readonly projects: readonly ReportProject[]
  /**
   * Present when the repo root holds no source files of its own: a workspace
   * shell has nothing to grade, so it is recorded here rather than appearing in
   * {@link projects} as eight empty categories.
   */
  readonly rootShell?: ReportRootShell
  readonly tools: readonly ReportTool[]
  /**
   * The findings that counted toward a grade, in report order.
   *
   * Schema 2 split this list in two. A report where four fifths of the rows are
   * a default config's opinions buries the fifth that moved a letter, and every
   * consumer had to know to filter on `gradeScope` to find it — so the graded
   * ones are here and the rest are in {@link advisories}.
   */
  readonly findings: readonly ReportFinding[]
  /**
   * The findings that were reported but did not count toward any grade, in
   * report order: a default config's style opinions, a low-confidence tier, a
   * vulnerable dependency with no fixed version to upgrade to. Same shape as
   * {@link findings} — the only difference is which array they are in.
   */
  readonly advisories: readonly ReportFinding[]
  readonly warnings: readonly string[]
  /** Present exactly when `mode` is `pr`. Deterministic — not a timing. */
  readonly delta?: ReportDelta
  /** Everything non-deterministic, quarantined. */
  readonly timings: ReportTimings
}

/**
 * The PR-mode delta of spec §4: what this change did, on top of a head report
 * that is otherwise an ordinary whole-repo report.
 *
 * Head is the primary throughout — `categories`, `findings` and every grade in
 * the report are head's — because "what is the state of this codebase" has one
 * answer and it is the current one. The delta says what moved.
 */
export interface ReportDelta {
  /** The base ref `--pr` was given, verbatim. */
  readonly baseRef: string
  /** The merge-base commit the base scan actually ran on. */
  readonly mergeBase: string
  readonly counts: ReportDeltaCounts
  /**
   * All eight categories: base state, head state, and the counts behind the
   * movement. Base states are reported even when they are failures — see
   * {@link CategoryMovement}.
   */
  readonly categories: readonly ReportCategoryMovement[]
  /**
   * The same movement per project, ordered by path — every project either side
   * of the comparison had, including the ones this change added or removed.
   */
  readonly projects: readonly ReportProjectMovement[]
  /** Findings present at head and not at the merge-base. */
  readonly newFindings: readonly ReportNewFinding[]
  /** Findings present at the merge-base and gone at head, at their head paths. */
  readonly resolvedFindings: readonly ReportFinding[]
}

interface ReportDeltaCounts {
  readonly new: number
  /** Of the new ones, how many sit on a line this change touched (spec §4). */
  readonly touchedLine: number
  readonly resolved: number
  /** Findings both scans saw. Not listed anywhere — this is the whole record. */
  readonly unchanged: number
}

interface ReportCategoryMovement {
  readonly category: Category
  readonly base: CategoryState
  readonly head: CategoryState
  readonly newFindings: number
  readonly resolvedFindings: number
}

/**
 * One project's half of the delta; see {@link ProjectMovement}. `churn` is
 * `added` for a project only head has, `removed` for one only the base had, and
 * `none` for a project both sides scanned however much moved inside it.
 */
export interface ReportProjectMovement {
  readonly path: string
  readonly churn: ProjectChurn
  readonly newFindings: number
  readonly resolvedFindings: number
  readonly categories: readonly ReportCategoryMovement[]
}

/** A finding in {@link ReportDelta.newFindings}: the schema plus the flag. */
type ReportNewFinding = ReportFinding & { readonly touchedLine: boolean }

/**
 * The two numbers one category's formula divided, and what they count.
 *
 * A letter on its own is not checkable: `lint: C` says nothing about whether the
 * repo has forty warnings in a thousand lines or four hundred in ten thousand,
 * and the grade tables in `core/grade.ts` are stated in exactly these terms. A
 * reader who has this can redo the sum.
 */
export interface ReportGradeBasis {
  /** The measured numerator, in {@link unit}. */
  readonly value: number
  /**
   * What {@link value} was measured against — KLOC, files checked, functions
   * analyzed. `null` for the shapes that normalize nothing: security counts
   * findings outright, and duplication and mutation score are percentages the
   * tool computed itself.
   */
  readonly denominator: number | null
  /** What one unit of {@link value} is, in the formula's own words. */
  readonly unit: string
}

/**
 * What the grades are silent about: the part of the tree no language adapter
 * owns.
 *
 * A repo can be graded A across the board while a third of it — workflow YAML,
 * SQL, templates, shell — was never read by any of the tools, and nothing in the
 * report said so. The denominators the grades divide by are the *assessed*
 * counts, so this is what makes those numbers readable: how much of the tree
 * they are a statement about, and what the remainder is made of.
 *
 * "Lines" are physical lines, counted the same way the KLOC denominator is.
 */
export interface ReportCoverage {
  readonly files: ReportCoverageCounts
  readonly lines: ReportCoverageCounts
  /**
   * The unassessed remainder by file extension, ordered by extension. The empty
   * string is the files that have none — `Makefile`, `.gitignore`, `LICENSE`.
   */
  readonly unassessed: readonly ReportUnassessed[]
}

interface ReportCoverageCounts {
  /** Everything in the scan's inventory. */
  readonly total: number
  /** Of those, the ones a language adapter claims — what the tools could read. */
  readonly assessed: number
}

export interface ReportUnassessed {
  /** Lowercased, dot included (`.yaml`); empty for a file with no extension. */
  readonly extension: string
  readonly files: number
  readonly lines: number
}

interface ReportRepo {
  readonly path: string
  /** `null` in a repo with no commits yet. */
  readonly commit: string | null
}

/** One project's half of the report; see {@link Report.projects}. */
export interface ReportProject {
  /** Identity: repo-relative posix path of the project directory, `.` at the root. */
  readonly path: string
  /** The `package.json`/`pyproject.toml` that make this directory a project. */
  readonly manifests: readonly string[]
  readonly languages: readonly Language[]
  /** All eight states, always — the same contract the rollup keeps (spec §8). */
  readonly categories: Readonly<Record<Category, CategoryState>>
  /**
   * The arithmetic behind this project's graded categories, on its own
   * denominators — the rollup's {@link Report.gradeBasis} said for one package.
   * Only the categories this project graded appear.
   */
  readonly gradeBasis: Readonly<Partial<Record<Category, ReportGradeBasis>>>
  readonly metrics: Readonly<Partial<Record<Category, ToolMetrics>>>
  /** Every tool this project owns, and what made it own it. */
  readonly toolchain: readonly ReportProjectTool[]
}

/**
 * One owned tool, from the project's point of view: the same detection that is
 * in {@link Report.tools}, said where a reader asks "what does *this* package
 * use". A repo-spanning run belongs to no project and appears only in `tools`.
 */
export interface ReportProjectTool {
  readonly tool: string
  readonly category: Category
  readonly reason: 'config' | 'dependency' | 'config+dependency'
  /** The artifact that decided ownership; see {@link ReportDetection.ownedVia}. */
  readonly ownedVia: string | null
  readonly configFiles: readonly string[]
  /** True when the tool the project declares is actually installed. */
  readonly installed: boolean
  /** The version that ran here, as reported by the tool itself. */
  readonly version: string | null
}

/** The repo root as a workspace shell; see {@link Report.rootShell}. */
export interface ReportRootShell {
  /**
   * Workspace declarations corroborating the classification (`workspaces`,
   * `pnpm-workspace.yaml`, `[tool.uv.workspace]`), stable-sorted. Empty when
   * the layout is undeclared — which changes nothing about the partition.
   */
  readonly declaredBy: readonly string[]
}

export interface ReportTool {
  readonly tool: string
  readonly category: Category
  readonly scope: RunnerScope
  /**
   * What this run was about: the project's path, or `"repo"` for a run that
   * spanned the repo (a secrets scan, a lockfile audit, the repo-wide
   * duplication pass). The same tool appears once per project it ran in.
   */
  readonly project: string
  /**
   * Present and `true` exactly on the runs that spanned the repo.
   *
   * `project` cannot carry that on its own: `"repo"` is also a directory name a
   * package may have, so a reader of a repo containing `repo/` cannot tell a
   * secrets scan from that package's own lint run. Additive, and emitted only
   * where it is true, so a report without a repo-spanning run is unchanged.
   */
  readonly repoWide?: boolean
  /**
   * PR mode only: which of the two scans this record is from. Without it the
   * two runs of the same tool are indistinguishable, and "the tool errored"
   * would not say on which side — the difference between a real improvement and
   * a scanner that failed at the base (spec §8).
   */
  readonly side?: 'base' | 'head'
  /** Whose binary ran: the repo's installed one, or our pinned ephemeral one. */
  readonly execution: 'repo-installed' | 'ephemeral-pinned'
  /** Whose configuration decided the findings (spec §1). */
  readonly provenance: 'repo-config' | 'default-config'
  /** The version that actually ran, as reported by the tool itself. */
  readonly version: string | null
  /** The version this release pins for ephemeral runs (spec §6). */
  readonly pinned: string | null
  readonly detection: ReportDetection | null
  readonly state: 'ok' | 'error' | 'timeout' | 'not-available'
  readonly reason: string | null
  /** Run-directory-relative paths of this tool's raw output. */
  readonly raw: readonly string[]
}

interface ReportDetection {
  readonly reason: 'config' | 'dependency' | 'config+dependency'
  readonly configFiles: readonly string[]
  /**
   * The artifact that decided ownership, repo-relative posix — the project's
   * own or an ancestor's. `null` when the detector reported none.
   */
  readonly ownedVia: string | null
  readonly installed: boolean
  readonly version: string | null
}

interface ReportTimings {
  readonly generatedAt: string
  readonly durationMs: number
  readonly tools: readonly { readonly tool: string; readonly durationMs: number }[]
}

/** One runner's record plus the raw files the pipeline adopted for it. */
export interface ResolvedRun {
  readonly record: RunRecord
  readonly raw: readonly string[]
  /** Which scan produced it; PR mode only. See {@link ReportTool.side}. */
  readonly side?: 'base' | 'head'
}

/**
 * One project's graded result, as the pipeline hands it to
 * {@link buildReport}. The project itself carries its path, manifests and
 * languages, so nothing has to be restated here.
 */
export interface ProjectScan {
  readonly project: Project
  readonly categories: Readonly<Record<Category, CategoryState>>
  /** The arithmetic behind this project's graded ones; see {@link ReportGradeBasis}. */
  readonly gradeBasis: Readonly<Partial<Record<Category, ReportGradeBasis>>>
  readonly metrics: Readonly<Record<Category, ToolMetrics>>
}

export interface ReportInput {
  readonly repoPath: string
  readonly commit: string | null
  readonly profile: 'quick' | 'deep'
  /**
   * The PR delta, when this was a `--pr` run. Its presence is what makes the
   * report's `mode` `pr`: there is no such thing as a PR run without one.
   */
  readonly delta?: PrDelta
  readonly selected: readonly Category[]
  /** The `--project` selection, when there was one; see {@link Report.scopedTo}. */
  readonly scopedTo?: readonly string[]
  readonly categories: Readonly<Record<Category, CategoryState>>
  /** The arithmetic behind the graded ones; see {@link ReportGradeBasis}. */
  readonly gradeBasis: Readonly<Partial<Record<Category, ReportGradeBasis>>>
  readonly metrics: Readonly<Record<Category, ToolMetrics>>
  /** What the scan could read of the tree; see {@link ReportCoverage}. */
  readonly coverage: ReportCoverage
  /** Every discovered project, graded; never empty. See {@link Report.projects}. */
  readonly projects: readonly ProjectScan[]
  /** The root's workspace declarations, when the root is a shell rather than a project. */
  readonly rootShell?: RootShell
  readonly runs: readonly ResolvedRun[]
  readonly findings: readonly Finding[]
  readonly warnings: readonly string[]
  readonly generatedAt: string
  readonly durationMs: number
}

/** What `run-pr.ts` computed, before it is put in `report.json`'s key order. */
export interface PrDelta extends DeltaResult {
  /** The base ref `--pr` was given, verbatim. */
  readonly baseRef: string
  /** The merge-base commit the base scan ran on. */
  readonly mergeBase: string
}

/** Assembles the report object. Pure: no clock, no filesystem, no ordering luck. */
export function buildReport(input: ReportInput): Report {
  const runs = input.runs.toSorted(
    (a, b) =>
      categoryRank(a.record.category) - categoryRank(b.record.category) ||
      compare(a.record.tool, b.record.tool) ||
      compare(a.record.scope, b.record.scope) ||
      // The same tool runs once per project, so the project is part of the order.
      compare(a.record.project, b.record.project) ||
      compare(a.side ?? '', b.side ?? ''),
  )
  const linked = linkRelated(input.findings)

  return {
    schemaVersion: SCHEMA_VERSION,
    crankHealth: VERSION,
    repo: { path: input.repoPath, commit: input.commit },
    profile: input.profile,
    mode: input.delta === undefined ? 'whole-repo' : 'pr',
    selected: CATEGORIES.filter((category) => input.selected.includes(category)),
    ...(input.scopedTo === undefined ? {} : { scopedTo: input.scopedTo.toSorted(compare) }),
    categories: orderedCategories(input.categories),
    gradeBasis: orderedGradeBasis(input.gradeBasis),
    metrics: orderedMetrics(input.metrics),
    languages: countByLanguage(input.findings),
    coverage: orderedCoverage(input.coverage),
    projects: input.projects
      .toSorted((a, b) => compare(a.project.path, b.project.path))
      .map((scan) => toReportProject(scan, runs)),
    ...(input.rootShell === undefined
      ? {}
      : { rootShell: { declaredBy: input.rootShell.declaredBy.toSorted(compare) } }),
    tools: runs.map((run) => toReportTool(run)),
    // One pass each over an already-sorted list, so the two arrays are the
    // report's own order with the other kind of row taken out. Cross-category
    // links are drawn over the whole set first: a security row and a lint row
    // on the same lines land in different arrays, and the link is still the
    // point.
    findings: linked
      .filter((finding) => finding.gradeScope)
      .map((finding) => orderedFinding(finding)),
    advisories: linked
      .filter((finding) => !finding.gradeScope)
      .map((finding) => orderedFinding(finding)),
    warnings: input.warnings.toSorted(compare),
    ...(input.delta === undefined ? {} : { delta: orderedDelta(input.delta) }),
    timings: {
      generatedAt: input.generatedAt,
      durationMs: input.durationMs,
      tools: runs.map((run) => ({ tool: run.record.tool, durationMs: run.record.durationMs })),
    },
  }
}

/** The bytes written to `report.json` and printed by `--json`. */
export function serializeReport(report: Report): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

/**
 * Every finding the report carries — graded and advisory alike — as the core
 * knows one, in report order.
 *
 * The renderers ask "what did this scan find", which the schema-2 split
 * deliberately does not answer in a single array. Re-sorting the concatenation
 * with the pipeline's own {@link sortFindings} reproduces the order the two
 * arrays were cut out of, so a renderer sees exactly the list it always did, and
 * `gradeScope` comes back from which array each row was in.
 */
export function reportFindings(report: Report): Finding[] {
  return sortFindings([
    ...report.findings.map((row) => scoped(row, true)),
    ...report.advisories.map((row) => scoped(row, false)),
  ])
}

/**
 * One row of an unpartitioned list — the delta's — back in the core's shape,
 * reading its scope off {@link ReportFinding.advisory}. Extra fields (the
 * delta's `touchedLine`) survive.
 */
export function withGradeScope<T extends ReportFinding>(
  row: T,
): T & { readonly gradeScope: boolean } {
  return scoped(row, row.advisory !== true)
}

function scoped<T extends ReportFinding>(
  row: T,
  gradeScope: boolean,
): T & { readonly gradeScope: boolean } {
  return { ...row, gradeScope }
}

/**
 * One project, with the toolchain drawn from the runs that were about it.
 *
 * PR mode puts both scans' runs in `tools`, and the projects are head's — so a
 * base-side run is not part of any project's toolchain, or a package would look
 * as though it owned every tool twice.
 */
function toReportProject(scan: ProjectScan, runs: readonly ResolvedRun[]): ReportProject {
  return {
    path: scan.project.path,
    manifests: scan.project.manifests.toSorted(compare),
    languages: LANGUAGES.filter((language) => scan.project.languages.includes(language)),
    categories: orderedCategories(scan.categories),
    gradeBasis: orderedGradeBasis(scan.gradeBasis),
    metrics: orderedMetrics(scan.metrics),
    toolchain: runs.flatMap(({ record, side }) => {
      const detection = record.detection
      // `repoWide` and not the path alone: a repo-spanning run belongs to no
      // project, and it carries the same `project` string a package called
      // `repo/` does — that package does not own the repo's secrets scanner.
      if (side === 'base' || record.repoWide || record.project !== scan.project.path) return []
      if (detection === null) return []
      return [
        {
          tool: record.tool,
          category: record.category,
          reason: detection.reason,
          ownedVia: detection.ownedVia ?? null,
          configFiles: detection.configFiles.toSorted(compare),
          installed: detection.installed,
          version: record.result.toolVersion ?? detection.version ?? null,
        },
      ]
    }),
  }
}

function toReportTool(run: ResolvedRun): ReportTool {
  const { record } = run
  const detection = record.detection
  const installed = detection?.installed === true
  return {
    tool: record.tool,
    category: record.category,
    scope: record.scope,
    project: record.project,
    ...(record.repoWide ? { repoWide: true } : {}),
    ...(run.side === undefined ? {} : { side: run.side }),
    execution: installed ? 'repo-installed' : 'ephemeral-pinned',
    // The runner's own answer wins when it gave one: detection can be non-null
    // on a declared-but-unconfigured tool that still ran on our config
    // (`ToolResult.configOwned`). Detection stays visible either way, so a
    // reader can see the dependency that was declared and the default config
    // that decided the findings at the same time.
    provenance: provenanceOf(record.result.configOwned, detection),
    version: record.result.toolVersion ?? detection?.version ?? null,
    pinned: record.pinnedVersion,
    detection:
      detection === null
        ? null
        : {
            reason: detection.reason,
            configFiles: [...detection.configFiles].toSorted(compare),
            ownedVia: detection.ownedVia ?? null,
            installed: detection.installed,
            version: detection.version ?? null,
          },
    state: record.result.state,
    reason: record.result.reason ?? null,
    raw: run.raw,
  }
}

/** Whose config decided a tool's findings; see {@link ToolResult.configOwned}. */
function provenanceOf(
  configOwned: boolean | undefined,
  detection: RunRecord['detection'],
): 'repo-config' | 'default-config' {
  if (configOwned !== undefined) return configOwned ? 'repo-config' : 'default-config'
  return detection === null ? 'default-config' : 'repo-config'
}

/**
 * The delta in `report.json`'s key order, with every finding rebuilt through
 * {@link orderedFinding} — which is also what keeps the internal identity
 * material off the wire.
 */
function orderedDelta(delta: PrDelta): ReportDelta {
  return {
    baseRef: delta.baseRef,
    mergeBase: delta.mergeBase,
    counts: {
      new: delta.newFindings.length,
      touchedLine: delta.newFindings.filter((entry) => entry.touchedLine).length,
      resolved: delta.resolvedFindings.length,
      unchanged: delta.unchangedCount,
    },
    categories: delta.categories.map((movement) => orderedMovement(movement)),
    projects: delta.projects.map((project) => ({
      path: project.path,
      churn: project.churn,
      newFindings: project.newFindings,
      resolvedFindings: project.resolvedFindings,
      categories: project.categories.map((movement) => orderedMovement(movement)),
    })),
    newFindings: delta.newFindings.map((entry) => ({
      ...orderedDeltaFinding(entry.finding),
      touchedLine: entry.touchedLine,
    })),
    resolvedFindings: delta.resolvedFindings.map((finding) => orderedDeltaFinding(finding)),
  }
}

/**
 * A delta row: the schema's key order, plus the scope flag the top level says
 * by partitioning. See {@link ReportFinding.advisory}.
 */
function orderedDeltaFinding(finding: Finding): ReportFinding {
  return {
    ...orderedFinding(finding),
    ...(finding.gradeScope ? {} : { advisory: true as const }),
  }
}

/**
 * The graded categories' arithmetic, in canonical order and with a fixed key
 * order inside each. Only the categories that have a basis appear — a
 * `not-assessed` category divided nothing, and a row of zeroes under it would
 * read as a measurement nobody took.
 */
function orderedGradeBasis(
  basis: Readonly<Partial<Record<Category, ReportGradeBasis>>>,
): Partial<Record<Category, ReportGradeBasis>> {
  const ordered: Partial<Record<Category, ReportGradeBasis>> = {}
  for (const category of CATEGORIES) {
    const measured = basis[category]
    if (measured !== undefined) {
      ordered[category] = {
        value: measured.value,
        denominator: measured.denominator,
        unit: measured.unit,
      }
    }
  }
  return ordered
}

/** The coverage block in the schema's key order; the runner already sorted it. */
function orderedCoverage(coverage: ReportCoverage): ReportCoverage {
  return {
    files: { total: coverage.files.total, assessed: coverage.files.assessed },
    lines: { total: coverage.lines.total, assessed: coverage.lines.assessed },
    unassessed: coverage.unassessed.map((entry) => ({
      extension: entry.extension,
      files: entry.files,
      lines: entry.lines,
    })),
  }
}

function orderedMovement(movement: CategoryMovement): ReportCategoryMovement {
  return {
    category: movement.category,
    base: orderedState(movement.base),
    head: orderedState(movement.head),
    newFindings: movement.newFindings,
    resolvedFindings: movement.resolvedFindings,
  }
}

/**
 * Categories with at least one measurement, in canonical order and with a fixed
 * key order inside each — an empty object would say "measured nothing", which
 * is different from "no tool measured this" and would read as noise besides.
 */
function orderedMetrics(
  metrics: Readonly<Record<Category, ToolMetrics>>,
): Partial<Record<Category, ToolMetrics>> {
  const ordered: Partial<Record<Category, ToolMetrics>> = {}
  for (const category of CATEGORIES) {
    const measured = metrics[category]
    const fields: ToolMetrics = {
      ...number('functionsTotal', measured.functionsTotal),
      ...number('functionsOverCeiling', measured.functionsOverCeiling),
      ...number('formattableFiles', measured.formattableFiles),
      ...number('duplicationPercent', measured.duplicationPercent),
      ...number('mutationScore', measured.mutationScore),
      ...number('mutantsDetected', measured.mutantsDetected),
      ...number('mutantsUndetected', measured.mutantsUndetected),
      ...number('lineCoveragePercent', measured.lineCoveragePercent),
    }
    if (Object.keys(fields).length > 0) ordered[category] = fields
  }
  return ordered
}

/**
 * Findings per language per category, counted from the file each finding names
 * — the same extension mapping discovery classified the repo with, so the
 * breakdown cannot disagree with the file inventory.
 *
 * Only non-empty entries appear: a language with no findings in a category says
 * nothing, and a language that is not in the repo at all should not show up as
 * a row of zeroes. Advisory findings are counted like any other; whether one
 * moved a grade is `gradeScope` on the finding itself.
 */
function countByLanguage(
  findings: readonly Finding[],
): Partial<Record<Language, Partial<Record<Category, number>>>> {
  const breakdown: Partial<Record<Language, Partial<Record<Category, number>>>> = {}
  for (const language of LANGUAGES) {
    const mine = findings.filter((finding) => languageOf(finding.file) === language)
    const counts: Partial<Record<Category, number>> = {}
    for (const category of CATEGORIES) {
      const total = mine.filter((finding) => finding.category === category).length
      if (total > 0) counts[category] = total
    }
    if (Object.keys(counts).length > 0) breakdown[language] = counts
  }
  return breakdown
}

function number(field: keyof ToolMetrics, value: number | undefined): ToolMetrics {
  return value === undefined ? {} : { [field]: value }
}

function orderedCategories(
  states: Readonly<Record<Category, CategoryState>>,
): Record<Category, CategoryState> {
  const ordered = {} as Record<Category, CategoryState>
  for (const category of CATEGORIES) ordered[category] = orderedState(states[category])
  return ordered
}

function orderedState(state: CategoryState): CategoryState {
  return state.status === 'graded'
    ? { status: 'graded', grade: state.grade }
    : { status: state.status, reason: state.reason }
}

function orderedFinding(finding: Finding): ReportFinding {
  return {
    id: finding.id,
    category: finding.category,
    tool: finding.tool,
    rule: finding.rule,
    severity: finding.severity,
    file: finding.file,
    // Attribution, never identity: `id` is hashed from the repo-root-relative
    // path, so moving a project boundary around a file cannot change it.
    ...(finding.project === undefined ? {} : { project: finding.project }),
    range: {
      startLine: finding.range.startLine,
      startCol: finding.range.startCol,
      endLine: finding.range.endLine,
      endCol: finding.range.endCol,
    },
    message: finding.message,
    // Dependency findings only: the one-line message above is the rollup, and
    // these are the package it is about and the advisories it rolled up.
    ...(finding.package === undefined
      ? {}
      : {
          package: {
            name: finding.package.name,
            version: finding.package.version,
            ecosystem: finding.package.ecosystem,
          },
        }),
    ...(finding.packageAdvisories === undefined
      ? {}
      : {
          packageAdvisories: finding.packageAdvisories.map((advisory) => orderedAdvisory(advisory)),
        }),
    provenance: finding.provenance,
    ...(finding.related === undefined ? {} : { related: finding.related }),
    ...(finding.fixHint === undefined ? {} : { fixHint: finding.fixHint }),
  }
}

/** One nested advisory, in the schema's key order. Sorted by the runner. */
function orderedAdvisory(advisory: PackageAdvisory): PackageAdvisory {
  return {
    id: advisory.id,
    aliases: advisory.aliases,
    severity: advisory.severity,
    summary: advisory.summary,
    ...(advisory.fixedIn === undefined ? {} : { fixedIn: advisory.fixedIn }),
    ...(advisory.reachability === undefined ? {} : { reachability: advisory.reachability }),
    ...(advisory.scope === undefined ? {} : { scope: advisory.scope }),
  }
}

function compare(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
