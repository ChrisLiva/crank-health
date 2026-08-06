import pc from 'picocolors'
import type { Category, Finding, Grade, Severity } from '../core/types.ts'
import { CATEGORIES } from '../core/types.ts'
import {
  CATEGORY_LABELS,
  hasProjectMovement,
  movedCategories,
  percent,
  plural,
  projectLabel,
  rootShellNote,
  stateLabel,
} from './display.ts'
import type { Report, ReportDelta, ReportProject, ReportProjectMovement } from './json.ts'

/**
 * The terminal summary (spec §9): every category's grade, then the findings
 * worth looking at first. Everything else lives in the run directory — this is
 * the glance, not the report.
 */

export interface TerminalOptions {
  /** Defaults to picocolors' own detection, which honours NO_COLOR and TTY. */
  readonly color?: boolean | undefined
  /** How many findings the summary lists before deferring to the report. */
  readonly maxFindings?: number | undefined
}

/** Where a run left its artifacts (spec §9); every one of them gets named. */
export interface ArtifactPaths {
  /** Absolute path of `report.md`, the full human report. */
  readonly markdown: string
  /** Absolute path of `agent.md`, the task list for a coding agent. */
  readonly agent: string
  /** Absolute path of `report.json`. */
  readonly json: string
}

const DEFAULT_MAX_FINDINGS = 10

/**
 * Renders the whole summary, trailing newline included.
 *
 * @param artifacts where this run wrote its artifacts
 */
export function renderTerminal(
  report: Report,
  artifacts: ArtifactPaths,
  options: TerminalOptions = {},
): string {
  const color = pc.createColors(options.color ?? pc.isColorSupported)
  const limit = options.maxFindings ?? DEFAULT_MAX_FINDINGS
  const lines: string[] = ['', header(report, color), '']

  for (const category of CATEGORIES) {
    lines.push(categoryLine(report, category, color))
  }

  const projects = projectLines(report, color)
  if (projects.length > 0) lines.push('', ...projects)

  if (report.delta !== undefined) lines.push('', ...deltaLines(report.delta, color))

  // In PR mode the findings worth a glance are the ones this change introduced;
  // the pre-existing ones are in report.md, and listing them here would bury
  // the regression under a wall of things the author did not do.
  const source = report.delta?.newFindings ?? report.findings
  const shown = source.slice(0, limit)
  if (shown.length > 0) {
    lines.push('', color.bold(report.delta === undefined ? 'Top findings' : 'Top new findings'))
    for (const finding of shown) lines.push(findingLine(finding, color))
    if (source.length > shown.length) {
      lines.push(color.dim(`  … ${source.length - shown.length} more in report.json`))
    }
  }

  const degraded = report.tools.filter((tool) => tool.state !== 'ok')
  if (degraded.length > 0) {
    lines.push('', color.bold('Tools that did not complete'))
    for (const tool of degraded) {
      const side = tool.side === undefined ? '' : ` (${tool.side} scan)`
      lines.push(
        `  ${color.red(tool.state)} ${tool.tool}${side}: ${tool.reason ?? 'no reason given'}`,
      )
    }
  }

  for (const warning of report.warnings) lines.push(color.yellow(`  warning: ${warning}`))

  lines.push(
    '',
    color.dim(`Report: ${artifacts.markdown}`),
    color.dim(`Agent:  ${artifacts.agent}`),
    color.dim(`Data:   ${artifacts.json}`),
    '',
  )
  return lines.join('\n')
}

type Colors = ReturnType<typeof pc.createColors>

/**
 * The PR delta at a glance (spec §4): the three counts, then the categories
 * whose state actually moved. Categories that did not move are in `report.md`'s
 * full movement table — a summary that reprints all eight rows unchanged is not
 * a summary.
 */
function deltaLines(delta: ReportDelta, color: Colors): string[] {
  const lines = [
    color.bold(`PR delta vs ${delta.baseRef}`) +
      color.dim(` (merge-base ${delta.mergeBase.slice(0, 8)})`),
    `  ${color.red(`+${delta.counts.new} new`)}` +
      color.dim(` (${delta.counts.touchedLine} on changed lines)`) +
      ` · ${color.green(`-${delta.counts.resolved} resolved`)}` +
      color.dim(` · ${delta.counts.unchanged} unchanged`),
  ]
  const moved = delta.categories.filter(
    (movement) => stateLabel(movement.base) !== stateLabel(movement.head),
  )
  for (const movement of moved) {
    lines.push(
      `  ${CATEGORY_LABELS[movement.category].padEnd(13)} ${stateLabel(movement.base)} → ${stateLabel(movement.head)}`,
    )
  }
  return [...lines, ...projectDeltaLines(delta, color)]
}

/**
 * Which projects this change moved, under the delta it adds up to.
 *
 * Only the ones that moved get a line — a package this change did not touch has
 * nothing to say here — and the rest are counted in one. A single-project repo
 * *is* the delta above, so it renders nothing at all.
 */
