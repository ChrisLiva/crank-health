import { describe, expect, it } from 'vitest'
import { OSV_SCANNER_TOOL } from '../src/adapters/common/osv-scanner.ts'
import { parseCliArgs } from '../src/args.ts'
import type { Category, CategoryState, Finding, Grade } from '../src/core/types.ts'
import { CATEGORIES, categoryRank } from '../src/core/types.ts'
import type { RunRecord } from '../src/core/orchestrator.ts'
import type { AgentTask } from '../src/render/agent-md.ts'
import { MAX_TASKS, buildAgentTasks, renderAgentMarkdown } from '../src/render/agent-md.ts'
import type { Report, ReportInput, ResolvedRun } from '../src/render/json.ts'
import { reportFindings } from '../src/render/json.ts'
import {
  allGraded,
  makeFinding,
  makeProject,
  makeProjectScan,
  makeReport,
  noMetrics,
  projectAt,
} from './factories.ts'
import { expectGolden, normalizeMarkdown, readGoldenReport } from './support/report.ts'

/**
 * `agent.md` is a contract (spec §10), not a document: an agent reads the task
 * list, works down it, and verifies each task with the command it was given. So
 * most of what follows asserts on {@link buildAgentTasks} — the same tasks the
 * renderer spells out — and the goldens cover the spelling.
 */

const FIXTURES = [
  'cs-basic',
  'go-basic',
  'js-basic',
  'mono-js',
  'mono-mixed',
  'py-basic',
  'sec-basic',
] as const

describe('agent.md goldens', () => {
  it.each(FIXTURES)('matches the golden agent.md for %s', async (name) => {
    const markdown = normalizeMarkdown(renderAgentMarkdown(await readGoldenReport(name)), '<repo>')
    await expectGolden(`${name}.agent.md`, markdown)
  })
})

/**
 * A run whose grade did not come from the tool the repo chose has to say so
 * where the agent reads, not only in `report.json`. The warnings are the run's
 * own fixed sentences, so the line is provenance rather than prose — and a run
 * with nothing to explain renders no line at all, which is why the goldens
 * above are untouched by this.
 */
describe('how this run was graded', () => {
  const WARNING = 'x: graded lint on its default config because y reported error'

  it('quotes every run warning above the ground rules', async () => {
    const report = await readGoldenReport('sec-basic')
    const markdown = renderAgentMarkdown({ ...report, warnings: [WARNING] })

    const line = `> How this run was graded: ${WARNING}`
    expect(markdown).toContain(line)
    expect(markdown.indexOf(line)).toBeLessThan(markdown.indexOf('## Ground rules'))
  })
})

describe('task priority', () => {
  /**
   * Spec §10's order decides between themes nothing else separates — a report
   * that records no arithmetic behind its grades has no movement to rank by, so
   * the fixed order is the whole answer there.
   */
  it('emits categories in the spec’s order whatever their grades are', () => {
    const tasks = buildAgentTasks(everyCategoryFailing())
    const ranks = tasks.map((task) => categoryRank(task.category))
    expect(ranks).toEqual(ranks.toSorted((a, b) => a - b))
    expect([...new Set(tasks.map((task) => task.category))]).toEqual([
      'security',
      'types',
      'dead-code',
      'complexity',
      'duplication',
      'lint',
      'format',
      // Only reachable in `--deep`, and last by the same fixed order.
      'test-quality',
    ])
  })

  it('puts the worst findings first inside a category', () => {
    const report = makeReport({
      categories: { ...allGraded(), lint: { status: 'graded', grade: 'F' } },
      findings: [
        makeFinding({ id: 'w', rule: 'style', severity: 'warning', file: 'src/a.ts' }),
        makeFinding({ id: 'e1', rule: 'broken', severity: 'error', file: 'src/b.ts' }),
        makeFinding({ id: 'i', rule: 'nit', severity: 'info', file: 'src/c.ts' }),
      ],
    })
    expect(buildAgentTasks(report).map((task) => task.title)).toEqual([
      'Fix 1 `broken` finding',
      'Fix 1 `style` finding',
      'Fix 1 `nit` finding',
    ])
  })

  /**
   * A grade is not the filter any more: work is work whatever letter its
   * category currently holds, and a category with no letter at all — nothing
   * could assess it, its tool errored — still has the findings it produced.
   */
  it('makes a task of a graded finding whatever state its category is in', () => {
    const report = makeReport({
      categories: {
        ...allGraded(),
        types: { status: 'not-assessed', reason: 'no type checker ran' },
        lint: { status: 'error', reason: 'oxlint crashed' },
      },
      findings: [
        makeFinding({ id: 'a', category: 'lint', file: 'src/lint.ts' }),
        makeFinding({ id: 'b', category: 'types', tool: 'tsc', rule: 'TS1000', file: 'src/t.ts' }),
        makeFinding({
          id: 'c',
          category: 'dead-code',
          tool: 'knip',
          rule: 'knip/unused-exports',
          file: 'src/dead.ts',
        }),
      ],
    })
    expect(buildAgentTasks(report).map((task) => task.category)).toEqual([
      'types',
      'dead-code',
      'lint',
    ])
  })
})

/**
 * Grade-movement potential: re-run the category's own formula over the findings
 * it would be left with, and count the letters between that grade and today's.
 * The numbers the formula divides come from `report.gradeBasis` — the KLOC, the
 * file count, the percentage each grade was actually computed from — so this is
 * the grading table's arithmetic and not a second opinion about it.
 *
 * The themes that can move a letter come first, most letters first; the ones
 * that cannot — the A→A work — come behind them, in spec §10's order.
 */
