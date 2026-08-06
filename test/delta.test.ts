import { describe, expect, it } from 'vitest'
import {
  PROJECT_ADDED_REASON,
  PROJECT_REMOVED_REASON,
  computeDelta,
  remapRenames,
} from '../src/core/delta.ts'
import type { DeltaInput, DeltaProject, DeltaResult, ProjectMovement } from '../src/core/delta.ts'
import { computeAnchors, fingerprint } from '../src/core/fingerprint.ts'
import { parseNameStatus, parseTouchedLines } from '../src/core/git.ts'
import type { Category, CategoryState, Finding, Grade } from '../src/core/types.ts'
import { allGraded, allNotAssessed, makeFinding } from './factories.ts'

/**
 * The classification matrix of spec §4, as pure functions: new · resolved ·
 * unchanged, rename mapping, touched-line flagging and grade movement. The
 * full-pipeline PR tests (`pr-scan.test.ts`) prove that real scans feed this
 * the right inputs; everything about what it then decides is here.
 */

/** A finding as the core produces one: with the identity material attached. */
function identified(overrides: Partial<Finding> & { readonly anchor?: string } = {}): Finding {
  const { anchor, ...rest } = overrides
  const [finding] = computeAnchors(
    [{ ...makeFinding(), ...rest, ...(anchor === undefined ? {} : { anchor }) }],
    new Map(),
  )
  if (finding === undefined) throw new Error('computeAnchors returned nothing')
  return finding
}

function input(overrides: Partial<DeltaInput> = {}): DeltaInput {
  return {
    baseFindings: [],
    headFindings: [],
    renames: new Map(),
    touchedLines: new Map(),
    baseCategories: allNotAssessed(),
    headCategories: allNotAssessed(),
    baseProjects: [],
    headProjects: [],
    ...overrides,
  }
}

/** One side's project, graded the same in every category unless told otherwise. */
function project(
  path: string,
  categories: Record<Category, CategoryState> = allNotAssessed(),
): DeltaProject {
  return { path, categories }
}

function projectMovement(delta: DeltaResult, path: string): ProjectMovement | undefined {
  return delta.projects.find((entry) => entry.path === path)
}

/** A project graded in the one category these tests drive. */
function graded(grade: Grade): Record<Category, CategoryState> {
  return { ...allNotAssessed(), lint: { status: 'graded', grade } }
}

