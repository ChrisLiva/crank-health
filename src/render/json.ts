import type { DeltaResult } from '../core/delta.ts'
import type { RootShell } from '../core/discover.ts'
import { languageOf } from '../core/discover.ts'
import type { RunRecord } from '../core/orchestrator.ts'
import type {
  Category,
  CategoryState,
  Finding,
  Language,
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
export const SCHEMA_VERSION = 1

export interface Report {
  readonly schemaVersion: number
  readonly crankHealth: string
  readonly repo: ReportRepo
  readonly profile: 'quick' | 'deep'
  readonly mode: 'whole-repo' | 'pr'
  /** The categories this run was asked to assess (`--only`, or all of them). */
  readonly selected: readonly Category[]
  /** All eight states, always — including the ones nothing assessed (spec §8). */
  readonly categories: Readonly<Record<Category, CategoryState>>
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
  readonly findings: readonly Finding[]
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
  /** Findings present at head and not at the merge-base. */
  readonly newFindings: readonly ReportNewFinding[]
  /** Findings present at the merge-base and gone at head, at their head paths. */
  readonly resolvedFindings: readonly Finding[]
}

export interface ReportDeltaCounts {
  readonly new: number
  /** Of the new ones, how many sit on a line this change touched (spec §4). */
  readonly touchedLine: number
  readonly resolved: number
  /** Findings both scans saw. Not listed anywhere — this is the whole record. */
  readonly unchanged: number
}

export interface ReportCategoryMovement {
  readonly category: Category
  readonly base: CategoryState
  readonly head: CategoryState
  readonly newFindings: number
  readonly resolvedFindings: number
}

/** A finding in {@link ReportDelta.newFindings}: the schema plus the flag. */
export type ReportNewFinding = Finding & { readonly touchedLine: boolean }

export interface ReportRepo {
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

export interface ReportDetection {
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

export interface ReportTimings {
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
  readonly categories: Readonly<Record<Category, CategoryState>>
  readonly metrics: Readonly<Record<Category, ToolMetrics>>
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

  return {
    schemaVersion: SCHEMA_VERSION,
    crankHealth: VERSION,
    repo: { path: input.repoPath, commit: input.commit },
    profile: input.profile,
    mode: input.delta === undefined ? 'whole-repo' : 'pr',
    selected: CATEGORIES.filter((category) => input.selected.includes(category)),
    categories: orderedCategories(input.categories),
    metrics: orderedMetrics(input.metrics),
    languages: countByLanguage(input.findings),
    projects: input.projects
      .toSorted((a, b) => compare(a.project.path, b.project.path))
      .map((scan) => toReportProject(scan, runs)),
    ...(input.rootShell === undefined
      ? {}
      : { rootShell: { declaredBy: input.rootShell.declaredBy.toSorted(compare) } }),
    tools: runs.map((run) => toReportTool(run)),
    findings: input.findings.map((finding) => orderedFinding(finding)),
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
    metrics: orderedMetrics(scan.metrics),
    toolchain: runs.flatMap(({ record, side }) => {
      const detection = record.detection
      if (side === 'base' || record.project !== scan.project.path || detection === null) return []
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
    categories: delta.categories.map((movement) => ({
      category: movement.category,
      base: orderedState(movement.base),
      head: orderedState(movement.head),
      newFindings: movement.newFindings,
      resolvedFindings: movement.resolvedFindings,
    })),
    newFindings: delta.newFindings.map((entry) => ({
      ...orderedFinding(entry.finding),
      touchedLine: entry.touchedLine,
    })),
    resolvedFindings: delta.resolvedFindings.map((finding) => orderedFinding(finding)),
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

function orderedFinding(finding: Finding): Finding {
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
    provenance: finding.provenance,
    gradeScope: finding.gradeScope,
    ...(finding.fixHint === undefined ? {} : { fixHint: finding.fixHint }),
  }
}

function compare(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
