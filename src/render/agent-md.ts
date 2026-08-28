import {
  SEVERITY_WEIGHTS,
  compareGrades,
  failingFilePercent,
  gradeAbsolute,
  gradeDensity,
  gradeRank,
  gradeRatio,
} from '../core/grade.ts'
import type { Category, CategoryState, Finding, Grade } from '../core/types.ts'
import { CATEGORIES, categoryRank } from '../core/types.ts'
import {
  ADVISORY_TAG,
  CATEGORY_LABELS,
  TOUCHED_TAG,
  location,
  manifestFiles,
  plural,
  projectLabel,
  stateLabel,
} from './display.ts'
import type { Report, ReportDelta, ReportGradeBasis, ReportProject } from './json.ts'
import { reportFindings, withGradeScope } from './json.ts'

/**
 * `agent.md` — the task list a coding agent works from (spec §10).
 *
 * The contract this file keeps, and the tests that hold it to it:
 *
 * - **Themed, not per-finding.** Fourteen unused exports are one task with a
 *   file list, because "remove this export" fourteen times is fourteen chances
 *   to stop after the first.
 * - **Deterministic priority.** The work that would move a letter comes first,
 *   most letters first ({@link gradeMovement}), and the fixed category order of
 *   spec §10 (security → types → dead code → complexity → duplication → lint →
 *   format, which is {@link CATEGORIES}) decides between themes that would move
 *   the same number. Inside a category "worst first" still applies: the theme
 *   with the most severe findings, then the largest, comes first.
 * - **Capped.** Twenty tasks, then a pointer to `report.json` for the rest. An
 *   agent that reads a hundred tasks does none of them. The twenty are spent
 *   worst-graded category first, a round at a time ({@link budgetTasks}), so a
 *   chatty category cannot leave the category the repo is failing at with no
 *   task under it.
 * - **Verifiable.** Every task carries a real crank-health invocation, which
 *   the tests parse with crank-health's own argument parser.
 *
 * {@link buildAgentTasks} is the contract in structured form; the renderer only
 * spells those tasks out, so the tests assert on tasks rather than on prose.
 */

/** Spec §10: "capped at ~20 tasks". */
export const MAX_TASKS = 20

/**
 * The vulnerability scanner, whose findings are themed by the lockfile they sit
 * in rather than by the rule that reported them.
 *
 * Kept equal to `OSV_SCANNER_TOOL` in `src/adapters/common/osv-scanner.ts`, and
 * a test pins the two: a renderer never imports an adapter (spec §10).
 */
const OSV_SCANNER_TOOL = 'osv-scanner'

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
  /**
   * The findings of {@link findings} that earned the task — {@link eligible}
   * resolved against this report. The title's count and the file list's count
   * are of these; every other row is carried, named advisory beside its file,
   * and left out of both numbers. A theme minted by 4 graded findings that
   * advertises the 84 rows it swept up sends an agent looking for work no grade
   * asked for.
   */
  readonly eligible: readonly Finding[]
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
  /**
   * The globs the repo's own tool configs exclude, repo-relative posix — what
   * `adapters/jsts/repo-excludes.ts` reads. A file the repo already told its own
   * tools to skip is generated, and generated code is nobody's task (see
   * {@link generated}).
   *
   * Passed in rather than read here: a renderer is a pure function of a report
   * and never opens a file. `src/run.ts` reads them once per run.
   */
  readonly excludes?: readonly string[] | undefined
}

/** Resolved findings listed at the bottom before the rest is left to the JSON. */
const RESOLVED_LIMIT = 15

