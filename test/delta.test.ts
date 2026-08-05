import { describe, expect, it } from 'vitest'
import { computeDelta, remapRenames } from '../src/core/delta.ts'
import type { DeltaInput } from '../src/core/delta.ts'
import { computeAnchors, fingerprint } from '../src/core/fingerprint.ts'
import { parseNameStatus, parseTouchedLines } from '../src/core/git.ts'
import type { Category, CategoryState, Finding } from '../src/core/types.ts'
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
    ...overrides,
  }
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

function line(startLine: number) {
  return { startLine, startCol: 1, endLine: startLine, endCol: 4 }
}
