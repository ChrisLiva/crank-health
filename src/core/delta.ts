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
}

/** A new finding, plus whether this change is what put it there. */
export interface DeltaFinding {
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

export interface DeltaResult {
  /** New findings, in report order; touched-line ones flagged, not reordered. */
  readonly newFindings: readonly DeltaFinding[]
  /** Findings the base had and head does not, in report order, at head paths. */
  readonly resolvedFindings: readonly Finding[]
  /** Findings present in both scans — not rendered, but counted. */
  readonly unchangedCount: number
  /** All eight categories, in canonical order. */
  readonly categories: readonly CategoryMovement[]
}

/** Computes the delta. See the module note for what makes it more than a diff. */
export function computeDelta(input: DeltaInput): DeltaResult {
  const base = remapRenames(input.baseFindings, input.renames)
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
    categories: CATEGORIES.map((category) => ({
      category,
      base: input.baseCategories[category],
      head: input.headCategories[category],
      newFindings: added.filter((finding) => finding.category === category).length,
      resolvedFindings: resolved.filter((finding) => finding.category === category).length,
    })),
  }
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
 * A finding with no {@link Finding.identity} (hand-constructed; the core always
 * attaches one) cannot be re-hashed, so it is left at its base path. It will
 * read as resolved, with its head twin new — the conservative failure, and one
 * that overstates churn rather than hiding a regression.
 */
export function remapRenames(
  findings: readonly Finding[],
  renames: ReadonlyMap<string, string>,
): Finding[] {
  if (renames.size === 0) return [...findings]
  return findings.map((finding) => {
    const renamed = renames.get(finding.file)
    if (renamed === undefined || finding.identity === undefined) return finding
    return {
      ...finding,
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
