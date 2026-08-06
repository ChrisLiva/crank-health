import { describe, expect, it } from 'vitest'
import { computeDelta } from '../src/core/delta.ts'
import { ROOT_PROJECT, inventoryOf } from '../src/core/discover.ts'
import { computeAnchors } from '../src/core/fingerprint.ts'
import type { Category, CategoryState, Finding, Grade } from '../src/core/types.ts'
import { buildAgentTasks, renderAgentMarkdown } from '../src/render/agent-md.ts'
import type { PrDelta, Report } from '../src/render/json.ts'
import { renderReportMarkdown } from '../src/render/report-md.ts'
import { renderTerminal } from '../src/render/terminal.ts'
import { allGraded, allNotAssessed, makeFinding, makeProjectScan, makeReport } from './factories.ts'

/**
 * What the three renderers do with a delta, driven by synthetic reports so each
 * assertion is about one rendering rule rather than about whatever a fixture
 * happened to contain. The goldens in `pr-scan.test.ts` cover the spelling of a
 * whole real one.
 */

function identified(overrides: Partial<Finding> & { readonly anchor: string }): Finding {
  const { anchor, ...rest } = overrides
  const [finding] = computeAnchors([{ ...makeFinding(), ...rest, anchor }], new Map())
  if (finding === undefined) throw new Error('computeAnchors returned nothing')
  return finding
}

const ON_DIFF = identified({
  anchor: 'const limit = 1',
  file: 'src/touched.js',
  rule: 'no-const-assign',
  severity: 'error',
  message: 'reassigned const',
  range: { startLine: 2, startCol: 1, endLine: 2, endCol: 9 },
})

const ELSEWHERE = identified({
  anchor: 'console.log(value)',
  file: 'src/elsewhere.js',
  rule: 'no-unreachable',
  severity: 'error',
  message: 'unreachable code',
  range: { startLine: 40, startCol: 1, endLine: 40, endCol: 9 },
})

const RESOLVED = identified({
  anchor: 'let unused = 1',
  file: 'src/fixed.js',
  rule: 'no-unused-vars',
  message: 'unused variable',
})

/** A project graded in the one category these tests drive. */
function graded(grade: Grade): Record<Category, CategoryState> {
  return { ...allNotAssessed(), lint: { status: 'graded', grade } }
}

/** A stayed-put finding, so the report has one that is nobody's business here. */
const UNCHANGED = identified({ anchor: 'old debt', file: 'src/old.js', rule: 'no-debugger' })

function prReport(): Report {
  const delta = computeDelta({
    baseFindings: [RESOLVED, UNCHANGED],
    headFindings: [ON_DIFF, ELSEWHERE, UNCHANGED],
    renames: new Map(),
    touchedLines: new Map([['src/touched.js', new Set([2])]]),
    baseCategories: allGraded('B'),
    headCategories: allGraded('F'),
    baseProjects: [{ path: ROOT_PROJECT, categories: allGraded('B') }],
    headProjects: [{ path: ROOT_PROJECT, categories: allGraded('F') }],
  })
  return makeReport({
    delta: { ...delta, baseRef: 'main', mergeBase: 'abcdef0123456789' } satisfies PrDelta,
    categories: allGraded('F'),
    findings: [ON_DIFF, ELSEWHERE, UNCHANGED],
  })
}

/**
 * The same delta over a workspace: one package this change added, one it
 * removed, one it moved, and one it left alone. Every finding is attributed, so
 * each project's counts are its own.
 */
function monoPrReport(): Report {
  const added = { ...ON_DIFF, project: 'packages/api' }
  const moved = { ...ELSEWHERE, project: 'packages/web' }
  const gone = { ...RESOLVED, project: 'packages/legacy' }

  const delta = computeDelta({
    baseFindings: [gone, UNCHANGED],
    headFindings: [added, moved, UNCHANGED],
    renames: new Map(),
    touchedLines: new Map([['src/touched.js', new Set([2])]]),
    baseCategories: allGraded('B'),
    headCategories: allGraded('F'),
    baseProjects: [
      { path: 'packages/legacy', categories: graded('F') },
      { path: 'packages/quiet', categories: graded('A') },
      { path: 'packages/web', categories: graded('B') },
    ],
    headProjects: [
      { path: 'packages/api', categories: graded('F') },
      { path: 'packages/quiet', categories: graded('A') },
      { path: 'packages/web', categories: graded('F') },
    ],
  })
  return makeReport({
    delta: { ...delta, baseRef: 'main', mergeBase: 'abcdef0123456789' } satisfies PrDelta,
    categories: allGraded('F'),
    findings: [added, moved, UNCHANGED],
    projects: ['packages/api', 'packages/quiet', 'packages/web'].map((path) =>
      makeProjectScan({
        project: {
          path,
          manifests: [`${path}/package.json`],
          languages: ['js-ts'],
          files: inventoryOf([`${path}/index.js`]),
        },
      }),
    ),
  })
}

