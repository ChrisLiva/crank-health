import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CategoryState } from '../src/core/types.ts'
import type { ReportProjectMovement } from '../src/render/json.ts'
import type { HealthScanResult } from '../src/run.ts'
import { runPrScan } from '../src/run-pr.ts'
import type { HistoryRepo } from './support/history.ts'
import { createHistoryRepo } from './support/history.ts'
import { MONO_PR_HISTORY } from './support/pr-fixture.ts'

/**
 * `--pr` over a workspace, end to end (spec acceptance criterion 6): the four
 * things a change can do to a project, on one real two-commit history.
 *
 * No golden. Every assertion here is about a planted outcome — a rule the root
 * config turned on, a file moved across a package boundary, a package added and
 * one deleted — so they hold on any machine, whatever else it has installed.
 * `--only lint` keeps the run to one tool per project; what the delta then
 * *decides* is covered instantly by `delta.test.ts`.
 */

/** Two scans over eight packages' worth of files, on a cold npm cache. */
const SCAN_TIMEOUT_MS = 300_000

let repo: HistoryRepo
let result: HealthScanResult

beforeAll(async () => {
  repo = await createHistoryRepo(MONO_PR_HISTORY)
  result = await runPrScan({ path: repo.root, base: 'main', only: ['lint'] })
}, SCAN_TIMEOUT_MS)

afterAll(async () => {
  await repo.remove()
})

function movement(path: string): ReportProjectMovement | undefined {
  return result.report.delta?.projects.find((project) => project.path === path)
}

/** One project's lint states, as `base → head`. */
function lint(path: string): string {
  const found = movement(path)?.categories.find((entry) => entry.category === 'lint')
  return `${label(found?.base)} → ${label(found?.head)}`
}

/** The grade, or the reason there is none — which is where a churn label is. */
function label(state: CategoryState | undefined): string {
  if (state === undefined) return 'missing'
  return state.status === 'graded' ? state.grade : state.reason
}

describe('a PR against a workspace', () => {
  it('discovers every project on both sides, root shell included', () => {
    expect(result.report.delta?.projects.map((project) => [project.path, project.churn])).toEqual([
      ['packages/added', 'added'],
      ['packages/dropped', 'removed'],
      ['packages/mover', 'none'],
      ['packages/steady', 'none'],
      ['packages/target', 'none'],
    ])
    expect(result.report.rootShell?.declaredBy).toEqual(['package.json'])
  })

  /**
   * The reason per-project deltas exist: the change edits one file at the root
   * and a package it never opened is the one that regresses. The finding is not
   * on a touched line — nothing in that package was touched at all.
   */
  it('moves an untouched project’s grades when the root config changes', () => {
    expect(movement('packages/steady')).toMatchObject({
      churn: 'none',
      newFindings: 1,
      resolvedFindings: 0,
    })
    expect(lint('packages/steady')).toBe('A → F')

    const introduced = (result.report.delta?.newFindings ?? []).filter(
      (finding) => finding.project === 'packages/steady',
    )
    expect(introduced.map((finding) => [finding.rule, finding.touchedLine])).toEqual([
      ['eslint(no-unreachable)', false],
    ])
  })

  /**
   * Spec §4's required case: a `git mv` across a package boundary is the same
   * finding, re-attributed. Both projects' grades move and neither reports a
   * single new or resolved finding, because nothing was introduced or fixed.
   */
  it('re-attributes a finding moved across projects without any churn', () => {
    expect(movement('packages/mover')).toMatchObject({ newFindings: 0, resolvedFindings: 0 })
    expect(movement('packages/target')).toMatchObject({ newFindings: 0, resolvedFindings: 0 })
    expect(lint('packages/mover')).toBe('F → A')
    expect(lint('packages/target')).toBe('A → F')

    // The finding itself: same rule, now at the head path, owned by the target.
    expect(
      result.report.findings
        .filter((finding) => finding.rule === 'eslint(no-dupe-keys)')
        .map((finding) => [finding.file, finding.project]),
    ).toEqual([['packages/target/src/clone.js', 'packages/target']])
  })

  it('labels the project this change added and the one it removed', () => {
    expect(movement('packages/added')).toMatchObject({
      churn: 'added',
      newFindings: 1,
      resolvedFindings: 0,
    })
    expect(lint('packages/added')).toBe('project added by this change → F')

    expect(movement('packages/dropped')).toMatchObject({
      churn: 'removed',
      newFindings: 0,
      resolvedFindings: 1,
    })
    expect(lint('packages/dropped')).toBe('F → project removed by this change')
  })

  /**
   * The gate's material (spec §4: `--fail-under` applies to an added project).
   * `report.projects` carries the added project's own grade and the delta says
   * it is new here; the rollup, which is what the gate reads today, fails too.
   */
  it('exposes the added project’s failing grade to the gate', () => {
    const added = result.report.projects.find((project) => project.path === 'packages/added')
    expect(added?.categories.lint).toEqual({ status: 'graded', grade: 'F' })
    expect(result.report.categories.lint).toEqual({ status: 'graded', grade: 'F' })
  })

  it('counts the change once in the rollup, and leaves the repo clean', async () => {
    // Two new (the added package, the root config's reach into steady), one
    // resolved (the deleted package), one unchanged (the moved clone).
    expect(result.report.delta?.counts).toEqual({
      new: 2,
      touchedLine: 1,
      resolved: 1,
      unchanged: 1,
    })
    expect(await repo.status()).toBe('')
  })
})
