import type { RunRecord } from '../core/orchestrator.ts'
import type { Category, CategoryState, Finding, RunnerScope } from '../core/types.ts'
import { CATEGORIES, categoryRank } from '../core/types.ts'
import { TOOL_MANIFEST } from '../manifest.ts'
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
  readonly mode: 'whole-repo'
  /** The categories this run was asked to assess (`--only`, or all of them). */
  readonly selected: readonly Category[]
  /** All eight states, always — including the ones nothing assessed (spec §8). */
  readonly categories: Readonly<Record<Category, CategoryState>>
  readonly tools: readonly ReportTool[]
  readonly findings: readonly Finding[]
  readonly warnings: readonly string[]
  /** Everything non-deterministic, quarantined. */
  readonly timings: ReportTimings
}

export interface ReportRepo {
  readonly path: string
  /** `null` in a repo with no commits yet. */
  readonly commit: string | null
}

export interface ReportTool {
  readonly tool: string
  readonly category: Category
  readonly scope: RunnerScope
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
}

export interface ReportInput {
  readonly repoPath: string
  readonly commit: string | null
  readonly profile: 'quick' | 'deep'
  readonly selected: readonly Category[]
  readonly categories: Readonly<Record<Category, CategoryState>>
  readonly runs: readonly ResolvedRun[]
  readonly findings: readonly Finding[]
  readonly warnings: readonly string[]
  readonly generatedAt: string
  readonly durationMs: number
}

/** Assembles the report object. Pure: no clock, no filesystem, no ordering luck. */
export function buildReport(input: ReportInput): Report {
  const runs = input.runs.toSorted(
    (a, b) =>
      categoryRank(a.record.category) - categoryRank(b.record.category) ||
      compare(a.record.tool, b.record.tool) ||
      compare(a.record.scope, b.record.scope),
  )

  return {
    schemaVersion: SCHEMA_VERSION,
    crankHealth: VERSION,
    repo: { path: input.repoPath, commit: input.commit },
    profile: input.profile,
    mode: 'whole-repo',
    selected: CATEGORIES.filter((category) => input.selected.includes(category)),
    categories: orderedCategories(input.categories),
    tools: runs.map((run) => toReportTool(run)),
    findings: input.findings.map((finding) => orderedFinding(finding)),
    warnings: input.warnings.toSorted(compare),
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

function toReportTool(run: ResolvedRun): ReportTool {
  const { record } = run
  const detection = record.detection
  const installed = detection?.installed === true
  return {
    tool: record.tool,
    category: record.category,
    scope: record.scope,
    execution: installed ? 'repo-installed' : 'ephemeral-pinned',
    provenance: detection === null ? 'default-config' : 'repo-config',
    version: record.result.toolVersion ?? detection?.version ?? null,
    pinned: pinnedFor(record.tool),
    detection:
      detection === null
        ? null
        : {
            reason: detection.reason,
            configFiles: [...detection.configFiles].toSorted(compare),
            installed: detection.installed,
            version: detection.version ?? null,
          },
    state: record.result.state,
    reason: record.result.reason ?? null,
    raw: run.raw,
  }
}

function orderedCategories(
  states: Readonly<Record<Category, CategoryState>>,
): Record<Category, CategoryState> {
  const ordered = {} as Record<Category, CategoryState>
  for (const category of CATEGORIES) {
    const state = states[category]
    ordered[category] =
      state.status === 'graded'
        ? { status: 'graded', grade: state.grade }
        : { status: state.status, reason: state.reason }
  }
  return ordered
}

function orderedFinding(finding: Finding): Finding {
  return {
    id: finding.id,
    category: finding.category,
    tool: finding.tool,
    rule: finding.rule,
    severity: finding.severity,
    file: finding.file,
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

function pinnedFor(tool: string): string | null {
  return Object.hasOwn(TOOL_MANIFEST, tool)
    ? TOOL_MANIFEST[tool as keyof typeof TOOL_MANIFEST]
    : null
}

function compare(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
