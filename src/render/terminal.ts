import pc from 'picocolors'
import type { Category, Finding, Grade, Severity } from '../core/types.ts'
import { CATEGORIES } from '../core/types.ts'
import { CATEGORY_LABELS } from './display.ts'
import type { Report } from './json.ts'

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

  const shown = report.findings.slice(0, limit)
  if (shown.length > 0) {
    lines.push('', color.bold('Top findings'))
    for (const finding of shown) lines.push(findingLine(finding, color))
    if (report.findings.length > shown.length) {
      lines.push(color.dim(`  … ${report.findings.length - shown.length} more in report.json`))
    }
  }

  const degraded = report.tools.filter((tool) => tool.state !== 'ok')
  if (degraded.length > 0) {
    lines.push('', color.bold('Tools that did not complete'))
    for (const tool of degraded) {
      lines.push(`  ${color.red(tool.state)} ${tool.tool}: ${tool.reason ?? 'no reason given'}`)
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
