import { ROOT_PROJECT } from '../core/discover.ts'
import type { Category, CategoryState, Finding, Language } from '../core/types.ts'
import { CATEGORIES } from '../core/types.ts'
import type { Report, ReportProjectMovement, ReportRootShell, ReportTool } from './json.ts'

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

/**
 * Human labels for the wire-format language ids. An exhaustive `Record`, so a
 * fourth language cannot ship without deciding what to call it.
 */
export const LANGUAGE_LABELS: Readonly<Record<Language, string>> = {
  'js-ts': 'JS/TS',
  python: 'Python',
  csharp: 'C#',
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

/**
 * The tool rows a reader sees, with the ones that say the same thing twice
 * removed: in a thirty-package monorepo "opengrep is not on PATH" is one fact,
 * not thirty rows of it (spec §9).
 *
 * The key is the union of the cells both renderers print, so a row surviving
 * here is one no reader could have told from the one above it, in either
 * surface. `project`, `repoWide`, `detection` and `raw` are left out because
 * neither the terminal's degraded list nor `report.md`'s tool table prints
 * them: what a run was about is `report.json`'s answer, and the per-project
 * toolchain table's.
 *
 * The first row of a group survives and the input order is kept, so the report
 * stays the deterministic order {@link buildReport} put the runs in.
 */
export function collapseToolRows(tools: readonly ReportTool[]): readonly ReportTool[] {
  const seen = new Set<string>()
  return tools.filter((tool) => {
    const key = JSON.stringify([
      tool.tool,
      tool.category,
      tool.scope,
      tool.side ?? null,
      tool.state,
      tool.reason,
      tool.execution,
      tool.provenance,
      tool.version,
      tool.pinned,
    ])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * The categories this run was never asked to assess: everything `--only` left
 * out, in {@link CATEGORIES} order (spec §9).
 *
 * Read off {@link Report.selected} rather than off the reason the skipped
 * states carry, so the renderers depend on what the run was asked for and not
 * on a sentence anyone could reword. `report.json` still carries all eight
 * states either way — this hides rendered lines, never a state.
 */
export function unselectedCategories(report: Report): readonly Category[] {
  return CATEGORIES.filter((category) => !report.selected.includes(category))
}

/**
 * The one line that stands in for the categories {@link unselectedCategories}
 * returned: a row each, all saying the same thing, is the noise a `--only` run
 * should not have to read past.
 *
 * Only emitted where there is something to name; an empty list has no sentence.
 */
export function notSelectedNote(categories: readonly Category[]): string {
  const labels = categories.map((category) => CATEGORY_LABELS[category]).join(', ')
  return `Not assessed: not selected by \`--only\` — ${labels}`
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