describe('ranking by grade movement', () => {
  it('ranks a theme that moves a letter above one that moves none', () => {
    const report = makeReport({
      categories: {
        ...allGraded(),
        security: { status: 'graded', grade: 'D' },
        lint: { status: 'graded', grade: 'F' },
      },
      gradeBasis: {
        security: { value: 2, denominator: null, unit: 'graded findings' },
        lint: { value: 5, denominator: 0.1, unit: 'weighted findings per KLOC' },
      },
      findings: [
        // Two high-severity security findings under two rules: fixing either
        // theme leaves the other, and the category stays at D.
        makeFinding({ id: 's1', ...bandit('B602'), file: 'src/one.py' }),
        makeFinding({ id: 's2', ...bandit('B608'), file: 'src/two.py' }),
        // The whole of lint, in one theme: fixing it takes F to A.
        makeFinding({ id: 'l', severity: 'error', file: 'src/a.ts' }),
      ],
    })
    expect(buildAgentTasks(report).map((task) => task.category)).toEqual([
      'lint',
      'security',
      'security',
    ])
  })

  /** A percentage the tool computed moves with the share of it a theme covers. */
  it('reads a tool-computed percentage down by the share the theme resolves', () => {
    const report = makeReport({
      categories: {
        ...allGraded(),
        duplication: { status: 'graded', grade: 'F' },
        types: { status: 'graded', grade: 'B' },
      },
      gradeBasis: {
        duplication: { value: 25, denominator: null, unit: '% of tokens duplicated' },
        types: { value: 1, denominator: 1, unit: 'weighted findings per KLOC' },
      },
      findings: [
        clone('src/a.ts'),
        makeFinding({ id: 'l', file: 'src/a.ts' }),
        makeFinding({ id: 't', category: 'types', tool: 'tsc', rule: 'TS2322', file: 'src/z.ts' }),
      ],
    })
    // Every clone resolved is 0% duplicated — F to A, five letters — against
    // the one letter B → A the types theme is worth.
    expect(buildAgentTasks(report).map((task) => task.category)).toEqual(['duplication', 'types'])
  })

  /**
   * No recorded arithmetic, no claim about movement: a report from before
   * `gradeBasis` existed ranks by spec §10's order exactly as it always did,
   * rather than by a denominator this would have to invent.
   */
  it('claims no movement for a category whose arithmetic the report does not record', () => {
    const report = makeReport({
      categories: {
        ...allGraded(),
        security: { status: 'graded', grade: 'A' },
        lint: { status: 'graded', grade: 'F' },
      },
      findings: [
        makeFinding({ id: 's', ...bandit('B602'), file: 'src/one.py' }),
        makeFinding({ id: 'l', severity: 'error', file: 'src/a.ts' }),
      ],
    })
    expect(report.gradeBasis).toEqual({})
    expect(buildAgentTasks(report).map((task) => task.category)).toEqual(['security', 'lint'])
  })

  /**
   * A package's own F is the grade its task prints and the grade its agent has
   * to move, so it is the grade the movement is measured against — over that
   * package's findings, which are the ones its letter was computed from. The
   * rollup's A over the whole tree's KLOC is a different measurement, and
   * ranking by it put a package graded F behind work that cannot move a letter
   * at all.
   *
   * Three themes, one of each reading:
   * - `packages/api` lints F on 0.1 KLOC of its own — one theme is all of it, so
   *   fixing it is F → A, four letters. Measured against the rollup's 100 KLOC,
   *   or against the repo's lint findings rather than the package's, it moves
   *   nothing and sorts last.
   * - `packages/web` grades dead code F and records no arithmetic for it. No
   *   recorded basis, no claim: it scores zero rather than borrowing the
   *   rollup's denominator to print a movement the project cannot own.
   * - `packages/web`'s own lint is the A → A work, behind both.
   */
  it('measures a theme against its own project’s grade and findings', () => {
    const inApi = { file: 'packages/api/api/main.py', project: 'packages/api' }
    const inWeb = { file: 'packages/web/src/a.ts', project: 'packages/web' }
    const report = makeReport({
      categories: allGraded(),
      gradeBasis: {
        lint: { value: 25, denominator: 100, unit: 'weighted findings per KLOC' },
        'dead-code': { value: 1, denominator: 100, unit: 'weighted findings per KLOC' },
      },
      projects: [
        makeProjectScan({
          project: projectAt('packages/api'),
          categories: { ...allGraded(), lint: { status: 'graded', grade: 'F' } },
          gradeBasis: { lint: { value: 10, denominator: 0.1, unit: 'weighted findings per KLOC' } },
        }),
        makeProjectScan({
          project: projectAt('packages/web'),
          categories: { ...allGraded(), 'dead-code': { status: 'graded', grade: 'F' } },
          gradeBasis: {},
        }),
      ],
      findings: [
        makeFinding({ id: 'a1', rule: 'no-shadow', severity: 'error', ...inApi, ...atLine(1) }),
        makeFinding({ id: 'a2', rule: 'no-shadow', severity: 'error', ...inApi, ...atLine(9) }),
        makeFinding({ id: 'w1', rule: 'no-eval', severity: 'error', ...inWeb, ...atLine(1) }),
        makeFinding({ id: 'w2', rule: 'no-eval', severity: 'error', ...inWeb, ...atLine(9) }),
        makeFinding({ id: 'w3', rule: 'no-eval', severity: 'error', ...inWeb, ...atLine(17) }),
        makeFinding({
          id: 'd',
          category: 'dead-code',
          tool: 'knip',
          rule: 'knip/unused-exports',
          ...inWeb,
          ...atLine(25),
        }),
      ],
    })
    const tasks = buildAgentTasks(report)
    expect(tasks.map((task) => [task.project, task.category, task.gradeImpact])).toEqual([
      ['packages/api', 'lint', 'lint · F → A'],
      ['packages/web', 'dead-code', 'dead code · F → A'],
      ['packages/web', 'lint', 'lint · A → A'],
    ])
  })
})

/** One high-severity bandit finding's identity. */
function bandit(rule: string): Partial<Finding> {
  return { category: 'security', tool: 'bandit', rule, severity: 'error' }
}

/**
 * What earns a place in the list, now that a grade no longer decides it.
 *
 * A finding is *eligible* when it counted toward a grade, or when it is
 * advisory and `related` links it to a graded finding at the same place — a
 * default config's opinion standing alone is not work anyone asked for. A theme
 * survives when an eligible finding of its lands in a file somebody wrote: not a
 * manifest, not generated. Dependency work is the exception that proves it — its
 * file is always a manifest, so what decides it is whether a fixed version to
 * upgrade to exists at all.
 */
describe('what counts as a task', () => {
  it('makes a task of a graded finding in a category already graded A', () => {
    const report = makeReport({
      categories: allGraded(),
      findings: [makeFinding({ id: 'a' })],
    })
    expect(buildAgentTasks(report).map((task) => [task.category, task.gradeImpact])).toEqual([
      ['lint', 'lint · A → A'],
    ])
  })

  /**
   * The category is an A: jscpd measured the tree and found nothing worth a
   * letter, so the clone it still reports is a default config's opinion nobody
   * asked for — the noise this rule exists to keep out of the list.
   */
  it('leaves an advisory finding nothing else answers for out of the list', () => {
    const report = duplicationGraded('A', [clone('src/a.ts')])
    expect(report.advisories).toHaveLength(1)
    expect(buildAgentTasks(report)).toEqual([])
  })

  /**
   * The letter is the other way an advisory row is work. Duplication grades on
   * jscpd's token percentage, so *every* duplication finding is advisory — a D
   * or an F with no graded finding under it would otherwise be a grade with
   * nothing in the list to move it, which is the one thing `agent.md` must never
   * print.
   */
  it.each(['D', 'F'] as const)('makes a task of the clones a duplication %s rests on', (grade) => {
    const report = duplicationGraded(grade, [clone('src/a.ts')])

    expect(report.findings).toEqual([])
    expect(buildAgentTasks(report).map((task) => [task.category, task.gradeImpact])).toEqual([
      ['duplication', `duplication · ${grade} → A`],
    ])
  })

  /**
   * The discriminator for the rule above: what makes those clones work is a
   * measurement nobody's graded finding is under. A category graded worse than A
   * *because of graded findings* says nothing about its advisory rows — the
   * dependency case, where the plan wants the advisory ones suppressed however
   * bad the letter is.
   */
  it('leaves an advisory dependency out of a security grade its graded findings made', () => {
    const report = makeReport({
      categories: { ...allGraded(), security: { status: 'graded', grade: 'D' } },
      findings: [
        makeFinding({ id: 's', category: 'security', tool: 'bandit', rule: 'B602', file: 'a.py' }),
        devScopedDependency(),
      ],
    })

    expect(buildAgentTasks(report).map((task) => task.category)).toEqual(['security'])
    expect(buildAgentTasks(report)[0]?.findings.map((finding) => finding.rule)).toEqual(['B602'])
  })

  /**
   * The cross-link is what makes an advisory row work: a graded finding at the
   * same place says somebody has to open that file anyway.
   */
  it('keeps an advisory finding a graded one answers for at the same place', () => {
    const report = makeReport({
      categories: allGraded(),
      findings: [clone('src/a.ts'), makeFinding({ id: 'l', file: 'src/a.ts' })],
    })
    expect(report.advisories[0]?.related).toEqual(['l'])
    // The same place, so the two are one task — and the clone is in it.
    expect(buildAgentTasks(report).map((task) => task.findings.map((f) => f.rule))).toEqual([
      ['jscpd/duplicate-block', 'no-unused-vars'],
    ])
  })

  /**
   * Two advisory findings at one place answer only for each other, and neither
   * is a graded finding somebody has to open the file for — so the cross-link
   * carries nothing and, with both categories at A, the pair stays out.
   */
  it('leaves two advisory findings that answer only for each other out of the list', () => {
    const report = makeReport({
      categories: allGraded(),
      findings: [clone('src/a.ts'), advisoryComplexity('src/a.ts')],
    })
    // The links exist; what they link to is the point.
    expect(report.advisories.map((row) => row.related)).toEqual([['cx'], ['dup-src/a.ts']])
    expect(buildAgentTasks(report)).toEqual([])
  })

  it('leaves a theme whose only eligible finding is in generated code out', () => {
    for (const file of ['gen/api.ts', 'src/gen/api.ts', 'src/api.gen.ts']) {
      expect(buildAgentTasks(lintIn(file))).toEqual([])
    }
  })

  /** The repo's own configs say which trees it generates; R2-T6 reads them. */
  it('leaves a theme in a file the repo’s own configs exclude out', () => {
    expect(buildAgentTasks(lintIn('build/api.ts'), undefined, ['build/**'])).toEqual([])
    expect(buildAgentTasks(lintIn('packages/web/dist/a.ts'), undefined, ['**/dist/**'])).toEqual([])
  })

  /** A pattern the translation cannot carry over must not hide a finding. */
  it('keeps a theme whose file only matches an exclude it cannot read', () => {
    expect(buildAgentTasks(lintIn('build/api.ts'), undefined, ['bui[l]d/**'])).toHaveLength(1)
  })

  it('keeps a theme with one hand-written file among generated ones', () => {
    const report = makeReport({
      categories: allGraded(),
      findings: [
        makeFinding({ id: 'g', file: 'src/api.gen.ts' }),
        makeFinding({ id: 'h', file: 'src/api.ts' }),
      ],
    })
    expect(buildAgentTasks(report)[0]?.findings.map((finding) => finding.file)).toEqual([
      'src/api.gen.ts',
      'src/api.ts',
    ])
  })

  it('leaves a vulnerable dependency no released version fixes out', () => {
    expect(buildAgentTasks(vulnerable(undefined))).toEqual([])
    expect(buildAgentTasks(vulnerable('4.17.21')).map((task) => task.title)).toEqual([
      'Upgrade 1 vulnerable dependency in `package-lock.json`',
    ])
  })
})

