import type { Category, CategoryState, Finding } from '../core/types.ts'

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
