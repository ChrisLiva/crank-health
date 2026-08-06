import { SEVERITY_WEIGHTS } from '../core/grade.ts'
import type { Category, Finding, Grade } from '../core/types.ts'
import { CATEGORIES, categoryRank } from '../core/types.ts'
import {
  ADVISORY_TAG,
  CATEGORY_LABELS,
  TOUCHED_TAG,
  location,
  plural,
  projectLabel,
  stateLabel,
} from './display.ts'
import type { Report, ReportDelta, ReportProject } from './json.ts'

/**
 * `agent.md` — the task list a coding agent works from (spec §10).
 *
 * The contract this file keeps, and the tests that hold it to it:
 *
 * - **Themed, not per-finding.** Fourteen unused exports are one task with a
 *   file list, because "remove this export" fourteen times is fourteen chances
 *   to stop after the first.
 * - **Deterministic priority.** Tasks come out in the fixed category order of
 *   spec §10 (security → types → dead code → complexity → duplication → lint →
 *   format), which is {@link CATEGORIES}. A category's grade cannot reorder that
 *   list — it is fixed by the spec — so "worst first" applies inside a category:
 *   the theme with the most severe findings, then the largest, comes first.
 * - **Capped.** Twenty tasks, then a pointer to `report.json` for the rest. An
 *   agent that reads a hundred tasks does none of them.
 * - **Verifiable.** Every task carries a real crank-health invocation, which
 *   the tests parse with crank-health's own argument parser.
 *
 * {@link buildAgentTasks} is the contract in structured form; the renderer only
 * spells those tasks out, so the tests assert on tasks rather than on prose.
 */

/** Spec §10: "capped at ~20 tasks". */
export const MAX_TASKS = 20

/** Above this many findings a task lists the files rather than the findings. */
const INLINE_FINDING_LIMIT = 8

/** Files listed before a task defers to `report.json`. */
const FILE_LIST_LIMIT = 15

/**
 * The grade every task is working toward. Fixing a category completely reaches
 * A under every formula shape in spec §3, so this is the target and the
 * `--fail-under` threshold in one.
 */
const TARGET_GRADE: Grade = 'A'

export interface AgentTask {
  /** Stable within one report: `T1`, `T2`, … in the order tasks are emitted. */
  readonly id: string
  readonly category: Category
  /**
   * The project this task's work is in, `.` at the repo root. A theme never
   * spans two projects: the same rule broken in two packages is two sittings,
   * under two configs, and an agent has to be told which package it is in.
   *
   * Absent for findings no project claims — an infra file under a workspace
   * shell — where naming one would send the agent to the wrong package.
   */
  readonly project?: string
  /**
   * PR mode only: at least one of this task's findings sits on a line the
   * change touched (spec §4's directly-actionable). Always `false` for a
   * whole-repo report, where nothing is more "in the diff" than anything else.
   */
  readonly directlyActionable: boolean
  /** Imperative, and counted: "Remove 14 unused exports". */
  readonly title: string
  /**
   * Spec §10's `security · F → A`: the category's grade now, and the grade the
   * category reaches once *every* task in it is done. Deliberately not "the
   * grade after this one task" — that would mean re-running the formula against
   * a hypothetical finding set, and the spec asks for the category-level claim.
   */
  readonly gradeImpact: string
  /** The findings this task covers, in report order. */
  readonly findings: readonly Finding[]
  /** Run-directory-relative raw evidence from the tools that reported them. */
  readonly evidence: readonly string[]
  /** Argv tail of the Verify command — a real, parseable invocation. */
  readonly verify: readonly string[]
}

export interface AgentMarkdownOptions {
  /** Defaults to {@link MAX_TASKS}. */
  readonly maxTasks?: number | undefined
  /**
   * PR-mode delta (spec §4): tasks come from the new findings only, and the
   * resolved ones are noted at the bottom as context. A `--pr` report carries
   * its own delta, so this is an override for callers that render one the
   * report does not have.
   */
  readonly delta?: ReportDelta | undefined
}

/** Resolved findings listed at the bottom before the rest is left to the JSON. */
const RESOLVED_LIMIT = 15