/** Renders the whole file, trailing newline included. */
export function renderAgentMarkdown(report: Report, options: AgentMarkdownOptions = {}): string {
  const limit = options.maxTasks ?? MAX_TASKS
  const delta = options.delta ?? report.delta
  const all = buildAgentTasks(report, delta, options.excludes)
  const tasks = budgetTasks(all, report, limit)

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
 * **What earns a place.** Not a grade: a category at A can still hold a graded
 * finding, and fixing it is real work the old rule threw away. What decides is
 * whether the theme holds an *eligible* finding in a file somebody wrote — see
 * {@link eligible} and {@link handWritten}. Ineligible rows are still carried
 * inside a surviving theme, each with its own scope, so the advisory ones still
 * read as advisory; they just cannot mint a task on their own.
 *
 * **PR mode:** the source is the delta's new findings. Nothing that was already
 * there becomes a task; it is not this change's to fix. The eligibility rule is
 * the same one — a regression in generated code is still not the author's to
 * hand-fix.
 *
 * **Order.** Grade-movement potential first ({@link gradeMovement}): the themes
 * that would move a letter, most letters first, then the A→A work behind them.
 * Then PR mode's changed-line themes, then spec §10's fixed category priority,
 * then the heaviest findings, the most findings, and keys that make the order
 * total.
 *
 * @param excludes globs the repo's own configs exclude; see
 * {@link AgentMarkdownOptions.excludes}.
 */
export function buildAgentTasks(
  report: Report,
  delta?: ReportDelta | undefined,
  excludes?: readonly string[] | undefined,
): AgentTask[] {
  const source = delta ?? report.delta
  const evidenceOf = rawEvidence(report)
  // The schema's graded/advisory split is a reading order, not a work order: a
  // task is built from everything the scan found, and each row keeps its own
  // scope so the advisory ones still read as advisory.
  const findings: readonly Finding[] =
    source === undefined
      ? reportFindings(report)
      : source.newFindings.map((entry) => withGradeScope(entry))
  const touched = new Set(
    source === undefined
      ? []
      : source.newFindings.filter((finding) => finding.touchedLine).map((finding) => finding.id),
  )
  const written = handWritten(reportFindings(report), excludes ?? [])
  const movementOf = gradeMovement(report)
  // Report-wide, not delta-wide: `related` ids are the report's own identities,
  // and in PR mode the graded finding an advisory row answers for is often one
  // this change did not add — `run-pr.ts` links both scans' findings before the
  // delta is computed so those ids are there to resolve.
  const graded = new Set(
    reportFindings(report)
      .filter((finding) => finding.gradeScope)
      .map((finding) => finding.id),
  )
  const measured = measuredCategories(report)
  const isEligible: Eligible = (finding) => eligible(finding, graded, measured)

  const themes = mergeDuplicates(
    CATEGORIES.flatMap((category) =>
      themesOf(
        category,
        findings.filter((finding) => finding.category === category),
        isEligible,
      ),
    ).filter((theme) => isWork(theme, written, isEligible)),
    new Map(findings.map((finding, index) => [finding.id, index])),
    isEligible,
  )

  return themes
    .toSorted(
      (a, b) =>
        movementOf(b) - movementOf(a) ||
        Number(isDirect(b, touched)) - Number(isDirect(a, touched)) ||
        categoryRank(a.category) - categoryRank(b.category) ||
        severityWeight(b.findings) - severityWeight(a.findings) ||
        b.findings.length - a.findings.length ||
        compare(a.key, b.key) ||
        compare(a.project ?? '', b.project ?? ''),
    )
    .map((theme, index) => toTask(theme, index + 1, report, evidenceOf, touched, isEligible))
}

/* ------------------------------------------------------- grade movement */

/**
 * How many grade ranks a category would gain if one theme's findings were all
 * resolved — the first question the ranking asks, so that the work that can
 * move a letter comes before the work that cannot.
 *
 * **The formula is the grading table's own.** Take the category's findings, take
 * the theme's out, and re-run the same function `core/grade.ts` graded it with,
 * over the same numbers `gradeBasis` records it was divided by: the KLOC a
 * density was per, the file count a share was of, the percentage a tool
 * reported. The answer is `rank(today) - rank(then)`, in letters.
 *
 * **Whose grade, and whose findings.** A theme in a package that holds a grade
 * of its own is measured against that package: its letter, its basis, its
 * findings — the same three numbers `core/run.ts` graded it from, and the same
 * letter the task's own `Grade impact:` line prints ({@link toTask}). Measured
 * against the rollup instead, a theme in a package graded F over 0.1 KLOC scored
 * on the whole tree's KLOC and lost its place to work that cannot move a letter.
 * Where the package has no grade of its own — `not-assessed(repo-scoped)`, a
 * secrets scan only the repo could answer — the rollup is the honest reading,
 * and a single-project report has no per-project grade to read at all
 * ({@link namedProject}), so its ranking is the one it has always had.
 *
 * Two of the shapes cannot be re-run from a finding list, because their
 * numerator never was one — complexity counts functions and duplication is a
 * percentage jscpd computed. There the numerator is scaled by the share of the
 * category's findings the theme leaves behind, which is the only proportion the
 * report carries; it is an estimate, and it is stated as one here rather than
 * dressed up as arithmetic.
 *
 * **No recorded basis, no claim.** A category no arithmetic is recorded for
 * scores zero rather than a guessed denominator, so a report from before
 * `gradeBasis` existed ranks by spec §10's fixed order exactly as it always did.
 * The rule holds per project too: a package graded a letter whose basis its
 * `projects[]` entry does not carry scores zero, rather than borrowing the
 * rollup's denominator to claim a movement that package's grade never came from.
 */
function gradeMovement(report: Report): (theme: Theme) => number {
  const all = reportFindings(report)
  const cache = new Map<Theme, number>()
  return (theme) => {
    const seen = cache.get(theme)
    if (seen !== undefined) return seen
    const movement = ranksGained(report, theme, all)
    cache.set(theme, movement)
    return movement
  }
}

/**
 * Letters between the category's grade today and its grade with `theme` fixed.
 *
 * State, basis and findings are read from one place or the other, never mixed:
 * the rollup's denominator over a package's findings divides one measurement by
 * another's, and the answer would be a letter neither of them holds.
 *
 * @param all every finding in the report; narrowed here to the ones the grade
 * being measured was computed over.
 */
function ranksGained(report: Report, theme: Theme, all: readonly Finding[]): number {
  const graded = gradedProject(report, theme)
  const source = graded ?? report
  const state = source.categories[theme.category]
  // Optional on the read: `projects[].gradeBasis` is additive, so a report
  // written before it existed carries none — and a basis the report does not
  // record scores zero, never the other scope's denominator.
  const basis = source.gradeBasis?.[theme.category]
  if (state.status !== 'graded' || basis === undefined) return 0
  const scope = graded === undefined ? all : all.filter((row) => row.project === graded.path)
  const after = gradeWithout(theme, basis, scope)
  return after === undefined ? 0 : gradeRank(state.grade) - gradeRank(after)
}

/**
 * The grade the theme's category would hold with the theme's findings gone.
 *
 * @param scope the findings the grade was computed over — the project's, or the
 * whole report's; see {@link ranksGained}.
 */
function gradeWithout(
  theme: Theme,
  basis: ReportGradeBasis,
  scope: readonly Finding[],
): Grade | undefined {
  const category = theme.category
  const mine = scope.filter((finding) => finding.category === category)
  const resolved = new Set(theme.findings.map((finding) => finding.id))
  const left = mine.filter((finding) => !resolved.has(finding.id))
  // What is left of the measurement, where the measurement is not a list of
  // findings: the only proportion the report carries. `mine` is never empty —
  // the theme's own findings are in it.
  const remains = left.length / mine.length
  switch (category) {
    case 'security':
      return gradeAbsolute(category, left)
    case 'lint':
    case 'types':
    case 'dead-code':
      return basis.denominator === null
        ? undefined
        : gradeDensity(category, left, basis.denominator)
    case 'format':
      return basis.denominator === null
        ? undefined
        : gradeRatio(category, failingFilePercent(left, category, basis.denominator))
    case 'complexity':
      return basis.denominator === null || basis.denominator <= 0
        ? undefined
        : gradeRatio(category, ((basis.value * remains) / basis.denominator) * 100)
    case 'duplication':
      return gradeRatio(category, basis.value * remains)
    // Mutation score, where higher is better: every mutant this theme kills is
    // one the score no longer misses.
    case 'test-quality':
      return gradeRatio(category, basis.value + (100 - basis.value) * (1 - remains))
  }
}

/* --------------------------------------------------------- what is a task */

/**
 * Whether a finding can mint a task of its own.
 *
 * Graded ones can: they are what a letter is made of. An advisory one can only
 * when `related` links it to a **graded** finding in another category at the
 * same place — somebody has to open that file for the graded finding anyway,
 * and the advisory row is then part of the same sitting. An advisory row
 * standing alone is a default config's opinion nobody asked for, and a list of
 * those is what makes an agent stop reading the list.
 *
 * Which is why the link has to be resolved rather than counted. Two advisory
 * findings at one place — a clone and a complexity ceiling on the same function
 * — link to each other and to nothing anyone has to open that file for, so a
 * non-empty `related` was never the question.
 *
 * **And the letter itself can make an advisory row work.** Duplication grades on
 * jscpd's token percentage and complexity on a share of functions, so every one
 * of their findings is advisory — the number, not the rows, is what earned the
 * letter. A D or an F there with no graded finding under it would otherwise be a
 * grade with nothing in this list that could move it, which is the one thing
 * `agent.md` must never print. {@link measuredCategories} is that set, and it is
 * deliberately not "any bad letter": a security D is made *of* graded findings,
 * so its advisory dependency rows are still the noise the plan suppresses.
 *
 * @param graded ids of every finding in this report that counted toward a grade
 * @param measured categories whose letter is a measurement no graded finding is
 * under; see {@link measuredCategories}
 */
function eligible(
  finding: Finding,
  graded: ReadonlySet<string>,
  measured: ReadonlySet<Category>,
): boolean {
  if (finding.gradeScope || measured.has(finding.category)) return true
  return (finding.related ?? []).some((id) => graded.has(id))
}

/**
 * {@link eligible} with one report's sets closed over: built once in
 * {@link buildAgentTasks} and handed to everything that has to draw the same
 * line, so which findings count is answered in one place rather than three.
 */
type Eligible = (finding: Finding) => boolean

/**
 * The categories graded worse than A on a number a tool reported rather than on
 * findings that counted: `metrics` holds that number (jscpd's duplicated-token
 * percentage, fallow's functions over the ceiling, Stryker's mutation score),
 * and no finding of theirs is in `findings[]`.
 *
 * Both halves matter. Without the letter, a clean A's advisory rows would come
 * back as tasks — the noise {@link eligible} exists to keep out. Without "no
 * graded finding", a category whose letter its own graded rows earned would
 * drag its advisory ones in behind them.
 *
 * The rollup and every project, because `--fail-under` gates both: a package
 * graded F inside a repo the rollup grades A is CI red with nothing in this file
 * to do about it.
 */
function measuredCategories(report: Report): Set<Category> {
  const gradedIn = new Set(
    reportFindings(report)
      .filter((finding) => finding.gradeScope)
      .map((finding) => finding.category),
  )
  const states = [report.categories, ...report.projects.map((project) => project.categories)]
  return new Set(
    CATEGORIES.filter(
      (category) =>
        Object.keys(report.metrics[category] ?? {}).length > 0 &&
        !gradedIn.has(category) &&
        states.some((state) => gradedWorseThanA(state[category])),
    ),
  )
}

/** Whether one category state is a letter, and a letter below A. */
function gradedWorseThanA(state: CategoryState | undefined): boolean {
  return state?.status === 'graded' && state.grade !== 'A'
}

/**
 * Whether a theme is work: an eligible finding of its lands in a file somebody
 * wrote.
 *
 * Dependency themes are the exception. Their file is a manifest by
 * construction — that is where a pinned version lives — so the hand-written
 * question cannot decide them, and what does is whether there is a released
 * version to upgrade to. "Upgrade lodash" with no fixed version is not a task;
 * it is a fact, and `report.json` already records it.
 */
function isWork(
  theme: Theme,
  written: (finding: Finding) => boolean,
  isEligible: Eligible,
): boolean {
  const rows = theme.findings.filter(isEligible)
  if (rows.length === 0) return false
  if (rows.every((finding) => finding.package !== undefined)) return rows.some(hasFix)
  return rows.some((finding) => written(finding))
}

/**
 * Two themes in different categories reporting *the same places* are one piece
 * of work, and `related` is the report's own record of which places those are
 * (`core/fingerprint.ts`: same file, overlapping lines, another category).
 *
 * Mutual and total, or not at all: every finding on each side has to answer for
 * a finding on the other. A theme spread over ten places that meets another at
 * one of them is not its duplicate, and absorbing it would hide the other nine
 * inside a task about something else. Same project, too — one rule broken in two
 * packages is two sittings under two configs however the lines line up.
 *
 * The survivor is the theme whose category spec §10 ranks first, which is a
 * property of the two categories rather than of the ranking this feeds, so the
 * merge cannot move with it. It keeps its own Verify command — one command can
 * only check one category — and its title says what came with it, because a task
 * listing rows its heading does not account for reads like a rendering bug.
 */
function mergeDuplicates(
  themes: readonly Theme[],
  order: ReadonlyMap<string, number>,
  isEligible: Eligible,
): readonly Theme[] {
  const canonical = themes.toSorted(
    (a, b) =>
      categoryRank(a.category) - categoryRank(b.category) ||
      compare(a.key, b.key) ||
      compare(a.project ?? '', b.project ?? ''),
  )
  const absorbed = new Set<Theme>()
  const grown = new Map<Theme, Theme[]>()
  for (const [index, winner] of canonical.entries()) {
    if (absorbed.has(winner)) continue
    for (const other of canonical.slice(index + 1)) {
      if (absorbed.has(other) || !duplicates(winner, other)) continue
      absorbed.add(other)
      grown.set(winner, [...(grown.get(winner) ?? []), other])
    }
  }
  return themes
    .filter((theme) => !absorbed.has(theme))
    .map((theme) => {
      const merged = grown.get(theme)
      if (merged === undefined) return theme
      return {
        ...theme,
        title: `${theme.title}, and ${alsoHere(merged, isEligible)} at the same place`,
        // Back into the report's own order, so a merged task reads like every
        // other one and two runs cannot disagree about the list.
        findings: [theme, ...merged]
          .flatMap((one) => one.findings)
          .toSorted(
            (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0) || compare(a.id, b.id),
          ),
      }
    })
}

/**
 * `1 finding in lint` / `1 finding in lint and 2 findings in types` — what a
 * merge added. The category goes after the noun because {@link CATEGORY_LABELS}
 * is not always a singular adjective ("types", "dead code"), and one spelling of
 * a category name across the renderers is worth more than a smoother sentence.
 *
 * Eligible rows only, the same count the heading it is appended to makes: a
 * suffix that counted every row would restate, one clause later, the number
 * {@link themeTitle} stopped printing. It cannot reach zero — an absorbed theme
 * passed {@link isWork}, so it brought at least one eligible row with it.
 */
function alsoHere(merged: readonly Theme[], isEligible: Eligible): string {
  const counts = merged.map(
    (theme) =>
      `${plural(theme.findings.filter(isEligible).length, 'finding')} in ${CATEGORY_LABELS[theme.category]}`,
  )
  const last = counts.at(-1) ?? ''
  return counts.length < 2 ? last : `${counts.slice(0, -1).join(', ')} and ${last}`
}

/** Whether two themes are the same places seen from two categories. */
function duplicates(one: Theme, other: Theme): boolean {
  return (
    one.category !== other.category &&
    one.project === other.project &&
    answersFor(one, other) &&
    answersFor(other, one)
  )
}

/** Whether every finding of `one` is cross-linked to a finding of `other`. */
function answersFor(one: Theme, other: Theme): boolean {
  const ids = new Set(other.findings.map((finding) => finding.id))
  return one.findings.every((finding) =>
    (finding.related ?? []).some((related) => ids.has(related)),
  )
}

/** Whether some advisory against this dependency names a version that fixes it. */
function hasFix(finding: Finding): boolean {
  return (finding.packageAdvisories ?? []).some((advisory) => advisory.fixedIn !== undefined)
}

/** Path segment naming a directory of generated code; see {@link handWritten}. */
const GENERATED_DIR = 'gen'

/** `schema.gen.ts` — the other half of the convention {@link GENERATED_DIR} names. */
const GENERATED_NAME = /^.+\.gen\..+$/

/**
 * Whether a finding is in a file a person wrote — the only kind a task can ask
 * an agent to edit.
 *
 * Three things it is not. A **manifest**, read off the scan's own dependency
 * findings ({@link manifestFiles}): a lint row in a lockfile is not hand-written
 * source, whoever reported it. **Generated** by convention: a `gen/` path
 * segment, or a `*.gen.*` name. And generated by the repo's own account: a file
 * matching a glob the repo told Biome or fallow to skip
 * ({@link AgentMarkdownOptions.excludes}).
 *
 * Every rule can only ever *remove* a task, so each one fails safe in the same
 * direction: a glob {@link globMatcher} cannot translate matches nothing, and
 * the finding stays a task rather than disappearing into a claim nobody checked.
 */
function handWritten(
  all: readonly Finding[],
  excludes: readonly string[],
): (finding: Finding) => boolean {
  const manifests = manifestFiles(all)
  const matchers = excludes.flatMap((pattern) => globMatcher(pattern) ?? [])
  return (finding) => !manifests.has(finding.file) && !generated(finding.file, matchers)
}

function generated(file: string, matchers: readonly RegExp[]): boolean {
  const segments = file.split('/')
  if (segments.includes(GENERATED_DIR)) return true
  if (GENERATED_NAME.test(segments.at(-1) ?? file)) return true
  return matchers.some((matcher) => matcher.test(file))
}

/** Glob syntax this translation refuses to guess at; see {@link globMatcher}. */
const UNTRANSLATABLE = /[?[\]{}!\\()+@|^$]/

/**
 * A repo-relative posix glob as a regular expression, or `undefined` for one
 * this cannot carry over faithfully.
 *
 * Three shapes, which is what `readRepoExcludes` emits: literal segments, `*`
 * inside a segment (anything but a separator), and `**` for any run of
 * segments. Character classes, brace groups, extglobs and negations are not
 * translated at all — an approximation here would hide a finding in a file the
 * repo never excluded, and a task that survives a pattern nobody could read is
 * the harmless half of that choice.
 */
function globMatcher(pattern: string): RegExp | undefined {
  if (pattern.length === 0 || UNTRANSLATABLE.test(pattern)) return undefined
  const segments = pattern.split('/')
  if (segments.some((segment) => segment === '..' || segment === '.' || segment === '')) {
    return undefined
  }
  const body = segments
    .map((segment, index) => {
      const last = index === segments.length - 1
      if (segment === '**') return last ? '.*' : '(?:[^/]+/)*'
      return `${segment.replaceAll('*', '\u0000').replaceAll('.', '\\.').replaceAll('\u0000', '[^/]*')}${last ? '' : '/'}`
    })
    .join('')
  return new RegExp(`^${body}$`)
}

/**
 * Spec §10's cap, spent as a round robin over the categories that produced
 * tasks: every one of them contributes a task before any contributes a second.
 *
 * Truncating the emission order instead spends the whole budget on whatever
 * category the fixed order reaches first, so a repo failing a category further
 * down gets a plan with nothing about that category in it — the one thing the
 * grades told it to fix.
 *
 * The rounds go worst-graded category first, read off the rollup state: graded
 * categories worst-first, then the ones carrying no grade at all — nothing
 * could assess them, or their tool errored — since there is no letter to rank
 * those by. {@link categoryRank} breaks every tie in both groups, so the cut is
 * a total order rather than an insertion order.
 *
 * What comes back is in emission order — the budget decides *which* tasks
 * survive, never the order they are read in — renumbered `T1…Tn`, because the
 * function that makes the cut is the one that owns the gap it would leave.
 */
function budgetTasks(tasks: readonly AgentTask[], report: Report, limit: number): AgentTask[] {
  const byCategory = new Map<Category, AgentTask[]>()
  for (const task of tasks) {
    const queue = byCategory.get(task.category)
    if (queue === undefined) byCategory.set(task.category, [task])
    else queue.push(task)
  }
  const roundOrder = [...byCategory.keys()].toSorted(
    (a, b) =>
      worstFirst(report.categories[a], report.categories[b]) || categoryRank(a) - categoryRank(b),
  )
  const kept = new Set<AgentTask>()
  const deepest = Math.max(0, ...[...byCategory.values()].map((queue) => queue.length))
  for (let round = 0; round < deepest && kept.size < limit; round += 1) {
    for (const category of roundOrder) {
      if (kept.size >= limit) break
      const task = byCategory.get(category)?.[round]
      if (task !== undefined) kept.add(task)
    }
  }
  return tasks
    .filter((task) => kept.has(task))
    .map((task, index) => ({ ...task, id: `T${index + 1}` }))
}

/** Round order for two categories: worse grade first, no grade at all last. */
function worstFirst(a: CategoryState, b: CategoryState): number {
  if (a.status === 'graded' && b.status === 'graded') return compareGrades(b.grade, a.grade)
  return Number(a.status !== 'graded') - Number(b.status !== 'graded')
}

/**
 * Raw evidence for a finding: the output of the runs that could have reported it.
 *
 * The tool name alone is not the key. The same tool runs once per project, so
 * keyed by name a task in one package would link the raw file of whichever
 * package happened to be recorded last — evidence for a different config over
 * different sources.
 *
 * Its project's run is not the only candidate either. A repo-spanning run of the
 * same tool covered that project's files too, and for some findings it is the
 * only run that saw them: a clone *between* two packages is in the repo-wide
 * duplication pass and in neither package's own, though it is attributed to the
 * package it sits in. So both runs are the evidence, and the reader is sent to
 * output that actually contains the finding. A finding no project claims has
 * only the repo-spanning run.
 *
 * PR mode records both sides of the comparison under the same key, and head is
 * the one that wins: the report's runs are already ordered with `head` last, and
 * the tasks are made of head's findings.
 */
function rawEvidence(report: Report): (finding: Finding) => readonly string[] {
  const byRun = new Map<string, readonly string[]>()
  for (const tool of report.tools) {
    byRun.set(evidenceKey(tool.tool, tool.repoWide === true ? undefined : tool.project), tool.raw)
  }
  return (finding) => [
    ...(byRun.get(evidenceKey(finding.tool, finding.project)) ?? []),
    ...(byRun.get(evidenceKey(finding.tool, undefined)) ?? []),
  ]
}

/** A run's identity for {@link rawEvidence}: repo-spanning runs have no project. */
function evidenceKey(tool: string, project: string | undefined): string {
  return JSON.stringify([project ?? null, tool])
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
  evidenceOf: (finding: Finding) => readonly string[],
  touched: ReadonlySet<string>,
  isEligible: Eligible,
): AgentTask {
  // The grade a task is about is its project's, where the project has one of its
  // own: a package's F is what its agent has to move, and the rollup's letter
  // next to `Project: packages/api` would be a grade nobody can act on. Where
  // the project's own state is `not-assessed(repo-scoped)` the answer really is
  // the repo's, so the rollup's grade — and a repo-wide check — is the honest one.
  const graded = gradedProject(report, theme)
  const state = (graded?.categories ?? report.categories)[theme.category]
  const current = state.status === 'graded' ? state.grade : stateLabel(state)
  const evidence = [...new Set(theme.findings.flatMap((finding) => evidenceOf(finding)))].toSorted(
    compare,
  )
  return {
    id: `T${ordinal}`,
    category: theme.category,
    ...(theme.project === undefined ? {} : { project: theme.project }),
    directlyActionable: isDirect(theme, touched),
    title: theme.title,
    gradeImpact: `${CATEGORY_LABELS[theme.category]} · ${current} → ${TARGET_GRADE}`,
    findings: theme.findings,
    eligible: theme.findings.filter(isEligible),
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
function themesOf(category: Category, findings: readonly Finding[], isEligible: Eligible): Theme[] {
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
    title: themeTitle(category, group.key, group.findings, isEligible),
    findings: group.findings,
  }))
}