/**
 * Two categories can answer for the same place — `related` is the report's own
 * record of it — and two tasks over one line is the same sitting read twice.
 * They merge into one, under the category spec §10 ranks first, and the absorbed
 * rows are listed under it so nothing about the place goes missing.
 */
describe('cross-category duplicates', () => {
  const HERE = { file: 'src/a.ts', range: { startLine: 4, startCol: 1, endLine: 6, endCol: 1 } }

  it('merges two themes that answer for the same places into one task', () => {
    const report = makeReport({
      categories: allGraded(),
      findings: [
        makeFinding({ id: 'lint', ...HERE }),
        makeFinding({ id: 'type', category: 'types', tool: 'tsc', rule: 'TS2322', ...HERE }),
      ],
    })
    const tasks = buildAgentTasks(report)
    expect(tasks.map((task) => [task.category, task.title])).toEqual([
      ['types', 'Fix 1 `TS2322` type error, and 1 finding in lint at the same place'],
    ])
    // The lint row is under it, not lost: the place has two things wrong with it.
    expect(tasks[0]?.findings.map((finding) => finding.rule)).toEqual(['TS2322', 'no-unused-vars'])
  })

  /**
   * Overlap is not duplication. A theme spread over places another theme only
   * meets at one of them is its own work, and folding it in would hide the rest.
   */
  it('keeps two themes that only meet at one place apart', () => {
    const report = makeReport({
      categories: allGraded(),
      findings: [
        makeFinding({ id: 'lint-here', ...HERE }),
        makeFinding({ id: 'lint-there', file: 'src/b.ts' }),
        makeFinding({ id: 'type', category: 'types', tool: 'tsc', rule: 'TS2322', ...HERE }),
      ],
    })
    expect(buildAgentTasks(report).map((task) => task.category)).toEqual(['types', 'lint'])
  })

  /** Two packages are two sittings under two configs, whatever the line numbers. */
  it('never merges across projects', () => {
    const report = makeReport({
      categories: allGraded(),
      projects: [
        makeProjectScan({ project: projectAt('packages/api'), categories: allGraded() }),
        makeProjectScan({ project: projectAt('packages/web'), categories: allGraded() }),
      ],
      findings: [
        makeFinding({ id: 'w', file: 'packages/web/src/a.ts', project: 'packages/web' }),
        makeFinding({
          id: 'a',
          category: 'types',
          tool: 'tsc',
          rule: 'TS2322',
          file: 'packages/web/src/a.ts',
          project: 'packages/api',
        }),
      ],
    })
    expect(buildAgentTasks(report).map((task) => [task.project, task.category])).toEqual([
      ['packages/api', 'types'],
      ['packages/web', 'lint'],
    ])
  })
})

/** A one-line range, so two findings in one file are two places. */
function atLine(line: number): Pick<Finding, 'range'> {
  return { range: { startLine: line, startCol: 1, endLine: line, endCol: 2 } }
}

/** A jscpd clone: reported so a reader knows where, never counted (spec §3). */
function clone(file: string): Finding {
  return makeFinding({
    id: `dup-${file}`,
    category: 'duplication',
    tool: 'jscpd',
    rule: 'jscpd/duplicate-block',
    gradeScope: false,
    file,
  })
}

/** One advisory complexity finding, in the file the test is about. */
function advisoryComplexity(file: string): Finding {
  return makeFinding({
    id: 'cx',
    category: 'complexity',
    tool: 'fallow-health',
    rule: 'fallow/complexity',
    gradeScope: false,
    file,
  })
}

/**
 * A report whose duplication letter is jscpd's, with the clones behind it — the
 * shape every duplication grade has, since none of its findings is graded and
 * the percentage is the tool's own.
 */
function duplicationGraded(grade: Grade, findings: readonly Finding[]): Report {
  return makeReport({
    categories: { ...allGraded(), duplication: { status: 'graded', grade } },
    metrics: { ...noMetrics(), duplication: { duplicationPercent: grade === 'A' ? 0 : 47 } },
    findings: [...findings],
  })
}

/** A vulnerable dev dependency: advisory, with a released fix to upgrade to. */
function devScopedDependency(): Finding {
  return makeFinding({
    id: 'dev-osv',
    category: 'security',
    tool: OSV_SCANNER_TOOL,
    rule: 'osv/package',
    severity: 'error',
    gradeScope: false,
    file: 'package-lock.json',
    package: { name: 'vite', version: '4.0.0', ecosystem: 'npm' },
    packageAdvisories: [
      {
        id: 'GHSA-0000-0000-0002',
        aliases: [],
        severity: 'error',
        summary: 'dev server path traversal',
        fixedIn: '4.5.3',
        scope: 'dev',
      },
    ],
  })
}

/** One graded lint finding, in the file the test is about. */
function lintIn(file: string): Report {
  return makeReport({ categories: allGraded(), findings: [makeFinding({ id: 'a', file })] })
}

/** A vulnerable dependency, with or without a version to upgrade to. */
function vulnerable(fixedIn: string | undefined): Report {
  return makeReport({
    categories: { ...allGraded(), security: { status: 'graded', grade: 'D' } },
    findings: [
      makeFinding({
        id: 'osv',
        category: 'security',
        tool: OSV_SCANNER_TOOL,
        rule: 'GHSA-0000-0000-0001',
        severity: 'error',
        file: 'package-lock.json',
        package: { name: 'lodash', version: '4.17.15', ecosystem: 'npm' },
        packageAdvisories: [
          {
            id: 'GHSA-0000-0000-0001',
            aliases: [],
            severity: 'error',
            summary: 'prototype pollution',
            ...(fixedIn === undefined ? {} : { fixedIn }),
          },
        ],
      }),
    ],
  })
}