/** Renders the whole file, trailing newline included. */
export function renderAgentMarkdown(report: Report, options: AgentMarkdownOptions = {}): string {
  const limit = options.maxTasks ?? MAX_TASKS
  const delta = options.delta ?? report.delta
  const all = buildAgentTasks(report, delta)
  const tasks = all.slice(0, limit)

  const blocks: string[] = [
    '# Fix plan',
    subtitle(report, delta),
    gradesLine(report),
    ...gradingProvenance(report),
    ...(delta === undefined ? [] : [deltaLine(delta)]),
    delta === undefined ? GROUND_RULES : `${GROUND_RULES}\n${PR_GROUND_RULES}`,
    '## Tasks',
    ...(tasks.length === 0
      ? [delta === undefined ? NOTHING_TO_DO : NOTHING_NEW]
      : tasks.map((task) => renderTask(task, report.projects.length > 1))),
    ...resolvedSection(delta),
    footer(report, all.length, tasks.length),
  ]
  return `${blocks.join('\n\n')}\n`
}

/**
 * The task list, in emission order, with ids already assigned.
 *
 * **Whole-repo:** only categories graded worse than A produce tasks — a
 * category nothing could assess has nothing to fix, and a category at A is
 * done. Advisory findings are carried inside their theme rather than dropped:
 * duplication and complexity grade on a measured percentage, so their findings
 * are all advisory and excluding them would leave an F with no task under it.
 *
 * **PR mode:** the source is the delta's new findings, and the grade filter is
 * dropped — a category can be graded A and still have a regression this change
 * introduced, and that regression is the whole reason for the run. Nothing that
 * was already there becomes a task; it is not this change's to fix.
 *
 * Ordering is spec §10's fixed category priority first, always. Within a
 * category, PR mode puts the themes that touch changed lines ahead of the
 * non-local ones, and then both fall back to the whole-repo rule: heaviest
 * findings, then most findings, then theme key.
 */
export function buildAgentTasks(report: Report, delta?: ReportDelta | undefined): AgentTask[] {
  const source = delta ?? report.delta
  const rawByTool = new Map(report.tools.map((tool) => [tool.tool, tool.raw]))
  const findings: readonly Finding[] = source === undefined ? report.findings : source.newFindings
  const touched = new Set(
    source === undefined
      ? []
      : source.newFindings.filter((finding) => finding.touchedLine).map((finding) => finding.id),
  )

  const ordered = CATEGORIES.flatMap((category) =>
    themesOf(
      category,
      findings.filter((finding) => finding.category === category),
    ),
  ).filter((theme) => source !== undefined || needsWork(report, theme))

  return ordered
    .toSorted(
      (a, b) =>
        categoryRank(a.category) - categoryRank(b.category) ||
        Number(isDirect(b, touched)) - Number(isDirect(a, touched)) ||
        severityWeight(b.findings) - severityWeight(a.findings) ||
        b.findings.length - a.findings.length ||
        compare(a.key, b.key) ||
        compare(a.project ?? '', b.project ?? ''),
    )
    .map((theme, index) => toTask(theme, index + 1, report, rawByTool, touched))
}

/**
 * Whether a theme is work: its category is graded worse than A **in its own
 * project**, or in the rollup.
 *
 * Both, because `--fail-under` gates both. A package graded F inside a repo the
 * rollup grades A is CI red with nothing in this file to do about it — the
 * failure this rule exists for — and a rollup dragged below A by findings spread
 * thinly over packages that each grade A is the same failure from the other end.
 * A single-project repo has only the rollup, and reads exactly as it always has.
 */
function needsWork(report: Report, theme: Theme): boolean {
  const own = namedProject(report, theme.project)?.categories[theme.category]
  return [report.categories[theme.category], own].some(
    (state) => state?.status === 'graded' && state.grade !== TARGET_GRADE,
  )
}

/**
 * The project a task names, when the report has projects to tell apart and this
 * is one of them. A single-project report answers about the whole repo and says
 * so in its header, so nothing there is named, scoped or graded per project —
 * which is what keeps its output byte-identical to the one-project era.
 */
function namedProject(report: Report, path: string | undefined): ReportProject | undefined {
  if (path === undefined || report.projects.length < 2) return undefined
  return report.projects.find((project) => project.path === path)
}

/** The same project, only when it holds a grade of its own in this category. */
function gradedProject(report: Report, theme: Theme): ReportProject | undefined {
  const named = namedProject(report, theme.project)
  return named?.categories[theme.category].status === 'graded' ? named : undefined
}

/**
 * Whether `--project` would make this category's check about this project alone.
 *
 * It would not, where a tool answers the category **only** across the repo: a
 * secrets scan spans the whole tree under `--project` too — it must, or a scoped
 * run would miss the secret — so its findings from elsewhere are in the rollup
 * the gate also reads, and a scoped command could stay red however completely
 * this package was fixed. A check the work cannot satisfy is worse than the
 * repo-wide one.
 *
 * A tool that ran repo-wide *and* per project is the other kind: the whole-repo
 * pass is the rollup's extra measurement of what lies between projects (jscpd),
 * and scoping to one project leaves only that project's own pass — which is
 * exactly what the task is about.
 */
