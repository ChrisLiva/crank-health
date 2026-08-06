import { isBelow } from './core/grade.ts'
import type { Category, CategoryState, Grade } from './core/types.ts'
import type { Report } from './render/json.ts'
import { REPO_SCOPED_REASON } from './run.ts'

/**
 * The `--fail-under` gate (spec CLI surface): does this report clear the
 * threshold, and if not, what failed?
 *
 * It lives beside `cli.ts` rather than inside it because `cli.ts` runs a scan on
 * import — the gate is the one piece of the CLI with a decision in it, and a
 * decision has to be testable without one.
 */

/**
 * The rollup **or any scanned project** grading below the threshold trips it.
 *
 * Per project and not only in the blend, because a blend is exactly where a
 * small failing package hides behind a large healthy one — the gate would pass
 * a change nobody would merge. In PR mode that includes a project the change
 * added: its grades are head's, and head is what this report is about.
 *
 * A single-project repo is not asked twice. Its one project's states are the
 * rollup's, and naming both would report one failure as two.
 *
 * @returns one entry per failure, project-qualified where the report has
 * projects to tell apart; empty when the report clears the threshold.
 */
export function gateFailures(report: Report, threshold: Grade, allowMissing: boolean): string[] {
  const rollup = belowThreshold(report.selected, report.categories, threshold, allowMissing)
  if (report.projects.length < 2) return rollup
  return [
    ...rollup,
    ...report.projects.flatMap((project) =>
      belowThreshold(report.selected, project.categories, threshold, allowMissing).map(
        (failure) => `${project.path} ${failure}`,
      ),
    ),
  ]
}

/**
 * One set of category states against the threshold. A selected category nothing
 * could assess trips the gate too — a missing signal is not a passing one —
 * unless `--allow-missing`. Categories excluded by `--only` are not selected, so
 * they never trip it.
 *
 * The one state that never trips it is a project's `not-assessed(repo-scoped)`:
 * it does not mean nothing assessed the category, it means the repo did, and the
 * repo's answer is gated in the rollup. Failing a package for the rollup's
 * finding would fail it twice; failing it for the rollup's *A* would be absurd.
 */
function belowThreshold(
  selected: readonly Category[],
  states: Readonly<Record<Category, CategoryState>>,
  threshold: Grade,
  allowMissing: boolean,
): string[] {
  return selected.flatMap((category) => {
    const state = states[category]
    if (state.status === 'graded') {
      return isBelow(state.grade, threshold) ? [`${category} ${state.grade}`] : []
    }
    if (state.status === 'not-assessed' && state.reason === REPO_SCOPED_REASON) return []
    return allowMissing ? [] : [`${category} ${state.status}`]
  })
}