describe('themed grouping', () => {
  /** Spec §10: "Remove 14 dead exports" is one task, not fourteen. */
  it('collapses fourteen unused exports into one task with a file list', () => {
    const report = makeReport({
      categories: { ...allGraded(), 'dead-code': { status: 'graded', grade: 'F' } },
      findings: Array.from({ length: 14 }, (_, index) =>
        makeFinding({
          id: `d${index}`,
          category: 'dead-code',
          // Two tools, one kind of work: fallow and knip name the rule differently.
          tool: index % 2 === 0 ? 'fallow-dead-code' : 'knip',
          rule: index % 2 === 0 ? 'fallow/unused-export' : 'knip/unused-exports',
          file: `src/f${index}.ts`,
          message: 'Export `subtract` is never used',
        }),
      ),
    })

    const tasks = buildAgentTasks(report)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.title).toBe('Remove 14 unused exports')
    expect(tasks[0]?.findings).toHaveLength(14)

    const markdown = renderAgentMarkdown(report)
    expect(markdown).toContain('14 findings across 14 files:')
    expect(markdown).toContain('- `src/f0.ts` (1 finding)')
  })

  it('keeps different kinds of dead code apart', () => {
    const report = makeReport({
      categories: { ...allGraded(), 'dead-code': { status: 'graded', grade: 'F' } },
      findings: [
        makeFinding({ id: '1', category: 'dead-code', rule: 'knip/unused-files' }),
        makeFinding({ id: '2', category: 'dead-code', rule: 'knip/unused-dependencies' }),
        makeFinding({ id: '3', category: 'dead-code', rule: 'vulture/unused-import' }),
      ],
    })
    expect(buildAgentTasks(report).map((task) => task.title)).toEqual([
      'Remove 1 unused dependency',
      'Remove 1 unused file',
      'Remove 1 unused import',
    ])
  })

  it('makes formatting one sweep and complexity one list', () => {
    const report = makeReport({
      categories: {
        ...allGraded(),
        format: { status: 'graded', grade: 'D' },
        complexity: { status: 'graded', grade: 'D' },
      },
      findings: [
        ...['a', 'b', 'c'].map((name) =>
          makeFinding({
            id: `f${name}`,
            category: 'format',
            tool: 'prettier',
            rule: 'prettier/format',
            file: `src/${name}.ts`,
          }),
        ),
        ...['x', 'y'].map((name) =>
          makeFinding({
            id: `c${name}`,
            category: 'complexity',
            tool: 'fallow-health',
            rule: 'fallow/complexity',
            file: `src/${name}.ts`,
          }),
        ),
      ],
    })
    expect(buildAgentTasks(report).map((task) => task.title)).toEqual([
      'Reduce the complexity of 2 functions',
      'Format 3 files',
    ])
  })
})

/**
 * Security groups by the rule that reported it — a `shell=True` and an unpinned
 * action are not the same piece of work — except for the vulnerability scanner,
 * where the rule is an advisory id and the work is the lockfile: twenty CVEs in
 * one `pnpm-lock.yaml` are one upgrade sitting, and twenty tasks would fill the
 * cap with a single file.
 */
describe('security themes', () => {
  it('makes one task of a lockfile’s CVEs and leaves the other tools split by rule', () => {
    const tasks = securityTasks([
      ...Array.from({ length: 20 }, (_, index) => cve(index)),
      makeFinding({ id: '1', category: 'security', tool: 'bandit', rule: 'B602' }),
      makeFinding({ id: '2', category: 'security', tool: 'bandit', rule: 'B602' }),
      makeFinding({ id: '3', category: 'security', tool: 'zizmor', rule: 'artipacked' }),
    ])
    expect(tasks).toHaveLength(3)
    expect(tasks.map((task) => task.findings.length)).toEqual([20, 2, 1])
    // The two non-osv titles are the ones this repo has always emitted.
    expect(tasks.map((task) => task.title)).toEqual([
      'Upgrade 20 vulnerable dependencies in `pnpm-lock.yaml`',
      'Fix 2 `B602` findings reported by bandit',
      'Fix 1 `artipacked` finding reported by zizmor',
    ])
  })

  /** The same advisory in two lockfiles is two upgrades, in two files. */
  it('keeps one CVE in two lockfiles as two tasks', () => {
    const other = 'packages/api/package-lock.json'
    const tasks = securityTasks([
      { ...cve(7), id: 'here' },
      { ...cve(7, other), id: 'there', file: other },
    ])
    expect(tasks.map((task) => task.title)).toEqual([
      'Upgrade 1 vulnerable dependency in `packages/api/package-lock.json`',
      'Upgrade 1 vulnerable dependency in `pnpm-lock.yaml`',
    ])
    expect(tasks.map((task) => task.findings.length)).toEqual([1, 1])
  })

  /**
   * Only security reads the tool: every other category keys on what makes two of
   * its findings the same work, and one of them is the rule.
   */
  it('leaves every other category’s grouping alone', () => {
    const report = makeReport({
      categories: { ...allGraded(), lint: { status: 'graded', grade: 'F' } },
      findings: [
        makeFinding({ id: 'l1', tool: OSV_SCANNER_TOOL, file: 'src/a.ts' }),
        makeFinding({ id: 'l2', tool: OSV_SCANNER_TOOL, file: 'src/b.ts' }),
      ],
    })
    expect(buildAgentTasks(report).map((task) => task.title)).toEqual([
      'Fix 2 `no-unused-vars` findings',
    ])
  })
})

const LOCKFILE = 'pnpm-lock.yaml'

/** A vulnerability in `file`, with its own advisory id. */
function cve(index: number, file: string = LOCKFILE): Finding {
  return makeFinding({
    id: `osv-${file}-${index}`,
    category: 'security',
    tool: OSV_SCANNER_TOOL,
    rule: `GHSA-0000-0000-${String(index).padStart(4, '0')}`,
    file,
  })
}

/** The security tasks of a report whose security category has work in it. */
function securityTasks(findings: readonly Finding[]): AgentTask[] {
  const report = makeReport({
    categories: { ...allGraded(), security: { status: 'graded', grade: 'D' } },
    findings,
  })
  return buildAgentTasks(report).filter((task) => task.category === 'security')
}

/**
 * The cap is twenty tasks, and *which* twenty is not the emission order's to
 * decide. Spec §10's category order is fixed, so a chatty category near the top
 * would otherwise spend every slot and a category graded F further down would
 * get a plan with nothing about it in it. The budget is a round robin instead:
 * every category that produced work contributes one task before any contributes
 * a second, worst-graded category first.
 */