function scopable(report: Report, category: Category): boolean {
  return report.tools
    .filter((tool) => tool.repoWide === true && tool.category === category)
    .every((spanning) =>
      report.tools.some((tool) => tool.tool === spanning.tool && tool.repoWide !== true),
    )
}

function isDirect(theme: Theme, touched: ReadonlySet<string>): boolean {
  return theme.findings.some((finding) => touched.has(finding.id))
}

function toTask(
  theme: Theme,
  ordinal: number,
  report: Report,
  rawByTool: ReadonlyMap<string, readonly string[]>,
  touched: ReadonlySet<string>,
): AgentTask {
  // The grade a task is about is its project's, where the project has one of its
  // own: a package's F is what its agent has to move, and the rollup's letter
  // next to `Project: packages/api` would be a grade nobody can act on. Where
  // the project's own state is `not-assessed(repo-scoped)` the answer really is
  // the repo's, so the rollup's grade — and a repo-wide check — is the honest one.
  const graded = gradedProject(report, theme)
  const state = (graded?.categories ?? report.categories)[theme.category]
  const current = state.status === 'graded' ? state.grade : stateLabel(state)
  const evidence = [
    ...new Set(theme.findings.flatMap((finding) => rawByTool.get(finding.tool) ?? [])),
  ].toSorted(compare)
  return {
    id: `T${ordinal}`,
    category: theme.category,
    ...(theme.project === undefined ? {} : { project: theme.project }),
    directlyActionable: isDirect(theme, touched),
    title: theme.title,
    gradeImpact: `${CATEGORY_LABELS[theme.category]} · ${current} → ${TARGET_GRADE}`,
    findings: theme.findings,
    evidence,
    verify: verifyArgv(theme.category, scopable(report, theme.category) ? graded?.path : undefined),
  }
}

/**
 * The Verify command's argv tail. Test quality only exists in the deep profile
 * (spec §5) — a quick run reports it `not assessed`, and `--fail-under A`
 * counts a not-assessed category as a failure, so the command without `--deep`
 * could never pass however well the agent did its work.
 *
 * @param project the task's project, when it names one: the check has to be able
 * to pass on the work the task asked for, and a repo-wide `--fail-under A` would
 * fail on the next package over.
 */
function verifyArgv(category: Category, project?: string): string[] {
  const argv = [
    '--only',
    category,
    ...(project === undefined ? [] : ['--project', project]),
    '--fail-under',
    TARGET_GRADE,
  ]
  return category === 'test-quality' ? [...argv, '--deep'] : argv
}

/* ------------------------------------------------------------------ themes */

interface Theme {
  readonly category: Category
  /** The project every finding in it belongs to; see {@link AgentTask.project}. */
  readonly project: string | undefined
  /** Stable tiebreaker, and the reason two findings ended up together. */
  readonly key: string
  readonly title: string
  readonly findings: readonly Finding[]
}

/**
 * Groups one category's findings into themes. Each category groups by the thing
 * that makes two of its findings the same piece of work: a rule, a kind of dead
 * code, or — where the whole category is one mechanical sweep — nothing at all.
 * Always within one project: in a single-project repo that is every finding, so
 * the grouping is the one it has always been, and the findings no project claims
 * group together as their own unnamed theme.
 */
function themesOf(category: Category, findings: readonly Finding[]): Theme[] {
  const groups = new Map<
    string,
    { project: string | undefined; key: string; findings: Finding[] }
  >()
  for (const finding of findings) {
    const project = finding.project
    const key = themeKey(finding)
    // Keyed on both, so no project path can be read as part of a theme key.
    const id = JSON.stringify([project, key])
    const group = groups.get(id)
    if (group === undefined) groups.set(id, { project, key, findings: [finding] })
    else group.findings.push(finding)
  }
  return [...groups.values()].map((group) => ({
    category,
    project: group.project,
    key: group.key,
    title: themeTitle(category, group.key, group.findings),
    findings: group.findings,
  }))
}

function themeKey(finding: Finding): string {
  switch (finding.category) {
    // One task per scanner rule: a `shell=True` and an unpinned action are not
    // the same piece of work even though both are security.
    case 'security':
      return `${finding.tool} ${finding.rule}`
    case 'dead-code':
      return deadCodeKind(finding.rule)
    // Per file: strengthening the tests for one module is one sitting, and the
    // surviving mutants in it are the checklist for that sitting. Grouping by
    // mutator instead would spread one module's gaps over a dozen tasks.
    case 'test-quality':
      return finding.file
    // One mechanical sweep each; the findings are the list of places.
    case 'complexity':
    case 'duplication':
    case 'format':
      return finding.category
    default:
      return finding.rule
  }
}