function themeKey(finding: Finding): string {
  switch (finding.category) {
    // One task per scanner rule: a `shell=True` and an unpinned action are not
    // the same piece of work even though both are security. The exception is the
    // vulnerability scanner, whose rule is an advisory id: every CVE in one
    // lockfile is fixed by upgrading that lockfile, so the file is the work and
    // twenty advisories in it are one task rather than twenty.
    case 'security':
      return finding.tool === OSV_SCANNER_TOOL
        ? `${finding.tool} ${finding.file}`
        : `${finding.tool} ${finding.rule}`
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

/**
 * The heading, counted. The number is of the theme's eligible rows, not of
 * everything it swept up: a theme carries every finding in the files it names,
 * and "Remove 26 unused files" over 4 that count is a heading an agent cannot
 * act on. {@link Eligible} draws that line — in a measured category every row
 * is eligible, so a duplication sweep still counts all of them.
 */
function themeTitle(
  category: Category,
  key: string,
  findings: readonly Finding[],
  isEligible: Eligible,
): string {
  const rows = findings.filter(isEligible)
  const count = rows.length
  const first = findings[0]
  const rule = first?.rule ?? key
  switch (category) {
    // Branched on the theme's tool rather than on its key, whose shape is the
    // thing that differs: a vulnerability theme's rules are the advisory ids of
    // one lockfile, and titling it with one of them would name a single CVE as
    // if it were the work.
    case 'security':
      return first?.tool === OSV_SCANNER_TOOL
        ? `Upgrade ${plural(count, 'vulnerable dependency', 'vulnerable dependencies')} in \`${first.file}\``
        : `Fix ${plural(count, `\`${rule}\` finding`)} reported by ${first?.tool ?? key}`
    case 'types':
      return `Fix ${plural(count, `\`${rule}\` type error`)}`
    case 'dead-code':
      return `Remove ${plural(count, key.replaceAll('-', ' '))}`
    case 'complexity':
      return `Reduce the complexity of ${plural(count, 'function')}`
    case 'duplication':
      return `De-duplicate ${plural(count, 'copied block')}`
    case 'format':
      return `Format ${plural(fileCount(rows), 'file')}`
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
  'No tasks: nothing this scan found is work in hand-written code — every finding it reported is advisory with nothing graded beside it, in generated code, or in a dependency with no released fix. All of them are in `report.json`; categories nothing could assess are listed above with the reason.'

const NOTHING_NEW = 'No tasks: this change introduced no new findings.'

/**
 * One task, whole: its heading, the grade its category would reach, the work,
 * and the command that says whether the work is done.
 *
 * Both of those lines used to be stated once per run of consecutive tasks that
 * agreed on them — six lint tasks under one `Verify:` — which saved lines by
 * making a task unreadable on its own. An agent that starts at T4 has to scroll
 * up past three headings to find out what would check it, and a task whose
 * check lives under a different heading is one an agent quietly skips.
 * Repetition is the cheaper failure.
 */
function renderTask(task: AgentTask, named: boolean): string {
  return [
    [...taskHeading(task, named), `Grade impact: ${task.gradeImpact}`, '', ...taskBody(task)].join(
      '\n',
    ),
    `Verify: \`npx crank-health ${task.verify.join(' ')}\``,
  ].join('\n\n')
}