describe('the task budget', () => {
  it('stops at twenty tasks, spending them worst-graded category first', () => {
    const report = skewedGrades()
    expect(buildAgentTasks(report)).toHaveLength(30)

    const kept = kinds(renderAgentMarkdown(report))
    expect(kept).toHaveLength(MAX_TASKS)
    // All of the F category and all of the D one; the C category takes the rest.
    expect(kept.filter((kind) => kind === 'types')).toHaveLength(3)
    expect(kept.filter((kind) => kind === 'security')).toHaveLength(2)
    expect(kept.filter((kind) => kind === 'lint')).toHaveLength(15)
  })

  /**
   * Round one, one slot at a time: types (F) before security (D) before lint
   * (C). What comes back is still in emission order — security is rendered
   * above types — so the round order is only visible in what survives a cut.
   */
  it('gives each category a task before any category gets a second', () => {
    const report = skewedGrades()
    expect(kinds(renderAgentMarkdown(report, { maxTasks: 1 }))).toEqual(['types'])
    expect(kinds(renderAgentMarkdown(report, { maxTasks: 2 }))).toEqual(['security', 'types'])
    expect(kinds(renderAgentMarkdown(report, { maxTasks: 3 }))).toEqual([
      'security',
      'types',
      'lint',
    ])
  })

  /**
   * A rollup state is not always a letter: a package graded F in a category the
   * rollup could not assess at all still has work in it, and `not-assessed` and
   * `error` have no grade to rank them by. They go after every graded category,
   * in the fixed category order.
   */
  it('rounds the categories with no rollup grade after the graded ones', () => {
    const report = ungradedRollup()
    expect(kinds(renderAgentMarkdown(report, { maxTasks: 1 }))).toEqual(['lint'])
    // security is `error`, types is `not-assessed`: the tie is categoryRank's.
    expect(kinds(renderAgentMarkdown(report, { maxTasks: 2 }))).toEqual(['security', 'lint'])
    expect(kinds(renderAgentMarkdown(report, { maxTasks: 3 }))).toEqual([
      'security',
      'types',
      'lint',
    ])
  })

  /** Eight categories, twenty slots: the first round always completes. */
  it('gives every failing category a task when every category is failing', () => {
    const markdown = renderAgentMarkdown(everyCategoryFailing(), { maxTasks: CATEGORIES.length })
    expect(headings(markdown)).toHaveLength(CATEGORIES.length)
    // Each category's first theme is the one holding its `-first.ts` finding.
    for (const category of CATEGORIES) expect(markdown).toContain(`src/${category}-first.ts`)
  })

  /**
   * A cut leaves no hole. The survivors here are not a prefix — the last task
   * emitted is the first one chosen — so their pre-budget ordinals had a gap
   * in them, and those ordinals are only observable when nothing was cut.
   */
  it('renumbers the survivors T1…Tn', () => {
    const report = buriedFailure()
    expect(buildAgentTasks(report).at(-1)?.id).toBe('T41')
    expect(taskIds(renderAgentMarkdown(report))).toEqual(
      Array.from({ length: MAX_TASKS }, (_, index) => `T${index + 1}`),
    )
  })

  it('says how many tasks were cut', () => {
    const markdown = renderAgentMarkdown(manyLintRules(40))
    expect(headings(markdown)).toHaveLength(MAX_TASKS)
    expect(markdown).toContain('20 more tasks were cut to keep this list actionable.')
    expect(markdown).toContain('[report.json](report.json)')
  })

  it('says so plainly when there is nothing to do', () => {
    const markdown = renderAgentMarkdown(makeReport({ categories: allGraded() }))
    expect(headings(markdown)).toEqual([])
    expect(markdown).toContain('No tasks: nothing this scan found is work in hand-written code')
  })

  /**
   * A report with findings and no eligible ones among them says the same thing.
   * Naming a task there would be fabricating work out of rows the rule just
   * decided were not work.
   */
  it('fabricates no task for a report whose every finding is ineligible', () => {
    const markdown = renderAgentMarkdown(
      makeReport({
        categories: { ...allGraded(), duplication: { status: 'graded', grade: 'F' } },
        findings: [clone('src/a.ts'), clone('src/b.ts')],
      }),
    )
    expect(headings(markdown)).toEqual([])
    expect(markdown).toContain('No tasks: nothing this scan found is work in hand-written code')
    expect(markdown).toContain('Full findings (2)')
  })
})

describe('each task', () => {
  const tasks = buildAgentTasks(everyCategoryFailing())

  /** The point of the Verify line: it has to be a command that actually runs. */
  it('carries a Verify command crank-health’s own parser accepts', () => {
    for (const task of tasks) {
      const options = parseCliArgs(task.verify)
      expect(options.only).toEqual([task.category])
      expect(options.failUnder).toBe('A')
      expect(options.path).toBe('.')
    }
  })

  /**
   * Test quality only exists in the deep profile: quick reports it
   * `not assessed`, and `--fail-under A` counts that as a failure. Without
   * `--deep` the Verify line could never pass, however good the work was.
   */
  it('verifies test-quality work in the profile that assesses it', () => {
    for (const task of tasks) {
      expect(parseCliArgs(task.verify).deep).toBe(task.category === 'test-quality')
    }
    expect(tasks.some((task) => task.category === 'test-quality')).toBe(true)
  })

  it('links the raw evidence of the tools that reported its findings', () => {
    const report = makeReport({
      categories: { ...allGraded(), lint: { status: 'graded', grade: 'F' } },
      findings: [makeFinding({ id: 'a', project: '.' })],
      runs: [lintRun('.', ['raw/root/oxlint.sarif.json'])],
    })
    expect(buildAgentTasks(report)[0]?.evidence).toEqual(['raw/root/oxlint.sarif.json'])
    expect(renderAgentMarkdown(report)).toContain(
      'Evidence: [raw/root/oxlint.sarif.json](raw/root/oxlint.sarif.json)',
    )
  })

  /**
   * The same tool ran in both packages, so its name does not identify a run. An
   * agent sent to `packages/web`'s raw output to explain a finding in
   * `packages/api` would be reading a different config's verdict on different
   * files — and the two runs' raw files are nested apart precisely so that
   * cannot happen.
   */
  it('links each project’s own raw output, not a sibling’s', () => {
    const report = makeReport({
      categories: { ...allGraded(), lint: { status: 'graded', grade: 'F' } },
      projects: [
        makeProjectScan({ project: projectAt('packages/api'), categories: allGraded('F') }),
        makeProjectScan({ project: projectAt('packages/web'), categories: allGraded('F') }),
      ],
      findings: [
        makeFinding({ id: 'a', file: 'packages/api/api/main.py', project: 'packages/api' }),
        makeFinding({ id: 'w', file: 'packages/web/src/a.ts', project: 'packages/web' }),
      ],
      runs: [
        lintRun('packages/api', ['raw/packages_api/oxlint.sarif.json']),
        lintRun('packages/web', ['raw/packages_web/oxlint.sarif.json']),
      ],
    })
    expect(buildAgentTasks(report).map((task) => [task.project, task.evidence])).toEqual([
      ['packages/api', ['raw/packages_api/oxlint.sarif.json']],
      ['packages/web', ['raw/packages_web/oxlint.sarif.json']],
    ])
  })

  /**
   * A repo-spanning run has no project to match, and its findings are attributed
   * to whichever package they landed in — so the repo-wide record is the
   * fallback, or a secret would be reported with no evidence behind it.
   */
  it('falls back to a repo-spanning run’s evidence', () => {
    const report = makeReport({
      categories: { ...allGraded(), security: { status: 'graded', grade: 'F' } },
      findings: [
        makeFinding({
          id: 's',
          category: 'security',
          tool: 'gitleaks',
          rule: 'generic-api-key',
          severity: 'critical',
          file: 'packages/web/.env',
          project: 'packages/web',
        }),
      ],
      runs: [{ record: spanningRecord('gitleaks', 'security'), raw: ['raw/repo/gitleaks.json'] }],
    })
    expect(buildAgentTasks(report)[0]?.evidence).toEqual(['raw/repo/gitleaks.json'])
  })

  /**
   * Twenty CVEs in one lockfile are twenty upgrades to make. Collapsing them to
   * `- \`pnpm-lock.yaml\` (20 findings)` repeats the file the task title already
   * names and hides every advisory id the agent has to look up, so a task whose
   * findings share one file lists the findings however many there are.
   */
  it('lists a single file’s findings inline however many there are', () => {
    const markdown = renderAgentMarkdown(lockfileCves(20))
    expect(markdown).toContain('- `pnpm-lock.yaml:1` `GHSA-0000-0000-0000` — unused variable')
    expect(markdown).not.toContain('- `pnpm-lock.yaml` (20 findings)')
    expect(markdown).not.toContain('20 findings across 1 file:')
  })

  /**
   * An inline list defers to `report.json` at the same length a file list does,
   * with a sentence that counts what it left out: the file-worded one would be
   * a lie under a list of findings.
   */
  it('caps an inline list at fifteen findings and says how many it left out', () => {
    const capped = renderAgentMarkdown(lockfileCves(20))
    expect(inlineFindings(capped)).toHaveLength(15)
    expect(capped).toContain('- … 5 more findings in `report.json`.')
    expect(capped).not.toContain('`GHSA-0000-0000-0015`')

    const short = renderAgentMarkdown(lockfileCves(8))
    expect(inlineFindings(short)).toHaveLength(8)
    expect(short).not.toContain('more findings in `report.json`')
  })

  /**
   * A long task spread over files is still a list of files: the count per file
   * is what says where the work is concentrated, and past fifteen files the
   * sentence counts the files it left out.
   */
  it('counts per file when a long task spans more than one, and defers past fifteen', () => {
    const perFile = { a: 3, b: 2, c: 2, d: 2, e: 1, f: 1, g: 1, h: 1, i: 1 }
    const nine = renderAgentMarkdown(
      unusedExports(
        Object.entries(perFile).flatMap(([name, count]) =>
          Array.from({ length: count }, () => `src/${name}.ts`),
        ),
      ),
    )
    expect(nine).toContain('14 findings across 9 files:')
    expect(nine).toContain('- `src/a.ts` (3 findings)')
    expect(nine).toContain('- `src/e.ts` (1 finding)')
    expect(nine).not.toContain('more files in `report.json`')

    const twenty = renderAgentMarkdown(
      unusedExports(Array.from({ length: 20 }, (_, index) => `src/f${String(index)}.ts`)),
    )
    expect(twenty).toContain('20 findings across 20 files:')
    expect(fileRows(twenty)).toHaveLength(15)
    expect(twenty).toContain('- … 5 more files in `report.json`.')
  })
})