function themeTitle(category: Category, key: string, findings: readonly Finding[]): string {
  const count = findings.length
  const rule = findings[0]?.rule ?? key
  switch (category) {
    case 'security':
      return `Fix ${plural(count, `\`${rule}\` finding`)} reported by ${findings[0]?.tool ?? key}`
    case 'types':
      return `Fix ${plural(count, `\`${rule}\` type error`)}`
    case 'dead-code':
      return `Remove ${plural(count, key.replaceAll('-', ' '))}`
    case 'complexity':
      return `Reduce the complexity of ${plural(count, 'function')}`
    case 'duplication':
      return `De-duplicate ${plural(count, 'copied block')}`
    case 'format':
      return `Format ${plural(fileCount(findings), 'file')}`
    case 'test-quality':
      return `Strengthen the tests covering \`${key}\` (${plural(count, 'mutation finding')})`
    default:
      return `Fix ${plural(count, `\`${rule}\` finding`)}`
  }
}

/**
 * The kind of dead code, independent of which tool said so — fallow's
 * `fallow/unused-export` and knip's `knip/unused-exports` are one task, not two.
 */
function deadCodeKind(rule: string): string {
  const kind = rule.includes('/') ? (rule.split('/').at(-1) ?? rule) : rule
  if (kind.endsWith('ies')) return `${kind.slice(0, -3)}y`
  if (kind.endsWith('s') && !kind.endsWith('ss')) return kind.slice(0, -1)
  return kind
}

/* --------------------------------------------------------------- rendering */

function subtitle(report: Report, delta: ReportDelta | undefined): string {
  const commit = report.repo.commit ?? 'no commits yet'
  const mode =
    delta === undefined
      ? ''
      : ` · PR vs \`${delta.baseRef}\` (merge-base \`${delta.mergeBase.slice(0, 8)}\`)`
  return `\`${report.repo.path}\` @ \`${commit}\` · crank-health ${report.crankHealth} · ${report.profile} profile${mode}`
}

function deltaLine(delta: ReportDelta): string {
  return (
    `This change: ${plural(delta.counts.new, 'new finding')} ` +
    `(${delta.counts.touchedLine} on lines it touched), ` +
    `${delta.counts.resolved} resolved, ${delta.counts.unchanged} unchanged.`
  )
}

/**
 * The resolved findings, as context and nothing more (spec §10: "PR mode: new
 * findings only; resolved noted at bottom as context"). They are below the
 * tasks and carry no task id, because there is nothing here to do.
 */
function resolvedSection(delta: ReportDelta | undefined): string[] {
  if (delta === undefined || delta.resolvedFindings.length === 0) return []
  const shown = delta.resolvedFindings.slice(0, RESOLVED_LIMIT)
  const lines = shown.map(
    (finding) => `- \`${location(finding)}\` \`${finding.rule}\` — ${finding.message}`,
  )
  if (delta.resolvedFindings.length > shown.length) {
    lines.push(`- … ${delta.resolvedFindings.length - shown.length} more in \`report.json\`.`)
  }
  return [
    `## Resolved by this change (${delta.resolvedFindings.length})`,
    `Context only — nothing to do here.${removedProjectNote(delta)}`,
    lines.join('\n'),
  ]
}

/**
 * Why some of those findings are "resolved": their project is gone. Deleting a
 * package resolves every finding in it, and an agent reading this list without
 * that sentence would take the deletion for the work.
 */
function removedProjectNote(delta: ReportDelta): string {
  const removed = delta.projects.filter((project) => project.churn === 'removed')
  if (removed.length === 0) return ''
  const paths = removed.map((project) => `\`${projectLabel(project.path)}\``).join(', ')
  return ` ${plural(removed.length, 'project')} (${paths}) ${removed.length === 1 ? 'was' : 'were'} removed by this change: findings in ${removed.length === 1 ? 'it' : 'them'} count as resolved because the code is gone, not because it was fixed.`
}

/**
 * Why the grades above are the grades above, where the run had to explain
 * itself: the standby oxlint that graded lint because the repo's own ESLint
 * could not, a language whose detection failed. An agent working from a grade
 * that did not come from the tool the repo chose is owed that fact before it
 * starts fixing findings against a config the repo never wrote.
 *
 * The warnings are the run's own fixed sentences ({@link Report.warnings},
 * already sorted), quoted verbatim — nothing is composed here. A run with
 * nothing to explain renders no block at all.
 */
function gradingProvenance(report: Report): string[] {
  if (report.warnings.length === 0) return []
  return [report.warnings.map((warning) => `> How this run was graded: ${warning}`).join('\n')]
}