describe('the per-project delta', () => {
  const artifacts = { markdown: '/out/report.md', agent: '/out/agent.md', json: '/out/report.json' }

  it('carries every project’s movement in report.json, labelled', () => {
    const projects = monoPrReport().delta?.projects ?? []
    expect(
      projects.map((project) => [
        project.path,
        project.churn,
        project.newFindings,
        project.resolvedFindings,
      ]),
    ).toEqual([
      ['packages/api', 'added', 1, 0],
      ['packages/legacy', 'removed', 0, 1],
      ['packages/quiet', 'none', 0, 0],
      ['packages/web', 'none', 1, 0],
    ])
  })

  it('names the projects that moved in the terminal summary and counts the rest', () => {
    const output = renderTerminal(monoPrReport(), artifacts, { color: false })
    expect(output).toContain('packages/api     project added · +1 new · lint not assessed → F')
    expect(output).toContain(
      'packages/legacy  project removed · -1 resolved · lint F → not assessed',
    )
    expect(output).toContain('packages/web     +1 new · lint B → F')
    expect(output).toContain('1 other project unchanged')
    // The one that did not move is counted, not listed — it is in the Projects
    // block above with its grades, which is where its state belongs.
    const [, delta = ''] = output.split('PR delta vs main')
    expect(delta).not.toContain('packages/quiet')
  })

  it('tables the projects that moved in report.md and lists the rest', () => {
    const markdown = renderReportMarkdown(monoPrReport())
    expect(markdown).toContain('### Project movement')
    expect(markdown).toContain(
      '| packages/api | added by this change | 1 | 0 | lint not assessed → F |',
    )
    expect(markdown).toContain(
      '| packages/legacy | removed by this change | 0 | 1 | lint F → not assessed |',
    )
    expect(markdown).toContain('| packages/web | scanned on both sides | 1 | 0 | lint B → F |')
    expect(markdown).toContain('1 other project unchanged: `packages/quiet`.')
  })

  it('tells agent.md that a removed project’s findings are not fixes', () => {
    const markdown = renderAgentMarkdown(monoPrReport())
    expect(markdown).toContain('## Resolved by this change (1)')
    expect(markdown).toContain(
      '1 project (`packages/legacy`) was removed by this change: findings in it count as resolved ' +
        'because the code is gone, not because it was fixed.',
    )
  })

  /** A single-project repo is the delta above it; nothing here may show up in one. */
  it('renders no project block at all for a single-project repo', () => {
    const report = prReport()
    expect(renderTerminal(report, artifacts, { color: false })).not.toContain('project added')
    expect(renderReportMarkdown(report)).not.toContain('### Project movement')
    expect(renderAgentMarkdown(report)).not.toContain('removed by this change')
  })
})

