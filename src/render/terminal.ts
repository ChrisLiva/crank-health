import pc from 'picocolors'
import type { Category, Finding, Grade, Severity } from '../core/types.ts'
import { CATEGORIES } from '../core/types.ts'
import { CATEGORY_LABELS, stateLabel } from './display.ts'
import type { Report, ReportDelta } from './json.ts'

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
  return lines
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
  return `  ${label} ${grade} ${color.dim(measure(report.findings, category))}`
}

/** What the grade was computed from, in the fewest words that are still true. */
function measure(findings: readonly Finding[], category: Category): string {
  const mine = findings.filter((finding) => finding.category === category)
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