describe('computeDelta', () => {
  it('classifies each finding as new, resolved or unchanged exactly once', () => {
    const shared = identified({ anchor: 'shared' })
    const gone = identified({ anchor: 'gone' })
    const added = identified({ anchor: 'added' })

    const delta = computeDelta(
      input({ baseFindings: [shared, gone], headFindings: [shared, added] }),
    )

    expect(delta.newFindings.map((entry) => entry.finding.id)).toEqual([added.id])
    expect(delta.resolvedFindings.map((finding) => finding.id)).toEqual([gone.id])
    expect(delta.unchangedCount).toBe(1)
  })

  /**
   * The line-shift-proof promise of spec §2, at the delta level: identity has
   * no line number in it, so a finding that only moved down the file is neither
   * new nor resolved.
   */
  it('does not churn a finding that only moved to a different line', () => {
    const before = identified({ anchor: 'debugger', range: line(4) })
    const after = identified({ anchor: 'debugger', range: line(41) })
    expect(after.id).toBe(before.id)

    const delta = computeDelta(input({ baseFindings: [before], headFindings: [after] }))

    expect(delta.newFindings).toEqual([])
    expect(delta.resolvedFindings).toEqual([])
    expect(delta.unchangedCount).toBe(1)
  })

  it('carries findings across a rename instead of reporting churn', () => {
    const before = identified({ file: 'src/a.js', anchor: 'debugger' })
    const after = identified({ file: 'src/b.js', anchor: 'debugger' })
    expect(after.id).not.toBe(before.id)

    const delta = computeDelta(
      input({
        baseFindings: [before],
        headFindings: [after],
        renames: new Map([['src/a.js', 'src/b.js']]),
      }),
    )

    expect(delta.newFindings).toEqual([])
    expect(delta.resolvedFindings).toEqual([])
    expect(delta.unchangedCount).toBe(1)
  })

  it('reports a finding resolved at its head path when its file was renamed', () => {
    const before = identified({ file: 'src/a.js', anchor: 'debugger' })

    const delta = computeDelta(
      input({ baseFindings: [before], renames: new Map([['src/a.js', 'src/b.js']]) }),
    )

    expect(delta.resolvedFindings.map((finding) => [finding.file, finding.id])).toEqual([
      ['src/b.js', fingerprint('lint', 'oxlint', 'no-unused-vars', 'src/b.js', 'debugger', 0)],
    ])
  })

  /**
   * Spec §4 flags the ones on touched lines and *includes* the rest: a change
   * that breaks something forty lines away has still broken it.
   */
  it('flags new findings on touched lines and keeps the non-local ones', () => {
    const onDiff = identified({ file: 'src/a.js', anchor: 'here', range: line(2) })
    const elsewhere = identified({ file: 'src/a.js', anchor: 'far', range: line(40) })

    const delta = computeDelta(
      input({
        headFindings: [onDiff, elsewhere],
        touchedLines: new Map([['src/a.js', new Set([1, 2, 3])]]),
      }),
    )

    expect(delta.newFindings.map((entry) => [entry.finding.id, entry.touchedLine])).toEqual([
      [onDiff.id, true],
      [elsewhere.id, false],
    ])
  })

  it('flags nothing in a file the change did not touch at all', () => {
    const finding = identified({ file: 'src/untouched.js', range: line(2) })
    const delta = computeDelta(
      input({
        headFindings: [finding],
        touchedLines: new Map([['src/other.js', new Set([2])]]),
      }),
    )
    expect(delta.newFindings.map((entry) => entry.touchedLine)).toEqual([false])
  })

  it('records every category’s movement, base state included', () => {
    const added = identified({ category: 'lint', anchor: 'added' })
    const delta = computeDelta(
      input({
        headFindings: [added],
        baseCategories: allGraded('A'),
        headCategories: { ...allGraded('A'), lint: { status: 'graded', grade: 'F' } },
      }),
    )

    expect(delta.categories).toHaveLength(8)
    expect(movement(delta.categories, 'lint')).toEqual({
      category: 'lint',
      base: { status: 'graded', grade: 'A' },
      head: { status: 'graded', grade: 'F' },
      newFindings: 1,
      resolvedFindings: 0,
    })
    expect(movement(delta.categories, 'security')?.newFindings).toBe(0)
  })

  /**
   * A tool that failed only at the base makes "resolved" meaningless for that
   * category — the findings did not go away, the tool did. The state is carried
   * through so a reader can see it (spec §8).
   */
  it('keeps a base-only tool failure visible next to the resolved count', () => {
    const gone = identified({ category: 'lint', anchor: 'gone' })
    const failed: CategoryState = { status: 'error', reason: 'oxlint crashed' }
    const delta = computeDelta(
      input({
        baseFindings: [gone],
        baseCategories: { ...allNotAssessed(), lint: failed },
        headCategories: allGraded('A'),
      }),
    )

    expect(movement(delta.categories, 'lint')).toMatchObject({
      base: failed,
      head: { status: 'graded', grade: 'A' },
      resolvedFindings: 1,
    })
  })

  it('is stable: the same input gives the same output, in report order', () => {
    const first = identified({ file: 'src/b.js', anchor: 'b' })
    const second = identified({ file: 'src/a.js', anchor: 'a', category: 'security' })
    const forwards = computeDelta(input({ headFindings: [first, second] }))
    const backwards = computeDelta(input({ headFindings: [second, first] }))

    expect(forwards).toEqual(backwards)
    // Report order: security before lint (spec §10's priority).
    expect(forwards.newFindings.map((entry) => entry.finding.category)).toEqual([
      'security',
      'lint',
    ])
  })
})

