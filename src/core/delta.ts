import { nearestProjectMap } from './discover.ts'
import { fingerprint } from './fingerprint.ts'
import { sortFindings } from './orchestrator.ts'
import type { Category, CategoryState, Finding } from './types.ts'
import { CATEGORIES } from './types.ts'

/**
 * The PR delta (spec §4): two scans in, one answer about what *this change*
 * did. Pure — no git, no filesystem, no clock — so the classification matrix is
 * unit-testable and the orchestration around it (`run-pr.ts`) has nothing
 * interesting left in it.
 *
 * The whole design rests on one property of the fingerprint (spec §2): identity
 * is `hash(category, tool, rule, file, anchor, occurrence)` and contains no line
 * number. Inserting lines above a finding therefore leaves its id alone, and a
 * delta between two scans is a set difference rather than a text diff. Two
 * things the set difference cannot see on its own are handled here:
 *
 * - **Renames.** The path *is* in the hash, so a moved file would read as every
 *   finding in it resolved and an identical set of new ones. Base findings are
 *   re-hashed under their head path before anything is compared.
 * - **Where the change is.** A new finding on a line this diff touched is
 *   directly actionable; one somewhere else is a non-local regression. Both are
 *   new — dropping the second would hide exactly the surprises a PR scan exists
 *   to catch — so the difference is a flag, not a filter.
 */

export interface DeltaInput {
  /** Findings from the merge-base scan, with base paths. */
  readonly baseFindings: readonly Finding[]
  /** Findings from the head scan. */
  readonly headFindings: readonly Finding[]
  /** Base path → head path, from `git diff --find-renames --name-status`. */
  readonly renames: ReadonlyMap<string, string>
  /** Head path → head line numbers the diff added or modified. */
  readonly touchedLines: ReadonlyMap<string, ReadonlySet<number>>
  /** Category states from the base scan — including its failures (see below). */
  readonly baseCategories: Readonly<Record<Category, CategoryState>>
  /** Category states from the head scan; these are the report's own grades. */
  readonly headCategories: Readonly<Record<Category, CategoryState>>
  /** The base scan's projects, graded. A project either side lacks is churn. */
  readonly baseProjects: readonly DeltaProject[]
  /** The head scan's projects, graded; these are the report's own projects. */
  readonly headProjects: readonly DeltaProject[]
}

/** One project's graded categories, from one side of the comparison. */
export interface DeltaProject {
  /** Repo-relative posix path, `.` at the root — the project's identity. */
  readonly path: string
  readonly categories: Readonly<Record<Category, CategoryState>>
}

/** A new finding, plus whether this change is what put it there. */
interface DeltaFinding {
  readonly finding: Finding
  /**
   * The finding's start line is one the diff added or modified. Spec §4's
   * "directly-actionable"; `false` means the change caused it from somewhere
   * else, which is still this change's doing.
   */
  readonly touchedLine: boolean
}

/** One category's before and after, and what moved it. */
export interface CategoryMovement {
  readonly category: Category
  /**
   * The base scan's state, failures included. A category that errored only at
   * base makes every "resolved" claim under it suspect — the findings did not
   * go away, the tool did — and a delta that hid that would be lying by
   * omission (spec §8).
   */
  readonly base: CategoryState
  readonly head: CategoryState
  readonly newFindings: number
  readonly resolvedFindings: number
}

/** Whether a project is on both sides of the comparison, or only on one. */
export type ProjectChurn = 'none' | 'added' | 'removed'

/**
 * What this change did to one project: the same eight movements as the rollup,
 * over that project's own findings and its own grades.
 *
 * A project only head has is `added` and one only the base had is `removed`.
 * The label matters as much as the counts: every finding in an added project is
 * new and every finding in a removed one is resolved, and a renderer that
 * presented the second as fixes would report deleting a package as the best
 * work in the change. The root project shuttling between a graded project and a
 * workspace shell is churn of `.` like any other.
 */
export interface ProjectMovement {
  /** Repo-relative posix path; see {@link DeltaProject.path}. */
  readonly path: string
  readonly churn: ProjectChurn
  /** All eight categories, in canonical order, on this project's grades. */
  readonly categories: readonly CategoryMovement[]
  /** New findings attributed to this project; a subset of the rollup's. */
  readonly newFindings: number
  readonly resolvedFindings: number
}

export interface DeltaResult {
  /** New findings, in report order; touched-line ones flagged, not reordered. */
  readonly newFindings: readonly DeltaFinding[]
  /** Findings the base had and head does not, in report order, at head paths. */
  readonly resolvedFindings: readonly Finding[]
  /** Findings present in both scans — not rendered, but counted. */
  readonly unchangedCount: number
  /** All eight categories, in canonical order. */
  readonly categories: readonly CategoryMovement[]
  /** The same, per project, ordered by path: every project either side had. */
  readonly projects: readonly ProjectMovement[]
}

/** Every category's base state in a project only head has: there was no before. */
export const PROJECT_ADDED_REASON = 'project added by this change'

/** Every category's head state in a project only the base had; see above. */
export const PROJECT_REMOVED_REASON = 'project removed by this change'

