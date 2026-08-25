import { ROOT_PROJECT } from '../core/discover.ts'
import type { Category, CategoryState, Finding, Language } from '../core/types.ts'
import { CATEGORIES } from '../core/types.ts'
import type {
  Report,
  ReportGradeBasis,
  ReportProjectMovement,
  ReportRootShell,
  ReportTool,
} from './json.ts'

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
 * new language cannot ship without deciding what to call it.
 */
export const LANGUAGE_LABELS: Readonly<Record<Language, string>> = {
  'js-ts': 'JS/TS',
  python: 'Python',
  csharp: 'C#',
  go: 'Go',
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
 * A tool row as a reader sees it: the row that survived the collapse, plus the
 * projects it now answers for. Render-only — `report.json` keeps one record per
 * run, and {@link ReportTool} is that contract.
 */
export interface CollapsedTool extends ReportTool {
  /**
   * The projects whose runs this row stands in for, in the order the report
   * carries them, each named once. Empty when no per-project run is behind it —
   * a repo-spanning scan answers for the repo, not for a list of packages.
   */
  readonly projects: readonly string[]
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
 * Removal alone would lose which packages the survivor is about, so it carries
 * them: {@link CollapsedTool.projects} is every project of the group, and
 * {@link standInNote} is how the two renderers spell it.
 *
 * The first row of a group survives and the input order is kept, so the report
 * stays the deterministic order {@link buildReport} put the runs in.
 */
export function collapseToolRows(tools: readonly ReportTool[]): readonly CollapsedTool[] {
  const groups = new Map<string, { readonly first: ReportTool; readonly projects: Set<string> }>()
  for (const tool of tools) {
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
    const group = groups.get(key) ?? { first: tool, projects: new Set<string>() }
    // A repo-spanning run is nobody's project; see {@link CollapsedTool.projects}.
    if (tool.repoWide !== true) group.projects.add(tool.project)
    groups.set(key, group)
  }
  // Map iteration is insertion order, so the first row of each group survives
  // where it stood.
  return [...groups.values()].map(({ first, projects }) => ({ ...first, projects: [...projects] }))
}

/**
 * Which projects a collapsed row stands in for, as a reader reads it —
 * `(repo root, packages/api)` — or `null` where naming them would say nothing:
 *
 * - a repo-spanning row: its scope is the repo, and a list of packages under it
 *   would read as the per-package claim it is not;
 * - a repo with one project: every row is that project's, so the list is a
 *   tautology repeated on every line.
 */
export function standInNote(tool: CollapsedTool, projectCount: number): string | null {
  if (tool.repoWide === true || tool.projects.length === 0 || projectCount < 2) return null
  return `(${tool.projects.map(projectLabel).join(', ')})`
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
 *
 * Shared, because two renderers ask the same question of it: the terminal ranks
 * a manifest's findings below hand-written source, and `agent.md` will not make
 * a task of a theme that only ever lands in one.
 */
export function manifestFiles(findings: readonly Finding[]): ReadonlySet<string> {
  return new Set(
    findings.filter((finding) => finding.package !== undefined).map((finding) => finding.file),
  )
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

/**
 * The two numbers one grade divided, in the formula's own words — `56 weighted
 * findings per 0.8 KLOC`, `1 of 12 files failing the formatter`, `3 graded
 * findings`.
 *
 * A letter on its own is not checkable: `lint: D` is the same letter over forty
 * warnings in a thousand lines and four hundred in ten thousand. Read straight
 * off {@link ReportGradeBasis}, so a reader can redo the division and a new
 * category needs no case here — the shape of the sentence follows the unit:
 *
 * - no denominator: the value is the whole measurement (`3 graded findings`);
 * - a unit naming what it is *per*: the denominator goes where "per" points;
 * - otherwise the denominator is the total the value is part of.
 */
export function basisAnnotation(basis: ReportGradeBasis): string {
  const value = basis.unit.startsWith('%') ? percent(basis.value) : amount(basis.value)
  const unit = basis.unit.startsWith('%') ? basis.unit.slice(1) : ` ${basis.unit}`
  if (basis.denominator === null) return `${value}${singularAt(value, unit)}`

  const [numerator = basis.unit, per] = basis.unit.split(' per ')
  if (per !== undefined)
    return `${value} ${singularAt(value, numerator)} per ${amount(basis.denominator)} ${per}`
  // In the `of` shape the unit's noun counts the denominator, not the value.
  const denominator = amount(basis.denominator)
  return `${value} of ${denominator}${singularAt(denominator, unit)}`
}

/** The plural nouns {@link ReportGradeBasis} units use, singular when their count is one. */
function singularAt(count: string, text: string): string {
  if (count !== '1') return text
  return text.replace(/\b(findings|files|functions)\b/, (noun) => noun.slice(0, -1))
}

/**
 * One decimal place at most, and no trailing `.0` on a whole number — except
 * below one, where a single decimal place rounds a real number to zero and a
 * grade divided by nothing reads as arithmetic nobody did. A repo of twelve
 * lines is `0.012` KLOC, not `0`.
 */
function amount(value: number): string {
  if (value === 0 || Math.abs(value) >= 1) return String(Math.round(value * 10) / 10)
  return String(Number(value.toPrecision(2)))
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
export function location(finding: Located): string {
  return isFileLevel(finding) ? finding.file : `${finding.file}:${finding.range.startLine}`
}

/**
 * What {@link location} needs of a finding — the serialized row shape as much as
 * the core's, so `report.json`'s rows can be rendered without being rebuilt.
 */
export type Located = Pick<Finding, 'file' | 'range'>

/** True when the range carries no real position; see {@link location}. */
function isFileLevel(finding: Located): boolean {
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
