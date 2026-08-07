import { describe, expect, it } from 'vitest'
import { parseCliArgs } from '../src/args.ts'
import type { Category, CategoryState, Finding } from '../src/core/types.ts'
import { CATEGORIES, categoryRank } from '../src/core/types.ts'
import type { RunRecord } from '../src/core/orchestrator.ts'
import type { AgentTask } from '../src/render/agent-md.ts'
import { MAX_TASKS, buildAgentTasks, renderAgentMarkdown } from '../src/render/agent-md.ts'
import type { Report, ReportInput, ResolvedRun } from '../src/render/json.ts'
import {
  allGraded,
  makeFinding,
  makeProject,
  makeProjectScan,
  makeReport,
  projectAt,
} from './factories.ts'
import { expectGolden, normalizeMarkdown, readGoldenReport } from './support/report.ts'

/**
 * `agent.md` is a contract (spec §10), not a document: an agent reads the task
 * list, works down it, and verifies each task with the command it was given. So
 * most of what follows asserts on {@link buildAgentTasks} — the same tasks the
 * renderer spells out — and the goldens cover the spelling.
 */

const FIXTURES = ['cs-basic', 'js-basic', 'mono-js', 'mono-mixed', 'py-basic', 'sec-basic'] as const

describe('agent.md goldens', () => {
  it.each(FIXTURES)('matches the golden agent.md for %s', async (name) => {
    const markdown = normalizeMarkdown(renderAgentMarkdown(await readGoldenReport(name)), '<repo>')
    await expectGolden(`${name}.agent.md`, markdown)
  })

  it('renders byte-identical output from the same report', async () => {
    const report = await readGoldenReport('sec-basic')
    expect(renderAgentMarkdown(report)).toBe(renderAgentMarkdown(report))
  })

  it('carries the header, the ground rules and the pointer to report.json', async () => {
    const markdown = renderAgentMarkdown(await readGoldenReport('sec-basic'))
    expect(markdown).toContain('crank-health 0.3.0 · quick profile')
    expect(markdown).toContain('Grades: security D · types A · dead code A')
    expect(markdown).toContain('## Ground rules')
    expect(markdown).toContain('[advisory]')
    expect(markdown).toContain('No wholesale reformatting')
    expect(markdown).toContain('Verify before you call a task done')
    expect(markdown).toContain('[report.json](report.json)')
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

  it('says nothing when the run had nothing to explain', async () => {
    const report = await readGoldenReport('sec-basic')
    expect(report.warnings).toEqual([])
    expect(renderAgentMarkdown(report)).not.toContain('How this run was graded')
  })
})

describe('task priority', () => {
  /**
   * Spec §10's order is fixed — security → types → dead code → complexity →
   * duplication → lint → format — so a category's own grade cannot move it up
   * the list. Inside a category, the heaviest findings come first.
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

  it('assigns sequential stable ids in emission order', () => {
    const tasks = buildAgentTasks(everyCategoryFailing())
    expect(tasks.map((task) => task.id)).toEqual(tasks.map((_, index) => `T${index + 1}`))
  })

  it('leaves alone the categories nothing can be done about', () => {
    const report = makeReport({
      categories: {
        ...allGraded(),
        // Graded A: done. Not assessed: nothing to work from.
        types: { status: 'not-assessed', reason: 'no type checker ran' },
        lint: { status: 'error', reason: 'oxlint crashed' },
      },
      findings: [
        makeFinding({ id: 'a', category: 'lint' }),
        makeFinding({ id: 'b', category: 'types' }),
        makeFinding({ id: 'c', category: 'dead-code' }),
      ],
    })
    expect(buildAgentTasks(report)).toEqual([])
  })
})

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

  it('splits security by the tool and rule that reported it', () => {
    const report = makeReport({
      categories: { ...allGraded(), security: { status: 'graded', grade: 'D' } },
      findings: [
        makeFinding({ id: '1', category: 'security', tool: 'bandit', rule: 'B602' }),
        makeFinding({ id: '2', category: 'security', tool: 'bandit', rule: 'B602' }),
        makeFinding({ id: '3', category: 'security', tool: 'zizmor', rule: 'artipacked' }),
      ],
    })
    expect(buildAgentTasks(report).map((task) => task.title)).toEqual([
      'Fix 2 `B602` findings reported by bandit',
      'Fix 1 `artipacked` finding reported by zizmor',
    ])
  })
})

describe('the task cap', () => {
  it('stops at twenty tasks and says how many were left out', () => {
    const report = manyLintRules(40)
    expect(buildAgentTasks(report)).toHaveLength(40)

    const markdown = renderAgentMarkdown(report)
    expect(headings(markdown)).toHaveLength(MAX_TASKS)
    expect(markdown).toContain('20 more tasks were cut to keep this list actionable.')
    expect(markdown).toContain('[report.json](report.json)')
  })

  it('says so plainly when there is nothing to do', () => {
    const markdown = renderAgentMarkdown(makeReport({ categories: allGraded() }))
    expect(headings(markdown)).toEqual([])
    expect(markdown).toContain('No tasks: every assessed category is graded A.')
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

  it('renders that command as a runnable npx invocation', () => {
    const markdown = renderAgentMarkdown(everyCategoryFailing())
    expect(markdown).toContain('Verify: `npx crank-health --only security --fail-under A`')
  })

  it('states the category-level grade impact', () => {
    for (const task of tasks) {
      expect(task.gradeImpact).toMatch(/^[a-z ]+ · [ABCDEF] → A$/)
    }
    expect(impactOf(tasks, 'security')).toBe('security · F → A')
    expect(impactOf(tasks, 'dead-code')).toBe('dead code · C → A')
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

  it('lists small tasks finding by finding, and labels the advisory ones', () => {
    const markdown = renderAgentMarkdown(
      makeReport({
        categories: { ...allGraded(), duplication: { status: 'graded', grade: 'F' } },
        findings: [
          makeFinding({
            id: 'a',
            category: 'duplication',
            tool: 'jscpd',
            rule: 'jscpd/duplicate-block',
            file: 'src/a.ts',
            range: { startLine: 5, startCol: 1, endLine: 9, endCol: 1 },
            message: '11 lines duplicated from src/b.ts:1-11',
            gradeScope: false,
          }),
        ],
      }),
    )
    expect(markdown).toContain(
      '- `src/a.ts:5` `jscpd/duplicate-block` — 11 lines duplicated from src/b.ts:1-11 [advisory]',
    )
  })
})

/** Task headings, which is how many tasks the rendered file actually has. */
function headings(markdown: string): string[] {
  return markdown.split('\n').filter((line) => line.startsWith('### T'))
}

function impactOf(tasks: readonly AgentTask[], category: Category): string | undefined {
  return tasks.find((task) => task.category === category)?.gradeImpact
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

  it('names the project in every rendered task', () => {
    const markdown = renderAgentMarkdown(monorepo(SAME_RULE))
    expect(markdown).toContain('### T1 — Fix 1 `no-unused-vars` finding\n\nProject: packages/api')
    expect(markdown).toContain('### T2 — Fix 1 `no-unused-vars` finding\n\nProject: packages/web')
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

  it('names no project when the repo is one project', () => {
    const single = makeReport({
      categories: { ...allGraded(), lint: { status: 'graded', grade: 'F' } },
      findings: [makeFinding({ id: 'a' })],
    })
    expect(single.projects).toHaveLength(1)
    expect(renderAgentMarkdown(single)).not.toContain('Project:')
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
    expect(buildAgentTasks(skewed()).map((task) => [task.project, task.category])).toEqual([
      ['packages/api', 'lint'],
    ])
  })

  it('states that package’s own grade as the impact, not the rollup’s', () => {
    expect(buildAgentTasks(skewed())[0]?.gradeImpact).toBe('lint · F → A')
  })

  it('verifies against the package, so fixing it is enough to pass', () => {
    const task = buildAgentTasks(skewed())[0]
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