function gradesLine(report: Report): string {
  const grades = CATEGORIES.map(
    (category) => `${CATEGORY_LABELS[category]} ${stateLabel(report.categories[category])}`,
  )
  return `Grades: ${grades.join(' · ')}`
}

const GROUND_RULES = `## Ground rules

- Findings marked ${ADVISORY_TAG} did not count toward the grade. Fix one only when the fix is obvious and behaviour-preserving.
- Change only what a task asks for. No wholesale reformatting, renaming or restructuring — a sweep hides the fix inside it.
- Suppressing a finding (disable comment, \`any\`, ignore entry) is not fixing it. If a rule is wrong for this repo, change the repo’s config and say so.
- Verify before you call a task done: run its Verify command and read the grade it prints.
- A task’s grade impact is its whole category: \`security · F → A\` means security reaches A once every security task is done, not this one alone.`

const PR_GROUND_RULES = `- This is a PR delta: the tasks below are what *this change* introduced. Findings that were already there are not yours to fix here.
- Findings marked ${TOUCHED_TAG} are on lines this change touched — fix those first. A new finding without the marker was caused from elsewhere in the change; it is still a regression.`

const NOTHING_TO_DO =
  'No tasks: every assessed category is graded A. Categories nothing could assess are listed above with the reason.'

const NOTHING_NEW = 'No tasks: this change introduced no new findings.'

/**
 * One task. In a monorepo the task names the project it is in: two packages can
 * break the same rule under two configs, and an agent that is not told which
 * package it is working in has to guess from the file paths.
 *
 * A single-project repo has one answer and states it in the header already, so
 * `named` is false there and the task reads exactly as it always has. So does a
 * task whose findings belong to no project: the files are in the list under it,
 * and a package name it does not live in would be worse than none.
 */
function renderTask(task: AgentTask, named: boolean): string {
  const project = named ? task.project : undefined
  const lines = [
    `### ${task.id} — ${task.title}${task.directlyActionable ? ` ${TOUCHED_TAG}` : ''}`,
    '',
    ...(project === undefined ? [] : [`Project: ${projectLabel(project)}`, '']),
    `Grade impact: ${task.gradeImpact}`,
    '',
    ...findingBlock(task.findings),
  ]
  if (task.evidence.length > 0) {
    lines.push('', `Evidence: ${task.evidence.map((path) => `[${path}](${path})`).join(' · ')}`)
  }
  lines.push('', `Verify: \`npx crank-health ${task.verify.join(' ')}\``)
  return lines.join('\n')
}

/** Findings inline while the list is short enough to act on; files after that. */
function findingBlock(findings: readonly Finding[]): string[] {
  if (findings.length <= INLINE_FINDING_LIMIT) {
    return findings.map((finding) => {
      const advisory = finding.gradeScope ? '' : ` ${ADVISORY_TAG}`
      const touched =
        'touchedLine' in finding && finding.touchedLine === true ? ` ${TOUCHED_TAG}` : ''
      return `- \`${location(finding)}\` \`${finding.rule}\` — ${finding.message}${advisory}${touched}`
    })
  }
  const counts = new Map<string, number>()
  for (const finding of findings) counts.set(finding.file, (counts.get(finding.file) ?? 0) + 1)
  const files = [...counts].toSorted(([a], [b]) => compare(a, b))
  const lines = files
    .slice(0, FILE_LIST_LIMIT)
    .map(([file, count]) => `- \`${file}\` (${plural(count, 'finding')})`)
  if (files.length > FILE_LIST_LIMIT) {
    lines.push(`- … ${files.length - FILE_LIST_LIMIT} more files in \`report.json\`.`)
  }
  return [`${plural(findings.length, 'finding')} across ${plural(files.length, 'file')}:`, ...lines]
}

function footer(report: Report, total: number, shown: number): string {
  const omitted =
    total > shown ? `${total - shown} more tasks were cut to keep this list actionable. ` : ''
  return `---\n\n${omitted}Full findings (${report.findings.length}) and every tool’s state: [report.json](report.json). Raw tool output: [raw/](raw/).`
}

/* ------------------------------------------------------------- primitives */

/** Worst-first ordering key: the total severity weight a theme carries. */
function severityWeight(findings: readonly Finding[]): number {
  return findings.reduce(
    (total, finding) => total + (finding.gradeScope ? SEVERITY_WEIGHTS[finding.severity] : 0),
    0,
  )
}

function fileCount(findings: readonly Finding[]): number {
  return new Set(findings.map((finding) => finding.file)).size
}

function compare(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