/**
 * A task's heading, and the project it is in. In a monorepo the task names that
 * project: two packages can break the same rule under two configs, and an agent
 * that is not told which package it is working in has to guess from the file
 * paths.
 *
 * A single-project repo has one answer and states it in the header already, so
 * `named` is false there and the task reads exactly as it always has. So does a
 * task whose findings belong to no project: the files are in the list under it,
 * and a package name it does not live in would be worse than none.
 */
function taskHeading(task: AgentTask, named: boolean): string[] {
  const project = named ? task.project : undefined
  return [
    `### ${task.id} — ${task.title}${task.directlyActionable ? ` ${TOUCHED_TAG}` : ''}`,
    '',
    ...(project === undefined ? [] : [`Project: ${projectLabel(project)}`, '']),
  ]
}

/** A task's own work: the findings it covers, and the raw output behind them. */
function taskBody(task: AgentTask): string[] {
  const lines = [...findingBlock(task.findings, task.eligible)]
  if (task.evidence.length > 0) {
    lines.push('', `Evidence: ${task.evidence.map((path) => `[${path}](${path})`).join(' · ')}`)
  }
  return lines
}

/**
 * Findings inline while the list is short enough to act on; files after that.
 *
 * A task whose findings all sit in one file lists them however many there are:
 * the file list would be that one file, which the task title already names, and
 * a count in place of twenty advisory ids is a number where the work is. Either
 * way the list stops at {@link FILE_LIST_LIMIT} entries and leaves the rest to
 * `report.json`.
 *
 * Which form is chosen counts every row, because every row is what the inline
 * form would print: a theme of 4 eligible findings and 80 advisory ones is 84
 * lines, and the aggregate exists for exactly that shape. What the aggregate
 * *counts* is `eligible` — `4 findings across 4 files`, with each file's
 * advisory rows named beside its own number rather than folded into it, and the
 * files holding those 4 listed before the ones holding none.
 *
 * @param counted the subset of `findings` the counts are of; see
 * {@link AgentTask.eligible}
 */