/**
 * `Grade impact:` and `Verify:` are what a task is checked against, so every
 * task carries both. They used to be stated once per run of consecutive tasks
 * that agreed on them — three fewer lines, at the cost of a heading an agent can
 * act on without scrolling for the command that proves it done. A task that has
 * to be read together with the one above it is not a task.
 */
describe('the two lines on every task', () => {
  it('states the grade impact and the verify command under each task', () => {
    const markdown = renderAgentMarkdown(manyLintRules(3))
    expect(headings(markdown)).toHaveLength(3)
    expect(tasksSection(markdown)).toBe(
      [
        '### T1 — Fix 1 `rule-00` finding',
        '',
        'Grade impact: lint · F → A',
        '',
        '- `src/a.ts:1` `rule-00` — unused variable',
        '',
        'Verify: `npx crank-health --only lint --fail-under A`',
        '',
        '### T2 — Fix 1 `rule-01` finding',
        '',
        'Grade impact: lint · F → A',
        '',
        '- `src/a.ts:1` `rule-01` — unused variable',
        '',
        'Verify: `npx crank-health --only lint --fail-under A`',
        '',
        '### T3 — Fix 1 `rule-02` finding',
        '',
        'Grade impact: lint · F → A',
        '',
        '- `src/a.ts:1` `rule-02` — unused variable',
        '',
        'Verify: `npx crank-health --only lint --fail-under A`',
      ].join('\n'),
    )
  })

  /** The brief's monorepo shape: neither line survives being shared. */
  it('shares neither line between two packages', () => {
    const markdown = renderAgentMarkdown(twoLintPackages('C', 'F'))
    expect(headings(markdown)).toHaveLength(2)
    expect(boilerplate(markdown, 'Grade impact:')).toEqual([
      'Grade impact: lint · C → A',
      'Grade impact: lint · F → A',
    ])
    expect(boilerplate(markdown, 'Verify:')).toEqual([
      'Verify: `npx crank-health --only lint --project packages/api --fail-under A`',
      'Verify: `npx crank-health --only lint --project packages/web --fail-under A`',
    ])
  })

  /**
   * Each field of the run key on its own. The verify command differs while the
   * grade impact reads the same in both packages: one field, and the run breaks.
   */
  it('states two identical grade impacts where two packages hold the same grade', () => {
    const markdown = renderAgentMarkdown(twoLintPackages('F', 'F'))
    expect(boilerplate(markdown, 'Grade impact:')).toEqual([
      'Grade impact: lint · F → A',
      'Grade impact: lint · F → A',
    ])
    expect(boilerplate(markdown, 'Verify:')).toEqual([
      'Verify: `npx crank-health --only lint --project packages/api --fail-under A`',
      'Verify: `npx crank-health --only lint --project packages/web --fail-under A`',
    ])
  })

  /** Two categories differ in both lines, and each task says its own. */
  it('states each category’s own pair', () => {
    const report = makeReport({
      categories: {
        ...allGraded(),
        'dead-code': { status: 'graded', grade: 'F' },
        lint: { status: 'graded', grade: 'F' },
      },
      findings: [
        makeFinding({
          id: 'd',
          category: 'dead-code',
          tool: 'knip',
          rule: 'knip/unused-exports',
          file: 'src/dead.ts',
        }),
        makeFinding({ id: 'l' }),
      ],
    })
    const markdown = renderAgentMarkdown(report)
    expect(headings(markdown)).toHaveLength(2)
    expect(boilerplate(markdown, 'Grade impact:')).toEqual([
      'Grade impact: dead code · F → A',
      'Grade impact: lint · F → A',
    ])
    expect(boilerplate(markdown, 'Verify:')).toEqual([
      'Verify: `npx crank-health --only dead-code --fail-under A`',
      'Verify: `npx crank-health --only lint --fail-under A`',
    ])
  })
})

/** Two packages breaking one lint rule, each graded in its own right. */
function twoLintPackages(api: Grade, web: Grade): Report {
  return makeReport({
    categories: { ...allGraded(), lint: { status: 'graded', grade: 'F' } },
    projects: [
      makeProjectScan({ project: projectAt('packages/api'), categories: allGraded(api) }),
      makeProjectScan({ project: projectAt('packages/web'), categories: allGraded(web) }),
    ],
    findings: [
      makeFinding({ id: 'a', file: 'packages/api/api/main.py', project: 'packages/api' }),
      makeFinding({ id: 'w', file: 'packages/web/src/a.ts', project: 'packages/web' }),
    ],
  })
}

/** A dead-code report with one unused-export finding per entry in `files`. */
function unusedExports(files: readonly string[]): Report {
  return makeReport({
    categories: { ...allGraded(), 'dead-code': { status: 'graded', grade: 'F' } },
    findings: files.map((file, index) =>
      makeFinding({
        id: `d${index}`,
        category: 'dead-code',
        tool: 'knip',
        rule: 'knip/unused-exports',
        file,
      }),
    ),
  })
}