describe('agent.md in PR mode', () => {
  const report = prReport()

  it('builds tasks from the new findings only', () => {
    const rules = buildAgentTasks(report).flatMap((task) =>
      task.findings.map((finding) => finding.rule),
    )
    expect(rules).toEqual(['no-const-assign', 'no-unreachable'])
    expect(rules).not.toContain('no-debugger')
  })

  it('puts the directly-actionable task first and marks it', () => {
    const tasks = buildAgentTasks(report)
    expect(tasks.map((task) => [task.id, task.directlyActionable])).toEqual([
      ['T1', true],
      ['T2', false],
    ])
  })

  it('marks the touched-line finding in the rendered task, and not the other', () => {
    const markdown = renderAgentMarkdown(report)
    expect(markdown).toContain('`src/touched.js:2` `no-const-assign` — reassigned const [in-diff]')
    expect(markdown).toContain('`src/elsewhere.js:40` `no-unreachable` — unreachable code\n')
  })

  it('notes the resolved findings at the bottom, as context', () => {
    const markdown = renderAgentMarkdown(report)
    const [tasks = '', resolved = ''] = markdown.split('## Resolved by this change (1)')
    expect(tasks).toContain('## Tasks')
    expect(resolved).toContain('`src/fixed.js:1` `no-unused-vars` — unused variable')
    // Context, not work: no task id, and it is below every task.
    expect(resolved).not.toContain('### T')
  })

  it('says what the change did, and adds the PR ground rules', () => {
    const markdown = renderAgentMarkdown(report)
    expect(markdown).toContain('PR vs `main` (merge-base `abcdef01`)')
    expect(markdown).toContain('This change: 2 new findings (1 on lines it touched), 1 resolved')
    expect(markdown).toContain('the tasks below are what *this change* introduced')
  })

  /**
   * A whole-repo report has no delta, so nothing above may leak into one — the
   * ordinary run is still the common case.
   */
  it('changes nothing about a whole-repo report', () => {
    const plain = makeReport({ categories: allGraded('F'), findings: [ON_DIFF, UNCHANGED] })
    const markdown = renderAgentMarkdown(plain)
    expect(markdown).not.toContain('[in-diff]')
    expect(markdown).not.toContain('Resolved by this change')
    expect(buildAgentTasks(plain).every((task) => !task.directlyActionable)).toBe(true)
  })

  it('says there is nothing to do when the change introduced nothing', () => {
    const clean = makeReport({
      delta: {
        ...computeDelta({
          baseFindings: [UNCHANGED],
          headFindings: [UNCHANGED],
          renames: new Map(),
          touchedLines: new Map(),
          baseCategories: allGraded('F'),
          headCategories: allGraded('F'),
          baseProjects: [{ path: ROOT_PROJECT, categories: allGraded('F') }],
          headProjects: [{ path: ROOT_PROJECT, categories: allGraded('F') }],
        }),
        baseRef: 'main',
        mergeBase: 'abcdef0123456789',
      },
      categories: allGraded('F'),
      findings: [UNCHANGED],
    })
    expect(renderAgentMarkdown(clean)).toContain(
      'No tasks: this change introduced no new findings.',
    )
  })
})

describe('report.md in PR mode', () => {
  const markdown = renderReportMarkdown(prReport())

  it('renders the delta block between the summary and the category detail', () => {
    const summary = markdown.indexOf('## Grades')
    const delta = markdown.indexOf('## PR delta')
    const detail = markdown.indexOf('## security')
    expect(summary).toBeLessThan(delta)
    expect(delta).toBeLessThan(detail)
  })

  it('states the counts and the per-category movement', () => {
    expect(markdown).toContain(
      'Against `main`, merge-base `abcdef01`. 2 new findings (1 on lines this change touched), 1 resolved, 1 unchanged.',
    )
    expect(markdown).toContain('| lint | B | F | 2 | 1 |')
  })

  it('adds the per-category new and resolved counts to the grade basis', () => {
    expect(markdown).toContain('This change: 2 new, 1 resolved.')
    // Only where something moved: security has no findings on either side.
    const [, security = ''] = markdown.split('## security — F')
    expect(security.split('## ')[0]).not.toContain('This change:')
  })

  it('lists new and resolved findings, marking the ones on touched lines', () => {
    expect(markdown).toContain('**New findings** (2)')
    expect(markdown).toContain(
      '`src/touched.js:2` `no-const-assign` — reassigned const (oxlint) [default-config] [in-diff]',
    )
    expect(markdown).toContain('**Resolved findings** (1)')
  })

  it('changes nothing about a whole-repo report', () => {
    const plain = renderReportMarkdown(makeReport({ categories: allGraded('F') }))
    expect(plain).not.toContain('## PR delta')
    expect(plain).not.toContain('This change:')
  })
})

describe('the terminal summary in PR mode', () => {
  const artifacts = { markdown: '/out/report.md', agent: '/out/agent.md', json: '/out/report.json' }
  const output = renderTerminal(prReport(), artifacts, { color: false })

  it('summarizes the delta and the grades that moved', () => {
    expect(output).toContain('PR delta vs main (merge-base abcdef01)')
    expect(output).toContain('+2 new (1 on changed lines) · -1 resolved · 1 unchanged')
    expect(output).toContain('lint          B → F')
  })

  /** The glance an author needs is what they just introduced, not the backlog. */
  it('lists the new findings rather than every finding in the repo', () => {
    expect(output).toContain('Top new findings')
    expect(output).toContain('src/touched.js:2')
    expect(output).not.toContain('src/old.js')
  })

  it('changes nothing about a whole-repo report', () => {
    const plain = renderTerminal(
      makeReport({ categories: allGraded('F'), findings: [UNCHANGED] }),
      artifacts,
      { color: false },
    )
    expect(plain).toContain('Top findings')
    expect(plain).not.toContain('PR delta')
  })
})