/**
 * The same classification per project (spec §4): each project's own findings
 * and its own grades, plus the two states the rollup cannot express — a project
 * this change added, and one it removed.
 */
describe('computeDelta over projects', () => {
  it('reports each project’s own findings and grades, and every project either side had', () => {
    const added = identified({ file: 'packages/web/a.ts', project: 'packages/web', anchor: 'new' })
    const gone = identified({ file: 'packages/api/b.ts', project: 'packages/api', anchor: 'gone' })

    const delta = computeDelta(
      input({
        baseFindings: [gone],
        headFindings: [added],
        baseProjects: [project('packages/api', graded('F')), project('packages/web', graded('A'))],
        headProjects: [project('packages/api', graded('A')), project('packages/web', graded('F'))],
      }),
    )

    expect(delta.projects.map((entry) => entry.path)).toEqual(['packages/api', 'packages/web'])
    expect(projectMovement(delta, 'packages/web')).toMatchObject({
      churn: 'none',
      newFindings: 1,
      resolvedFindings: 0,
    })
    expect(projectMovement(delta, 'packages/api')).toMatchObject({
      churn: 'none',
      newFindings: 0,
      resolvedFindings: 1,
    })
    // Eight states per project, on that project's grades — not the rollup's.
    expect(projectMovement(delta, 'packages/web')?.categories).toHaveLength(8)
    expect(movement(projectMovement(delta, 'packages/web')?.categories ?? [], 'lint')).toEqual({
      category: 'lint',
      base: { status: 'graded', grade: 'A' },
      head: { status: 'graded', grade: 'F' },
      newFindings: 1,
      resolvedFindings: 0,
    })
  })

  /**
   * Spec §4's required case: `git mv` across a project boundary is the same
   * finding with a new attribution. The rollup already knows that (identity is
   * path-based and the rename is remapped first), and neither project may
   * invent churn out of it — the source did not fix anything and the target did
   * not break anything.
   */
  it('moves a finding across projects without churning either one', () => {
    const before = identified({
      file: 'packages/api/moved.ts',
      project: 'packages/api',
      anchor: 'debugger',
    })
    const after = identified({
      file: 'packages/web/moved.ts',
      project: 'packages/web',
      anchor: 'debugger',
    })

    const delta = computeDelta(
      input({
        baseFindings: [before],
        headFindings: [after],
        renames: new Map([['packages/api/moved.ts', 'packages/web/moved.ts']]),
        baseProjects: [project('packages/api', graded('F')), project('packages/web', graded('A'))],
        headProjects: [project('packages/api', graded('A')), project('packages/web', graded('F'))],
      }),
    )

    expect(delta.newFindings).toEqual([])
    expect(delta.resolvedFindings).toEqual([])
    expect(delta.unchangedCount).toBe(1)
    expect(
      delta.projects.map((entry) => [entry.path, entry.newFindings, entry.resolvedFindings]),
    ).toEqual([
      ['packages/api', 0, 0],
      ['packages/web', 0, 0],
    ])
    // What did move is where the finding counts, which is the two grades.
    expect(movedGrades(delta)).toEqual([
      ['packages/api', 'F', 'A'],
      ['packages/web', 'A', 'F'],
    ])
  })

  /**
   * The same move, with the finding fixed on the way. The resolved finding is
   * reported at its head path, so it has to count under the project that path is
   * in — crediting the package the file left would show a fix in a package this
   * change did not touch.
   */
  it('credits a finding fixed in a moved file to the project it moved to', () => {
    const before = identified({
      file: 'packages/api/moved.ts',
      project: 'packages/api',
      anchor: 'debugger',
    })

    const delta = computeDelta(
      input({
        baseFindings: [before],
        headFindings: [],
        renames: new Map([['packages/api/moved.ts', 'packages/web/moved.ts']]),
        baseProjects: [project('packages/api', graded('F')), project('packages/web', graded('A'))],
        headProjects: [project('packages/api', graded('A')), project('packages/web', graded('A'))],
      }),
    )

    expect(delta.resolvedFindings.map((finding) => [finding.file, finding.project])).toEqual([
      ['packages/web/moved.ts', 'packages/web'],
    ])
    expect(delta.projects.map((entry) => [entry.path, entry.resolvedFindings])).toEqual([
      ['packages/api', 0],
      ['packages/web', 1],
    ])
  })

  it('labels a project only head has as added, with its findings new', () => {
    const planted = identified({
      file: 'packages/new/a.ts',
      project: 'packages/new',
      anchor: 'new',
    })

    const delta = computeDelta(
      input({
        headFindings: [planted],
        baseProjects: [project('packages/web', graded('A'))],
        headProjects: [project('packages/web', graded('A')), project('packages/new', graded('F'))],
      }),
    )

    expect(projectMovement(delta, 'packages/new')).toMatchObject({
      churn: 'added',
      newFindings: 1,
      resolvedFindings: 0,
    })
    // The gate reads the head state; the base state says why there is no before.
    expect(
      movement(projectMovement(delta, 'packages/new')?.categories ?? [], 'lint'),
    ).toMatchObject({
      base: { status: 'not-assessed', reason: PROJECT_ADDED_REASON },
      head: { status: 'graded', grade: 'F' },
    })
  })

  it('labels a project only the base had as removed, so its findings are not fixes', () => {
    const gone = identified({ file: 'packages/old/a.ts', project: 'packages/old', anchor: 'gone' })

    const delta = computeDelta(
      input({
        baseFindings: [gone],
        baseProjects: [project('packages/old', graded('F')), project('packages/web', graded('A'))],
        headProjects: [project('packages/web', graded('A'))],
      }),
    )

    expect(projectMovement(delta, 'packages/old')).toMatchObject({
      churn: 'removed',
      newFindings: 0,
      resolvedFindings: 1,
    })
    expect(
      movement(projectMovement(delta, 'packages/old')?.categories ?? [], 'lint'),
    ).toMatchObject({
      base: { status: 'graded', grade: 'F' },
      head: { status: 'not-assessed', reason: PROJECT_REMOVED_REASON },
    })
    // Still resolved in the rollup: the finding really is gone from head.
    expect(delta.resolvedFindings).toHaveLength(1)
  })

  /** The root project turning into a workspace shell is churn of `.`, like any other. */
  it('treats the root becoming a workspace shell as the root project being removed', () => {
    const delta = computeDelta(
      input({
        baseProjects: [project('.', graded('A'))],
        headProjects: [project('packages/web', graded('A'))],
      }),
    )

    expect(delta.projects.map((entry) => [entry.path, entry.churn])).toEqual([
      ['.', 'removed'],
      ['packages/web', 'added'],
    ])
  })
})