/** The `- \`file\` (n findings)` rows a task rendered instead of its findings. */
function fileRows(markdown: string): string[] {
  return markdown.split('\n').filter((line) => /^- `[^`]+` \(\d+ findings?\)$/.test(line))
}

/** The `- \`file\` \`rule\` — message` lines a lockfile task rendered inline. */
function inlineFindings(markdown: string): string[] {
  return markdown.split('\n').filter((line) => line.startsWith(`- \`${LOCKFILE}:1\` \``))
}

/** A report whose one security task is `count` CVEs in the same lockfile. */
function lockfileCves(count: number): Report {
  return makeReport({
    categories: { ...allGraded(), security: { status: 'graded', grade: 'F' } },
    findings: Array.from({ length: count }, (_, index) => cve(index)),
  })
}

/** Task headings, which is how many tasks the rendered file actually has. */
function headings(markdown: string): string[] {
  return boilerplate(markdown, '### T')
}

/** Every line of the file that opens with `prefix`, in the order it reads. */
function boilerplate(markdown: string, prefix: string): string[] {
  return markdown.split('\n').filter((line) => line.startsWith(prefix))
}

/** The `## Tasks` section alone — the header and footer are not this task's. */
function tasksSection(markdown: string): string {
  return /## Tasks\n\n(?<tasks>[\s\S]*)\n\n---\n/.exec(markdown)?.groups?.['tasks'] ?? markdown
}

/** The id each rendered task carries, in the order the file lists them. */
function taskIds(markdown: string): string[] {
  return headings(markdown).map((heading) => /^### (T\d+) /.exec(heading)?.[1] ?? heading)
}

/**
 * The category each rendered task belongs to, read off the title the category
 * gives it — which is all a reader of the file has to go on.
 */
function kinds(markdown: string): Category[] {
  return headings(markdown).map((heading) => {
    if (heading.includes('type error')) return 'types'
    if (heading.includes('reported by bandit')) return 'security'
    return 'lint'
  })
}

/** Two packages, one failing category, and the findings a test plants in them. */
function monorepo(findings: readonly Finding[]): Report {
  return makeReport({
    categories: { ...allGraded(), lint: { status: 'graded', grade: 'F' } },
    projects: [
      makeProjectScan({ project: projectAt('packages/web') }),
      makeProjectScan({ project: projectAt('packages/api') }),
    ],
    findings,
  })
}

/** A report where every category has work in it, each at a different grade. */
function everyCategoryFailing(): Report {
  const grades = { security: 'F', types: 'D', 'dead-code': 'C', complexity: 'B' } as const
  const categories = {} as Record<Category, CategoryState>
  for (const category of CATEGORIES) {
    categories[category] = {
      status: 'graded',
      grade: category in grades ? (grades[category as keyof typeof grades] ?? 'F') : 'F',
    }
  }
  const findings: Finding[] = CATEGORIES.flatMap((category, index) =>
    ['first', 'second'].map((which, rule) =>
      makeFinding({
        id: `${category}-${which}`,
        category,
        tool: `tool-${index}`,
        rule: `${category}-rule-${rule}`,
        severity: rule === 0 ? 'error' : 'warning',
        file: `src/${category}-${which}.ts`,
      }),
    ),
  )
  return makeReport({ categories, findings })
}

/** `count` lint rules, one finding each — more themes than the cap allows. */
function manyLintRules(count: number): Report {
  return makeReport({
    categories: { ...allGraded(), lint: { status: 'graded', grade: 'F' } },
    findings: Array.from({ length: count }, (_, index) =>
      makeFinding({ id: `r${index}`, rule: `rule-${String(index).padStart(2, '0')}` }),
    ),
  })
}

/**
 * The shape the budget exists for: the category with the most work is not the
 * category graded worst. Lint is `C` with twenty-five rules, types `F` with
 * three and security `D` with two — thirty themes for twenty slots.
 */
function skewedGrades(): Report {
  return makeReport({
    categories: {
      ...allGraded(),
      security: { status: 'graded', grade: 'D' },
      types: { status: 'graded', grade: 'F' },
      lint: { status: 'graded', grade: 'C' },
    },
    findings: [
      ...reportFindings(manyLintRules(25)),
      ...Array.from({ length: 3 }, (_, index) =>
        makeFinding({
          id: `t${index}`,
          category: 'types',
          tool: 'tsc',
          rule: `TS100${index}`,
          file: `src/t${index}.ts`,
        }),
      ),
      ...Array.from({ length: 2 }, (_, index) =>
        makeFinding({
          id: `s${index}`,
          category: 'security',
          tool: 'bandit',
          rule: `B60${index}`,
          file: `src/s${index}.py`,
        }),
      ),
    ],
  })
}

/**
 * Forty chatty security themes graded `B`, emitted ahead of the one lint theme
 * this repo is actually failing — the shape a plain truncation loses the F to,
 * and the one where the survivors are not the first twenty tasks emitted.
 */
function buriedFailure(): Report {
  return makeReport({
    categories: {
      ...allGraded(),
      security: { status: 'graded', grade: 'B' },
      lint: { status: 'graded', grade: 'F' },
    },
    findings: [
      ...Array.from({ length: 40 }, (_, index) =>
        makeFinding({
          id: `s${index}`,
          category: 'security',
          tool: 'bandit',
          rule: `B${String(index).padStart(3, '0')}`,
          file: `src/s${index}.py`,
        }),
      ),
      makeFinding({ id: 'l', rule: 'no-shadow' }),
    ],
  })
}

/**
 * A package failing three categories the rollup grades in three different ways:
 * one letter, one `error`, one `not-assessed`. Every one of them produces a
 * task, so the round order has to place all three states.
 */
function ungradedRollup(): Report {
  const inApi = { file: 'packages/api/api/main.py', project: 'packages/api' }
  return makeReport({
    categories: {
      ...allGraded(),
      security: { status: 'error', reason: 'bandit crashed' },
      types: { status: 'not-assessed', reason: 'no type checker ran' },
      lint: { status: 'graded', grade: 'F' },
    },
    projects: [
      makeProjectScan({ project: projectAt('packages/api'), categories: allGraded('F') }),
      makeProjectScan({ project: projectAt('packages/web'), categories: allGraded() }),
    ],
    findings: [
      makeFinding({ id: 'l', ...inApi, ...atLine(1) }),
      makeFinding({
        id: 's',
        category: 'security',
        tool: 'bandit',
        rule: 'B602',
        ...inApi,
        ...atLine(20),
      }),
      makeFinding({
        id: 't',
        category: 'types',
        tool: 'tsc',
        rule: 'TS1000',
        ...inApi,
        ...atLine(40),
      }),
    ],
  })
}

/**
 * A task in a monorepo has to say which package it is in: two packages break
 * the same rule under two configs, and the file paths are not an instruction.
 * A single-project repo has one answer and says it in the header, so its tasks
 * read exactly as they always have — which the goldens above hold to.
 */
describe('tasks in a monorepo', () => {
  const SAME_RULE = [
    makeFinding({ id: 'w', file: 'packages/web/src/a.ts', project: 'packages/web' }),
    makeFinding({ id: 'a', file: 'packages/api/api/main.py', project: 'packages/api' }),
  ]

  it('keeps one rule broken in two packages as two tasks, one per project', () => {
    const tasks = buildAgentTasks(monorepo(SAME_RULE))
    expect(tasks.map((task) => [task.project, task.title])).toEqual([
      ['packages/api', 'Fix 1 `no-unused-vars` finding'],
      ['packages/web', 'Fix 1 `no-unused-vars` finding'],
    ])
    expect(tasks.map((task) => task.findings.length)).toEqual([1, 1])
  })

  it('calls the root project the repo root', () => {
    const report = makeReport({
      categories: { ...allGraded(), lint: { status: 'graded', grade: 'F' } },
      projects: [
        makeProjectScan({ project: projectAt('packages/web') }),
        makeProjectScan({ project: makeProject(['package.json', 'src/a.ts']) }),
      ],
      findings: [makeFinding({ id: 'r', file: 'src/a.ts', project: '.' })],
    })
    expect(renderAgentMarkdown(report)).toContain('Project: repo root')
  })

  /**
   * A finding in an infra file under a workspace shell belongs to no project.
   * "Project: repo root" would name a project that is not in `projects[]` and
   * send the agent to a package the finding is not in.
   */
  it('names no project for a finding no project claims', () => {
    const report = makeReport({
      categories: { ...allGraded(), security: { status: 'graded', grade: 'F' } },
      projects: [
        makeProjectScan({ project: projectAt('packages/web') }),
        makeProjectScan({ project: projectAt('packages/api') }),
      ],
      findings: [
        makeFinding({
          id: 'ci',
          category: 'security',
          tool: 'zizmor',
          rule: 'unpinned-uses',
          file: '.github/workflows/ci.yml',
        }),
      ],
    })

    expect(buildAgentTasks(report).map((task) => task.project)).toEqual([undefined])
    expect(renderAgentMarkdown(report)).not.toContain('Project:')
  })
})

/** The rollup is fine; one small package is not. */
function skewedInput(): Partial<ReportInput> {
  return {
    categories: { ...allGraded(), lint: { status: 'graded', grade: 'A' } },
    projects: [
      makeProjectScan({
        project: projectAt('packages/api'),
        categories: { ...allGraded(), lint: { status: 'graded', grade: 'F' } },
      }),
      makeProjectScan({ project: projectAt('packages/web'), categories: allGraded() }),
    ],
    findings: [
      makeFinding({ id: 'api', file: 'packages/api/api/main.py', project: 'packages/api' }),
    ],
  }
}

function skewed(): Report {
  return makeReport(skewedInput())
}

/**
 * The rollup is one grade among several, and `--fail-under` gates all of them.
 * A file that selected, graded and verified off the rollup alone would say
 * "nothing to do" while CI is red naming a package.
 */
describe('tasks against per-project grades', () => {
  it('makes a task for a package graded below A under a rollup graded A', () => {
    const tasks = buildAgentTasks(skewed())
    expect(tasks.map((task) => [task.project, task.category])).toEqual([['packages/api', 'lint']])

    // The impact is that package's own grade, not the rollup's A…
    const task = tasks[0]
    expect(task?.gradeImpact).toBe('lint · F → A')

    // …and the check is scoped to it, so fixing the package is enough to pass.
    expect(task?.verify).toEqual([
      '--only',
      'lint',
      '--project',
      'packages/api',
      '--fail-under',
      'A',
    ])
    const options = parseCliArgs(task?.verify ?? [])
    expect(options.projects).toEqual(['packages/api'])
    expect(options.only).toEqual(['lint'])
    expect(options.failUnder).toBe('A')
  })

  /**
   * `not-assessed(repo-scoped)` means the repo holds this project's answer, so
   * the grade to move is the rollup's — and a `--project` check that can never
   * fail would be no check at all.
   */
  it('falls back to the rollup where the project has no grade of its own', () => {
    const report = makeReport({
      categories: { ...allGraded(), security: { status: 'graded', grade: 'F' } },
      projects: [
        makeProjectScan({
          project: projectAt('packages/api'),
          categories: {
            ...allGraded(),
            security: { status: 'not-assessed', reason: 'repo-scoped' },
          },
        }),
        makeProjectScan({ project: projectAt('packages/web'), categories: allGraded() }),
      ],
      findings: [
        makeFinding({
          id: 'secret',
          category: 'security',
          tool: 'gitleaks',
          rule: 'generic-api-key',
          severity: 'critical',
          file: 'packages/api/.env',
          project: 'packages/api',
        }),
      ],
    })

    const task = buildAgentTasks(report)[0]
    expect(task?.project).toBe('packages/api')
    expect(task?.gradeImpact).toBe('security · F → A')
    expect(task?.verify).not.toContain('--project')
  })

  /**
   * A repo-spanning scanner scans the whole tree under `--project` too — it must,
   * or a scoped run would miss the secret — so its findings from elsewhere are in
   * the rollup the gate also reads. A scoped check for such a category could stay
   * red however completely this package was fixed, so the check stays repo-wide.
   */
  it('does not scope the check for a category a repo-spanning scan answers', () => {
    const graded = { ...allGraded(), security: { status: 'graded', grade: 'F' } } as const
    const report = makeReport({
      categories: graded,
      projects: [
        makeProjectScan({ project: projectAt('packages/api'), categories: graded }),
        makeProjectScan({ project: projectAt('packages/web'), categories: allGraded() }),
      ],
      findings: [
        makeFinding({
          id: 'sast',
          category: 'security',
          tool: 'opengrep',
          rule: 'shell-injection',
          severity: 'error',
          file: 'packages/api/api/main.py',
          project: 'packages/api',
        }),
      ],
      runs: [
        { record: { ...spanningRecord('gitleaks', 'security') }, raw: [] },
        { record: { ...spanningRecord('opengrep', 'security'), repoWide: false }, raw: [] },
      ],
    })

    const task = buildAgentTasks(report)[0]
    // The package is graded F in its own right, so the task is its…
    expect(task?.project).toBe('packages/api')
    expect(task?.gradeImpact).toBe('security · F → A')
    // …but the command it can be checked with is the repo's.
    expect(task?.verify).toEqual(['--only', 'security', '--fail-under', 'A'])
  })

  it('still scopes a category no repo-spanning run touched', () => {
    const report = makeReport({
      ...skewedInput(),
      runs: [{ record: spanningRecord('gitleaks', 'security'), raw: [] }],
    })
    expect(buildAgentTasks(report)[0]?.verify).toContain('--project')
  })

  /**
   * The repo-wide duplication pass is not a repo-spanning *tool*: it runs beside
   * jscpd's per-project passes, and scoping to one project leaves that project's
   * own pass — which is what the task is about. Treating it like the secrets scan
   * would hand the agent a check it cannot satisfy either.
   */
  it('still scopes duplication, whose repo-wide pass sits beside per-project ones', () => {
    const graded = { ...allGraded(), duplication: { status: 'graded', grade: 'F' } } as const
    const report = makeReport({
      categories: allGraded(),
      projects: [
        makeProjectScan({ project: projectAt('packages/api'), categories: graded }),
        makeProjectScan({ project: projectAt('packages/web'), categories: allGraded() }),
      ],
      findings: [
        makeFinding({
          id: 'clone',
          category: 'duplication',
          tool: 'jscpd',
          rule: 'jscpd/duplicate-block',
          gradeScope: false,
          file: 'packages/api/api/main.py',
          project: 'packages/api',
        }),
        // The graded finding at the same place that makes the clone eligible.
        makeFinding({ id: 'lint', file: 'packages/api/api/main.py', project: 'packages/api' }),
      ],
      runs: [
        { record: spanningRecord('jscpd', 'duplication'), raw: [] },
        {
          record: {
            ...spanningRecord('jscpd', 'duplication'),
            repoWide: false,
            project: 'packages/api',
          },
          raw: [],
        },
      ],
    })

    expect(buildAgentTasks(report)[0]?.verify).toEqual([
      '--only',
      'duplication',
      '--project',
      'packages/api',
      '--fail-under',
      'A',
    ])
  })
})

/** One project's own lint run, with the raw output it left behind. */
function lintRun(project: string, raw: readonly string[]): ResolvedRun {
  return {
    record: {
      ...spanningRecord('oxlint', 'lint'),
      scope: 'js-ts',
      project,
      repoWide: false,
      pinnedVersion: '1.77.0',
    },
    raw,
  }
}

/** A run that spanned the repo, as `report.tools` records one. */
function spanningRecord(tool: string, category: Category): RunRecord {
  return {
    tool,
    category,
    scope: 'common',
    project: 'repo',
    repoWide: true,
    rollupOnly: false,
    pinnedVersion: '1.0.0',
    detection: null,
    result: { state: 'ok', findings: [], rawFiles: [] },
    durationMs: 1,
    standby: false,
  }
}