function findingBlock(findings: readonly Finding[], counted: readonly Finding[]): string[] {
  if (findings.length <= INLINE_FINDING_LIMIT || fileCount(findings) === 1) {
    const lines = findings.slice(0, FILE_LIST_LIMIT).map((finding) => {
      const advisory = finding.gradeScope ? '' : ` ${ADVISORY_TAG}`
      const touched =
        'touchedLine' in finding && finding.touchedLine === true ? ` ${TOUCHED_TAG}` : ''
      return `- \`${location(finding)}\` \`${finding.rule}\` — ${finding.message}${advisory}${touched}`
    })
    if (findings.length > FILE_LIST_LIMIT) {
      lines.push(`- … ${findings.length - FILE_LIST_LIMIT} more findings in \`report.json\`.`)
    }
    return lines
  }
  const ids = new Set(counted.map((finding) => finding.id))
  const counts = new Map<string, { counted: number; advisory: number }>()
  for (const finding of findings) {
    const row = counts.get(finding.file) ?? { counted: 0, advisory: 0 }
    if (ids.has(finding.id)) row.counted += 1
    else row.advisory += 1
    counts.set(finding.file, row)
  }
  // Files holding the counted work first, then the advisory-only ones, each
  // group by path. The list is cut at `FILE_LIST_LIMIT`, and a path sort alone
  // lets twenty advisory files spend the whole budget and push the one file the
  // headline is counting behind the "… more files" line — a task that names a
  // number and then shows fifteen files holding none of it.
  const files = [...counts].toSorted(
    ([a, one], [b, other]) => Number(other.counted > 0) - Number(one.counted > 0) || compare(a, b),
  )
  const lines = files
    .slice(0, FILE_LIST_LIMIT)
    // "advisory" is what the row is, not a noun to pluralise, and a file with
    // none of them reads as it always has.
    .map(
      ([file, row]) =>
        `- \`${file}\` (${plural(row.counted, 'finding')}${row.advisory === 0 ? '' : `, ${row.advisory} advisory`})`,
    )
  if (files.length > FILE_LIST_LIMIT) {
    lines.push(`- … ${files.length - FILE_LIST_LIMIT} more files in \`report.json\`.`)
  }
  // The span is the counted findings' own: a file contributing nothing to the
  // number is not one of the files that number is across.
  const across = files.filter(([, row]) => row.counted > 0).length
  return [`${plural(counted.length, 'finding')} across ${plural(across, 'file')}:`, ...lines]
}

function footer(report: Report, total: number, shown: number): string {
  const omitted =
    total > shown ? `${total - shown} more tasks were cut to keep this list actionable. ` : ''
  const found = report.findings.length + report.advisories.length
  return `---\n\n${omitted}Full findings (${found}) and every tool’s state: [report.json](report.json). Raw tool output: [raw/](raw/).`
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
