import { describe, expect, it } from 'vitest'
import type { Category, CategoryState } from '../src/core/types.ts'
import { gateFailures } from '../src/gate.ts'
import type { Report } from '../src/render/json.ts'
import { REPO_SCOPED_REASON } from '../src/run.ts'
import { allGraded, allNotAssessed, makeProjectScan, makeReport, projectAt } from './factories.ts'

/**
 * `--fail-under` (spec CLI surface): the exit code a CI job reads. What it must
 * catch is a failing package hidden inside a passing blend; what it must not do
 * is fail a package for a category the *repo* answered, which is the one state
 * that is not a missing signal.
 */

const REPO_SCOPED: CategoryState = { status: 'not-assessed', reason: REPO_SCOPED_REASON }

describe('gateFailures', () => {
  it('passes a report that clears the threshold everywhere', () => {
    expect(gateFailures(monorepo(allGraded('A'), allGraded('A')), 'B', false)).toEqual([])
  })

  it('names the failing package even when the rollup clears the threshold', () => {
    const report = monorepo(allGraded('A'), { ...allGraded('A'), lint: graded('F') })
    expect(gateFailures(report, 'B', false)).toEqual(['packages/api lint F'])
  })

  it('names the rollup’s own failure without a project prefix', () => {
    const report = monorepo({ ...allGraded('A'), lint: graded('D') }, allGraded('A'))
    expect(gateFailures(report, 'B', false)).toEqual(['lint D'])
  })

  /**
   * The exemption. A project's `not-assessed(repo-scoped)` does not mean nothing
   * assessed the category — it means the repo did, and the repo's answer is
   * gated once, in the rollup. Without this, a monorepo would exit 1 on a
   * machine where the same code as a single project exits 0.
   */
  it('never trips on a project whose category the repo answered', () => {
    const report = monorepo(allGraded('A'), { ...allGraded('A'), security: REPO_SCOPED })

    expect(gateFailures(report, 'B', false)).toEqual([])
    // …and the same state anywhere else is still a missing signal.
    expect(
      gateFailures(
        monorepo(allGraded('A'), { ...allGraded('A'), security: notAssessed() }),
        'B',
        false,
      ),
    ).toEqual(['packages/api security not-assessed'])
  })

  it('counts a category nothing assessed as a failure unless --allow-missing', () => {
    const report = monorepo(allNotAssessed(), allGraded('A'))
    expect(gateFailures(report, 'B', false)).not.toEqual([])
    expect(gateFailures(report, 'B', true)).toEqual([])
  })

  it('asks a single-project repo once, not twice', () => {
    const single = makeReport({
      categories: { ...allGraded('A'), lint: graded('F') },
      projects: [makeProjectScan({ categories: { ...allGraded('A'), lint: graded('F') } })],
    })
    expect(gateFailures(single, 'B', false)).toEqual(['lint F'])
  })

  it('only gates the categories this run selected', () => {
    const report = monorepo({ ...allGraded('A'), lint: graded('F') }, allGraded('A'))
    const scoped: Report = { ...report, selected: ['security'] }
    expect(gateFailures(scoped, 'B', false)).toEqual([])
  })
})

function graded(grade: 'A' | 'D' | 'F'): CategoryState {
  return { status: 'graded', grade }
}

function notAssessed(): CategoryState {
  return { status: 'not-assessed', reason: 'no tool available for this category' }
}

/** A rollup and one package, so the gate has two sets of states to ask. */
function monorepo(
  rollup: Record<Category, CategoryState>,
  api: Record<Category, CategoryState>,
): Report {
  return makeReport({
    categories: rollup,
    projects: [
      makeProjectScan({ project: projectAt('packages/api'), categories: api }),
      makeProjectScan({ project: projectAt('packages/web'), categories: allGraded('A') }),
    ],
  })
}