function projectDeltaLines(delta: ReportDelta, color: Colors): string[] {
  if (delta.projects.length < 2) return []
  const moved = delta.projects.filter((project) => hasProjectMovement(project))
  if (moved.length === 0) {
    return [color.dim(`  every project unchanged (${delta.projects.length})`)]
  }

  const width = Math.max(...moved.map((project) => projectLabel(project.path).length))
  const lines = moved.map(
    (project) =>
      `  ${projectLabel(project.path).padEnd(width)}  ${projectMovement(project, color)}`,
  )
  const still = delta.projects.length - moved.length
  if (still > 0) lines.push(color.dim(`  ${plural(still, 'other project')} unchanged`))
  return lines
}

/** `project added · +1 new · lint not assessed → F` — what moved, in order. */
function projectMovement(project: ReportProjectMovement, color: Colors): string {
  const parts: string[] = []
  if (project.churn !== 'none') parts.push(color.bold(`project ${project.churn}`))
  if (project.newFindings > 0) parts.push(color.red(`+${project.newFindings} new`))
  if (project.resolvedFindings > 0) parts.push(color.green(`-${project.resolvedFindings} resolved`))
  return [...parts, ...movedCategories(project)].join(color.dim(' · '))
}

/**
 * The projects inside the repo, in path order, under the rollup they add up to.
 *
 * One line each, naming the categories this project was graded on and counting
 * the ones nothing assessed — this is the glance, and eight rows per package is
 * a report. `report.md` carries every project's eight states in full.
 *
 * A single-project repo is the whole repo, and repeating the grades above it
 * would say nothing: the block is only rendered where there is more than one.
 */
function projectLines(report: Report, color: Colors): string[] {
  if (report.projects.length < 2) return []
  const lines = [color.bold('Projects')]
  if (report.rootShell !== undefined) lines.push(color.dim(`  ${rootShellNote(report.rootShell)}`))

  const width = Math.max(...report.projects.map((project) => projectLabel(project.path).length))
  for (const project of report.projects) {
    lines.push(`  ${projectLabel(project.path).padEnd(width)}  ${projectGrades(project, color)}`)
  }
  return lines
}

/** `types A · lint F · 5 not assessed` — what this project was graded on. */
function projectGrades(project: ReportProject, color: Colors): string {
  const parts: string[] = []
  let unassessed = 0
  for (const category of CATEGORIES) {
    const state = project.categories[category]
    const label = CATEGORY_LABELS[category]
    if (state.status === 'graded')
      parts.push(`${label} ${gradeColor(state.grade, color)(state.grade)}`)
    else if (state.status === 'error') parts.push(`${label} ${color.red('error')}`)
    else unassessed += 1
  }
  if (parts.length === 0) return color.dim('nothing assessed')
  const rest = unassessed === 0 ? '' : color.dim(` · ${unassessed} not assessed`)
  return `${parts.join(color.dim(' · '))}${rest}`
}

function header(report: Report, color: Colors): string {
  const commit = report.repo.commit === null ? 'no commits' : report.repo.commit.slice(0, 8)
  return `${color.bold('crank-health')} ${report.crankHealth} · ${report.repo.path} @ ${commit} · ${report.profile}`
}

function categoryLine(report: Report, category: Category, color: Colors): string {
  const state = report.categories[category]
  const label = CATEGORY_LABELS[category].padEnd(13)

  // Pad before colouring: escape sequences have length but no width.
  if (state.status !== 'graded') {
    const status = state.status === 'error' ? 'error' : 'not assessed'
    const tint = state.status === 'error' ? color.red : color.dim
    return `  ${color.dim(label)} ${tint(status.padEnd(13))} ${color.dim(state.reason)}`
  }
  const grade = gradeColor(state.grade, color)(state.grade.padEnd(13))
  return `  ${label} ${grade} ${color.dim(measure(report, category))}`
}

/** What the grade was computed from, in the fewest words that are still true. */
function measure(report: Report, category: Category): string {
  // Test quality is the one grade whose basis is not a count of findings: the
  // findings are the surviving mutants, the grade is the score (spec §3).
  const score = category === 'test-quality' ? report.metrics[category]?.mutationScore : undefined
  if (score !== undefined) return `mutation score ${percent(score)}`

  const mine = report.findings.filter((finding) => finding.category === category)
  const graded = mine.filter((finding) => finding.gradeScope).length
  const advisory = mine.length - graded
  if (mine.length === 0) return 'no findings'
  const parts = [`${graded} graded`]
  if (advisory > 0) parts.push(`${advisory} advisory`)
  return `${parts.join(', ')} ${mine.length === 1 ? 'finding' : 'findings'}`
}

function findingLine(finding: Finding, color: Colors): string {
  const where = `${finding.file}:${finding.range.startLine}:${finding.range.startCol}`
  const advisory = finding.gradeScope ? '' : color.dim(' [advisory]')
  return `  ${severityColor(finding.severity, color)(finding.severity.padEnd(8))} ${where}  ${color.dim(finding.rule)}  ${finding.message}${advisory}`
}

function gradeColor(grade: Grade, color: Colors): (text: string) => string {
  if (grade === 'A' || grade === 'B') return color.green
  if (grade === 'C') return color.yellow
  return color.red
}

function severityColor(severity: Severity, color: Colors): (text: string) => string {
  if (severity === 'critical' || severity === 'error') return color.red
  if (severity === 'warning') return color.yellow
  return color.dim
}