describe('remapRenames', () => {
  it('leaves findings in unrenamed files exactly as they were', () => {
    const finding = identified({ file: 'src/a.js' })
    expect(remapRenames([finding], new Map([['src/other.js', 'src/moved.js']]))).toEqual([finding])
  })

  /** The conservative failure: a finding with no identity material stays put. */
  it('cannot re-hash a finding that carries no identity material', () => {
    const bare = makeFinding({ file: 'src/a.js' })
    expect(remapRenames([bare], new Map([['src/a.js', 'src/b.js']]))).toEqual([bare])
  })

  it('re-attributes a remapped finding to the project of its new path', () => {
    const finding = identified({ file: 'packages/api/a.ts', project: 'packages/api' })
    const [remapped] = remapRenames(
      [finding],
      new Map([['packages/api/a.ts', 'packages/web/a.ts']]),
      (file) => (file.startsWith('packages/web/') ? 'packages/web' : undefined),
    )

    expect(remapped?.file).toBe('packages/web/a.ts')
    expect(remapped?.project).toBe('packages/web')
  })

  it('drops the attribution when the new path is in no project', () => {
    const finding = identified({ file: 'packages/api/a.ts', project: 'packages/api' })
    const [remapped] = remapRenames(
      [finding],
      new Map([['packages/api/a.ts', 'tools/a.ts']]),
      () => undefined,
    )

    expect(remapped).not.toHaveProperty('project')
  })
})

