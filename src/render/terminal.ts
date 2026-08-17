import pc from 'picocolors'
import type { Category, Finding, Grade, Severity } from '../core/types.ts'
import { CATEGORIES } from '../core/types.ts'
import {
  CATEGORY_LABELS,
  collapseToolRows,
  hasProjectMovement,
  movedCategories,
  notSelectedNote,
  percent,
  plural,
  projectLabel,
  rootShellNote,
  standInNote,
  stateLabel,
  unselectedCategories,
} from './display.ts'
import type {
  Report,
  ReportCoverage,
  ReportDelta,
  ReportProject,
  ReportProjectMovement,
  ReportUnassessed,
} from './json.ts'
import { reportFindings, withGradeScope } from './json.ts'

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
  // Graded and advisory rows are two arrays in the schema and one glance here;
  // the split is what `report.json` is for.
  const all = reportFindings(report)

  // What the grades are a statement about, directly above them: every
  // denominator under this line is the assessed half of it.
  const coverage = coverageLine(report.coverage)
  if (coverage !== null) lines.push(color.dim(coverage))

  // The categories `--only` left out are one line under the ones it kept, not a
  // line each: rows saying "nobody asked" are what a `--only` run came here to
  // skip past (spec §9).
  const omit = unselectedCategories(report)
  for (const category of CATEGORIES) {
    if (!omit.includes(category)) lines.push(...categoryLines(report, all, category, color))
  }
  if (omit.length > 0) lines.push(color.dim(`  ${notSelectedNote(omit)}`))

  const projects = projectLines(report, color)
  if (projects.length > 0) lines.push('', ...projects)

  if (report.delta !== undefined) lines.push('', ...deltaLines(report.delta, color))

  // In PR mode the findings worth a glance are the ones this change introduced;
  // the pre-existing ones are in report.md, and listing them here would bury
  // the regression under a wall of things the author did not do.
  const source = rankFindings(
    report.delta?.newFindings.map((entry) => withGradeScope(entry)) ?? all,
    manifestFiles(all),
  )
  const shown = source.slice(0, limit)
  if (shown.length > 0) {
    lines.push('', color.bold(report.delta === undefined ? 'Top findings' : 'Top new findings'))
    for (const finding of shown) lines.push(findingLine(finding, color))
    if (source.length > shown.length) {
      lines.push(color.dim(`  … ${source.length - shown.length} more in report.json`))
    }
  }

  // Every tool with something to say: the ones that did not complete, and the
  // ones that did but qualified the answer — gitleaks suppressing hits outside
  // the inventory, osv-scanner unable to read Central Package Management.
  // `report.md` has always printed both; a note only that surface carries is a
  // note most readers never see, and a partial scan then reads as a clean one.
  // A tool with no reason is not news, so the block is never a roll call.
  const notes = collapseToolRows(
    report.tools.filter((tool) => tool.state !== 'ok' || tool.reason !== null),
  )
  if (notes.length > 0) {
    lines.push('', color.bold('Tool notes'))
    for (const tool of notes) {
      const side = tool.side === undefined ? '' : ` (${tool.side} scan)`
      const stands = standInNote(tool, report.projects.length)
      // Red is for the runs that did not happen; a completed run's note is a
      // footnote, and painting it like a failure would cry wolf.
      const state = tool.state === 'ok' ? color.dim(tool.state) : color.red(tool.state)
      lines.push(
        `  ${state} ${tool.tool}${side}: ${tool.reason ?? 'no reason given'}` +
          `${stands === null ? '' : ` ${stands}`}`,
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

/** Severity, most urgent first — the last question the ranking asks. */
const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 0,
  error: 1,
  warning: 2,
  info: 3,
}

/**
 * The findings in the order a reader should meet them, which is not the order
 * `report.json` carries them in — that order is the contract, and it is sorted
 * by location so a diff of two reports reads.
 *
 * Three questions, in this order: did it move a grade, is it in source somebody
 * wrote, and how bad is it. A default config's opinion about a generated
 * lockfile is the last thing a glance should lead with, however critical the
 * advisory database calls it.
 *
 * `toSorted` is stable, so findings the three questions cannot separate keep
 * the report's own order and two runs cannot disagree.
 */
function rankFindings<T extends Finding>(
  findings: readonly T[],
  manifests: ReadonlySet<string>,
): T[] {
  return findings.toSorted((a, b) => {
    const left = rankOf(a, manifests)
    const right = rankOf(b, manifests)
    return left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
  })
}

/** One finding's place in {@link rankFindings}' three questions. */
function rankOf(
  finding: Finding,
  manifests: ReadonlySet<string>,
): readonly [number, number, number] {
  return [
    finding.gradeScope ? 0 : 1,
    manifests.has(finding.file) ? 1 : 0,
    SEVERITY_RANK[finding.severity],
  ]
}

/**
 * The files this scan's dependency findings are about — lockfiles and package
 * manifests, whatever an ecosystem calls them.
 *
 * Read off the findings that carry the pinned {@link Finding.package} they are
 * about, because those are the only rows that know: a scanner that reports a
 * vulnerable dependency reports the manifest it is pinned in. Matching names or
 * extensions instead would need a new entry per ecosystem and would still be
 * guessing.
 */
function manifestFiles(findings: readonly Finding[]): ReadonlySet<string> {
  return new Set(
    findings.filter((finding) => finding.package !== undefined).map((finding) => finding.file),
  )
}

/** How many extensions the unassessed remainder is named by before it is summed. */
const MAX_UNASSESSED = 5

/** A remainder this many lines or more is worth a line count beside its files. */
const LINES_WORTH_NAMING = 1000

/**
 * How much of the tree the grades under it are about: the assessed share, then
 * what the remainder is made of.
 *
 * Every denominator in the report is the *assessed* count, so a repo can be
 * graded A across the board while a third of it was never read by any tool. A
 * scan whose inventory is empty says nothing here — "assessed 0 of 0 files" is
 * not a fact about coverage.
 */
function coverageLine(coverage: ReportCoverage): string | null {
  if (coverage.files.total === 0) return null
  const assessed = `  assessed ${coverage.files.assessed} of ${plural(coverage.files.total, 'file')}`
  if (coverage.unassessed.length === 0) return assessed

  const ranked = coverage.unassessed.toSorted(byWeight)
  const named = ranked.slice(0, MAX_UNASSESSED).map((entry) => unassessedPart(entry))
  const rest = ranked.length - named.length
  return `${assessed}; not assessed: ${named.join(', ')}${rest === 0 ? '' : `, +${rest} more`}`
}

/**
 * Biggest remainder first — the part a reader would want named — with the line
 * count and then the extension as total tiebreakers, so two runs cannot order
 * two equal remainders differently.
 */
function byWeight(a: ReportUnassessed, b: ReportUnassessed): number {
  return b.files - a.files || b.lines - a.lines || (a.extension < b.extension ? -1 : 1)
}

/**
 * `28 .go (2.4k lines)`. The line count is named only where it reaches a
 * thousand: under that the file count is the whole story, and a count beside
 * every extension is the noise the glance exists to leave out.
 */
function unassessedPart(entry: ReportUnassessed): string {
  const what = entry.extension === '' ? 'without an extension' : entry.extension
  const lines =
    entry.lines < LINES_WORTH_NAMING ? '' : ` (${(entry.lines / 1000).toFixed(1)}k lines)`
  return `${entry.files} ${what}${lines}`
}

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
 * would say nothing: the block is only rendered where there is more than one —
 * or where the root is a workspace shell, which a one-package workspace has to
 * be told about too, since its one project is not the repo root a reader
 * assumes.
 */
function projectLines(report: Report, color: Colors): string[] {
  if (report.projects.length < 2 && report.rootShell === undefined) return []
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

/**
 * One category's grade, and — where it has any — the advisory findings the
 * grade is *not* about, on a line of their own.
 *
 * The two are separate facts: how many findings moved the letter, and how many
 * were reported beside it without counting. Said in one clause they read as one
 * number a reader has to unpick before the letter means anything.
 */
function categoryLines(
  report: Report,
  findings: readonly Finding[],
  category: Category,
  color: Colors,
): string[] {
  const state = report.categories[category]
  const label = CATEGORY_LABELS[category].padEnd(13)
  const advisory = findings.filter(
    (finding) => finding.category === category && !finding.gradeScope,
  ).length
  const note =
    advisory === 0
      ? []
      : [color.dim(`    ${plural(advisory, 'advisory finding')}, not counted toward the grade`)]

  // Pad before colouring: escape sequences have length but no width.
  if (state.status !== 'graded') {
    const status = state.status === 'error' ? 'error' : 'not assessed'
    const tint = state.status === 'error' ? color.red : color.dim
    return [`  ${color.dim(label)} ${tint(status.padEnd(13))} ${color.dim(state.reason)}`, ...note]
  }
  const grade = gradeColor(state.grade, color)(state.grade.padEnd(13))
  return [`  ${label} ${grade} ${color.dim(measure(report, findings, category))}`, ...note]
}

/** What the grade was computed from, in the fewest words that are still true. */
function measure(report: Report, findings: readonly Finding[], category: Category): string {
  // Test quality is the one grade whose basis is not a count of findings: the
  // findings are the surviving mutants, the grade is the score (spec §3).
  const score = category === 'test-quality' ? report.metrics[category]?.mutationScore : undefined
  if (score !== undefined) return `mutation score ${percent(score)}`

  const mine = findings.filter((finding) => finding.category === category)
  if (mine.length === 0) return 'no findings'
  return plural(mine.filter((finding) => finding.gradeScope).length, 'graded finding')
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
