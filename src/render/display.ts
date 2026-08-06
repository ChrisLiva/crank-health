import { ROOT_PROJECT } from '../core/discover.ts'
import type { Category, CategoryState, Finding } from '../core/types.ts'
import type { ReportProjectMovement, ReportRootShell } from './json.ts'

/**
 * The vocabulary every renderer shares: how a category, a grade state and a
 * finding's location are spelled. Three renderers writing "dead code" three
 * times is three chances to disagree about what the report says.
 */

/** Human labels for the wire-format category ids. */
export const CATEGORY_LABELS: Readonly<Record<Category, string>> = {
  security: 'security',
  types: 'types',
  'dead-code': 'dead code',
  complexity: 'complexity',
  duplication: 'duplication',
  lint: 'lint',
  format: 'format',
  'test-quality': 'test quality',
}

/** The marker on a finding that was reported but did not move a grade (spec §1). */
export const ADVISORY_TAG = '[advisory]'

/**
 * The marker on a new PR finding sitting on a line the change touched — spec
 * §4's "directly-actionable". Its absence on a new finding is meaningful too:
 * that one is a non-local regression, caused from somewhere else.
 */
export const TOUCHED_TAG = '[in-diff]'

/**
 * A project's path as a reader reads it. `.` is the root project's identity in
 * `report.json`, and a bare dot at the head of a section says nothing.
 */
export function projectLabel(path: string): string {
  return path === ROOT_PROJECT ? 'repo root' : path
}

/**
 * True when a project has anything to say about a change: it was added or
 * removed, it gained or lost a finding, or one of its grades moved. The
 * renderers all show the projects that moved and collapse the rest, so what
 * counts as movement is decided once, here.
 */
export function hasProjectMovement(project: ReportProjectMovement): boolean {
  return (
    project.churn !== 'none' ||
    project.newFindings > 0 ||
    project.resolvedFindings > 0 ||
    movedCategories(project).length > 0
  )
}

/** `lint B → F` for each of a project's categories whose state is not the one it was. */
export function movedCategories(project: ReportProjectMovement): string[] {
  return project.categories
    .filter((movement) => stateLabel(movement.base) !== stateLabel(movement.head))
    .map(
      (movement) =>
        `${CATEGORY_LABELS[movement.category]} ${stateLabel(movement.base)} → ${stateLabel(movement.head)}`,
    )
}

/**
 * The workspace-shell root in one sentence: it holds no source of its own, so
 * there is nothing to grade there and it is not in the project list.
 */
export function rootShellNote(shell: ReportRootShell): string {
  const declared =
    shell.declaredBy.length === 0 ? '' : ` (declared by ${shell.declaredBy.join(', ')})`
  return `The repo root is a workspace shell${declared}: it holds no source of its own, so it is not graded as a project.`
}

/** A grade letter, or the degradation state, in the fewest words that are true. */
export function stateLabel(state: CategoryState): string {
  if (state.status === 'graded') return state.grade
  return state.status === 'error' ? 'error' : 'not assessed'
}

/**
 * `file:line`, or bare `file` for a whole-file finding.
 *
 * Tools that judge a file rather than a place in it — a formatter, a lockfile
 * vulnerability scanner — report the range 1:1:1:1. Printing `package-lock.json:1`
 * would invent a location the reader then goes and looks at.
 */
export function location(finding: Finding): string {
  return isFileLevel(finding) ? finding.file : `${finding.file}:${finding.range.startLine}`
}

/** True when the range carries no real position; see {@link location}. */
export function isFileLevel(finding: Finding): boolean {
  const { startLine, startCol, endLine, endCol } = finding.range
  return startLine === 1 && startCol === 1 && endLine === 1 && endCol === 1
}

/** `1 file` / `3 files`. */
export function plural(count: number, singular: string, many = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : many}`
}

/** A percentage, rounded the same way everywhere so two runs cannot differ. */
export function percent(value: number): string {
  return `${value.toFixed(1)}%`
}