/** Computes the delta. See the module note for what makes it more than a diff. */
export function computeDelta(input: DeltaInput): DeltaResult {
  // Head's partition decides the attribution, because a remapped finding is the
  // base one restated at its head path — and that path may be in another project.
  const base = remapRenames(
    input.baseFindings,
    input.renames,
    nearestProjectMap(input.headProjects),
  )
  const baseIds = new Set(base.map((finding) => finding.id))
  const headIds = new Set(input.headFindings.map((finding) => finding.id))

  const added = sortFindings(input.headFindings.filter((finding) => !baseIds.has(finding.id)))
  const resolved = sortFindings(base.filter((finding) => !headIds.has(finding.id)))

  return {
    newFindings: added.map((finding) => ({
      finding,
      touchedLine: isTouched(finding, input.touchedLines),
    })),
    resolvedFindings: resolved,
    unchangedCount: [...headIds].filter((id) => baseIds.has(id)).length,
    categories: movements(input.baseCategories, input.headCategories, added, resolved),
    projects: projectMovements(input, added, resolved),
  }
}

/** One side's states next to the other's, with the counts that moved them. */
function movements(
  baseCategories: Readonly<Record<Category, CategoryState>>,
  headCategories: Readonly<Record<Category, CategoryState>>,
  added: readonly Finding[],
  resolved: readonly Finding[],
): CategoryMovement[] {
  return CATEGORIES.map((category) => ({
    category,
    base: baseCategories[category],
    head: headCategories[category],
    newFindings: added.filter((finding) => finding.category === category).length,
    resolvedFindings: resolved.filter((finding) => finding.category === category).length,
  }))
}

/**
 * The rollup's movement, restated per project over that project's own findings.
 *
 * A finding is attributed by the project it was found in on its own side, so a
 * file `git mv`-ed across a project boundary is the same finding with a new
 * attribution: unchanged in the rollup, and — because it is neither new nor
 * resolved — no churn in either project's counts either. What moves in that case
 * is the two projects' grades, which is exactly what happened.
 */
function projectMovements(
  input: DeltaInput,
  added: readonly Finding[],
  resolved: readonly Finding[],
): ProjectMovement[] {
  const base = new Map(input.baseProjects.map((project) => [project.path, project.categories]))
  const head = new Map(input.headProjects.map((project) => [project.path, project.categories]))

  return [...new Set([...base.keys(), ...head.keys()])].toSorted(compare).map((path) => {
    const before = base.get(path)
    const after = head.get(path)
    const mine = (findings: readonly Finding[]) =>
      findings.filter((finding) => finding.project === path)
    return {
      path,
      churn: before === undefined ? 'added' : after === undefined ? 'removed' : 'none',
      categories: movements(
        before ?? absent(PROJECT_ADDED_REASON),
        after ?? absent(PROJECT_REMOVED_REASON),
        mine(added),
        mine(resolved),
      ),
      newFindings: mine(added).length,
      resolvedFindings: mine(resolved).length,
    }
  })
}

/** Eight states for a side that has no such project, saying which side that is. */
function absent(reason: string): Record<Category, CategoryState> {
  const states = {} as Record<Category, CategoryState>
  for (const category of CATEGORIES) states[category] = { status: 'not-assessed', reason }
  return states
}

function compare(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * Re-hashes base findings in renamed files under their head path, so identity
 * survives `git mv`.
 *
 * The finding is rewritten, not merely re-keyed: its `file` becomes the head
 * path, which is where a reader would go looking for it and the only path that
 * agrees with the id next to it. Its range is left alone — a range was never
 * identity, and the base scan's line numbers are the honest record of where the
 * finding was when it was seen.
 *
 * Its **project** moves with it: `git mv`-ing a file from one package to another
 * is one finding that changed hands, and leaving the base attribution on it
 * would count a resolved finding against the package it left — the very churn
 * the re-hash exists to prevent, one level up.
 *
 * A finding with no {@link Finding.identity} (hand-constructed; the core always
 * attaches one) cannot be re-hashed, so it is left at its base path. It will
 * read as resolved, with its head twin new — the conservative failure, and one
 * that overstates churn rather than hiding a regression.
 *
 * @param projectOf head's attribution rule; omitted, base attribution stands.
 */
export function remapRenames(
  findings: readonly Finding[],
  renames: ReadonlyMap<string, string>,
  projectOf?: (file: string) => string | undefined,
): Finding[] {
  if (renames.size === 0) return [...findings]
  return findings.map((finding) => {
    const renamed = renames.get(finding.file)
    if (renamed === undefined || finding.identity === undefined) return finding
    const { project: _base, ...rest } = finding
    const project = projectOf === undefined ? finding.project : projectOf(renamed)
    return {
      ...rest,
      ...(project === undefined ? {} : { project }),
      file: renamed,
      id: fingerprint(
        finding.category,
        finding.tool,
        finding.rule,
        renamed,
        finding.identity.anchor,
        finding.identity.occurrence,
      ),
    }
  })
}

/**
 * Spec §4's touched-line test, on the finding's start line.
 *
 * The start line and not the whole range: a range is display-only, and tools
 * that report a whole function (or a whole file, as `1:1:1:1`) would otherwise
 * count as directly-actionable for any edit anywhere inside them.
 */
function isTouched(
  finding: Finding,
  touchedLines: ReadonlyMap<string, ReadonlySet<number>>,
): boolean {
  return touchedLines.get(finding.file)?.has(finding.range.startLine) ?? false
}