describe('parseNameStatus', () => {
  it('reads renames, additions, modifications and deletions', () => {
    const { renames, changedFiles } = parseNameStatus(
      ['M', 'src/b.js', 'R100', 'src/a.js', 'src/c.js', 'A', 'src/d.js', 'D', 'src/e.js', ''].join(
        '\0',
      ),
    )

    expect([...renames]).toEqual([['src/a.js', 'src/c.js']])
    expect(changedFiles).toEqual(['src/b.js', 'src/c.js', 'src/d.js', 'src/e.js'])
  })

  it('reads a copy’s two paths without calling it a rename', () => {
    const { renames, changedFiles } = parseNameStatus(
      ['C75', 'src/a.js', 'src/copy.js', ''].join('\0'),
    )
    expect([...renames]).toEqual([])
    expect(changedFiles).toEqual(['src/copy.js'])
  })

  it('is empty for an empty diff', () => {
    expect(parseNameStatus('')).toEqual({ renames: new Map(), changedFiles: [] })
  })
})

describe('parseTouchedLines', () => {
  it('reads added and modified head lines from the hunk headers', () => {
    const touched = parseTouchedLines(
      [
        'diff --git src/a.js src/a.js',
        '--- src/a.js',
        '+++ src/a.js',
        '@@ -1 +1 @@',
        '-let a = 1',
        '+const a = 1',
        '@@ -10,0 +11,2 @@',
        '+one',
        '+two',
        '',
      ].join('\n'),
    )

    expect([...(touched.get('src/a.js') ?? [])].toSorted((a, b) => a - b)).toEqual([1, 11, 12])
  })

  it('counts no head line for a pure deletion hunk', () => {
    const touched = parseTouchedLines(
      ['+++ src/a.js', '@@ -4,2 +3,0 @@', '-gone', '-also gone', ''].join('\n'),
    )
    expect(touched.get('src/a.js')).toBeUndefined()
  })

  it('ignores a file the change deleted outright', () => {
    const touched = parseTouchedLines(
      ['--- src/a.js', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-one', '-two', ''].join('\n'),
    )
    expect([...touched.keys()]).toEqual([])
  })

  it('keeps a new file’s every line', () => {
    const touched = parseTouchedLines(
      ['--- /dev/null', '+++ src/new.js', '@@ -0,0 +1,3 @@', '+a', '+b', '+c', ''].join('\n'),
    )
    expect([...(touched.get('src/new.js') ?? [])]).toEqual([1, 2, 3])
  })
})

function movement(
  movements: ReturnType<typeof computeDelta>['categories'],
  category: Category,
): (typeof movements)[number] | undefined {
  return movements.find((entry) => entry.category === category)
}

/** `[project, base lint, head lint]` for every project whose lint grade moved. */
function movedGrades(delta: DeltaResult): (string | undefined)[][] {
  return delta.projects
    .map((entry) => [entry.path, movement(entry.categories, 'lint')] as const)
    .filter(([, lint]) => stateOf(lint?.base) !== stateOf(lint?.head))
    .map(([path, lint]) => [path, stateOf(lint?.base), stateOf(lint?.head)])
}

function stateOf(state: CategoryState | undefined): string | undefined {
  return state === undefined || state.status !== 'graded' ? state?.status : state.grade
}

function line(startLine: number) {
  return { startLine, startCol: 1, endLine: startLine, endCol: 4 }
}
