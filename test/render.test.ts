import { describe, expect, it } from 'vitest'
import type { RunRecord } from '../src/core/orchestrator.ts'
import { sortFindings } from '../src/core/orchestrator.ts'
import type { CategoryState, Finding } from '../src/core/types.ts'
import { CATEGORIES } from '../src/core/types.ts'
import { collapseToolRows, notSelectedNote, unselectedCategories } from '../src/render/display.ts'
import type { ReportTool } from '../src/render/json.ts'
import { buildReport, reportFindings, serializeReport } from '../src/render/json.ts'
import { renderTerminal } from '../src/render/terminal.ts'
import { REPO_SCOPED_REASON } from '../src/run.ts'
import {
  allGraded,
  allNotAssessed,
  makeFinding,
  makeProjectScan,
  makeReportInput,
  projectAt,
} from './factories.ts'
import { normalizeReport } from './support/report.ts'

const REPO_SCOPED: CategoryState = { status: 'not-assessed', reason: REPO_SCOPED_REASON }

describe('buildReport', () => {
  it('emits the top-level keys in a fixed order', () => {
    expect(Object.keys(buildReport(input()))).toEqual([
      'schemaVersion',
      'crankHealth',
      'repo',
      'profile',
      'mode',
      'selected',
      'categories',
      'metrics',
      'languages',
      'projects',
      'tools',
      'findings',
      'advisories',
      'warnings',
      'timings',
    ])
  })

  it('always reports all eight category states, in priority order', () => {
    const report = buildReport(input())
    expect(Object.keys(report.categories)).toEqual([...CATEGORIES])
    expect(report.categories.security).toEqual({
      status: 'not-assessed',
      reason: 'no tool available for this category',
    })
  })

  /**
   * `--only` is a rendering question, not a data one: the contract still
   * answers for all eight categories, and says which ones were asked about.
   */
  it('still reports all eight states under --only, and which were selected', () => {
    const report = buildReport(input({ selected: ['lint'] }))
    expect(Object.keys(report.categories)).toEqual([...CATEGORIES])
    expect(report.selected).toEqual(['lint'])
  })

  it('rebuilds findings with a fixed key order, whatever the adapter used', () => {
    const scrambled = {
      gradeScope: true,
      message: 'unused variable',
      id: 'aaaa',
      category: 'lint',
      range: { endCol: 2, endLine: 1, startCol: 1, startLine: 1 },
      provenance: 'default-config',
      severity: 'warning',
      file: 'src/a.ts',
      rule: 'no-unused-vars',
      tool: 'oxlint',
    } as unknown as Finding

    const [finding] = buildReport(input({ findings: [scrambled] })).findings
    expect(Object.keys(finding ?? {})).toEqual([
      'id',
      'category',
      'tool',
      'rule',
      'severity',
      'file',
      'range',
      'message',
      'provenance',
    ])
    expect(Object.keys(finding?.range ?? {})).toEqual([
      'startLine',
      'startCol',
      'endLine',
      'endCol',
    ])
  })

  /**
   * Schema 2's split. A `gradeScope` boolean on every row made a reader filter
   * before they could read: the graded rows are the report, and the advisory
   * ones are the second list under it.
   */
  it('splits graded findings from advisory ones, and drops the flag they repeated', () => {
    const graded = makeFinding({ id: 'aaaaaaaaaaaaaaaa', rule: 'no-debugger' })
    const advisory = makeFinding({ id: 'bbbbbbbbbbbbbbbb', rule: 'sort-keys', gradeScope: false })

    const report = buildReport(input({ findings: [graded, advisory] }))
    expect(report.findings.map((finding) => finding.rule)).toEqual(['no-debugger'])
    expect(report.advisories.map((finding) => finding.rule)).toEqual(['sort-keys'])
    expect(serializeReport(report)).not.toContain('gradeScope')
  })

  /**
   * The delta's lists are the one place membership cannot carry the flag: "what
   * this change added" is one question about both kinds of row.
   */
  it('flags advisory rows in the delta, which is not partitioned', () => {
    const graded = makeFinding({ id: 'aaaaaaaaaaaaaaaa', rule: 'no-debugger' })
    const advisory = makeFinding({ id: 'bbbbbbbbbbbbbbbb', rule: 'sort-keys', gradeScope: false })

    const report = buildReport(
      input({
        findings: [graded, advisory],
        delta: {
          baseRef: 'main',
          mergeBase: 'abc',
          newFindings: [
            { finding: graded, touchedLine: true },
            { finding: advisory, touchedLine: false },
          ],
          resolvedFindings: [],
          unchangedCount: 0,
          categories: [],
          projects: [],
        },
      }),
    )
    expect(report.delta?.newFindings.map((row) => row.advisory)).toEqual([undefined, true])
  })

  /**
   * The audit's crestArt case: two categories flagging one range. The link is
   * drawn over the whole set before the split, so a graded row and an advisory
   * row on the same lines still find each other.
   */
  it('links findings across categories that answer for the same place', () => {
    const lint = makeFinding({
      id: 'aaaaaaaaaaaaaaaa',
      category: 'lint',
      range: { startLine: 10, startCol: 1, endLine: 30, endCol: 1 },
    })
    const complexity = makeFinding({
      id: 'bbbbbbbbbbbbbbbb',
      category: 'complexity',
      gradeScope: false,
      range: { startLine: 12, startCol: 1, endLine: 12, endCol: 1 },
    })

    const report = buildReport(input({ findings: [lint, complexity] }))
    expect(report.findings[0]?.related).toEqual(['bbbbbbbbbbbbbbbb'])
    expect(report.advisories[0]?.related).toEqual(['aaaaaaaaaaaaaaaa'])
  })

  /** What the renderers read: the split undone, in the order it was cut from. */
  it('puts the two lists back together in report order, with the scope restored', () => {
    const findings = sortFindings([
      makeFinding({ id: 'aaaaaaaaaaaaaaaa', category: 'types', file: 'src/a.ts' }),
      makeFinding({ id: 'bbbbbbbbbbbbbbbb', file: 'src/a.ts', gradeScope: false }),
      makeFinding({ id: 'cccccccccccccccc', file: 'src/b.ts' }),
    ])
    const report = buildReport(input({ findings }))

    expect(reportFindings(report).map((finding) => finding.id)).toEqual(
      findings.map((finding) => finding.id),
    )
    expect(reportFindings(report).map((finding) => finding.gradeScope)).toEqual([true, false, true])
  })

  it('sorts warnings so two runs cannot disagree on their order', () => {
    expect(buildReport(input({ warnings: ['zzz', 'aaa'] })).warnings).toEqual(['aaa', 'zzz'])
  })

  it('describes how each tool ran, with the version that actually ran', () => {
    const report = buildReport(
      input({ runs: [{ record: record(), raw: ['raw/oxlint.sarif.json'] }] }),
    )
    expect(report.tools).toEqual([
      {
        tool: 'oxlint',
        category: 'lint',
        scope: 'js-ts',
        project: '.',
        execution: 'ephemeral-pinned',
        provenance: 'default-config',
        version: '1.77.0',
        pinned: '1.77.0',
        detection: null,
        state: 'ok',
        reason: null,
        raw: ['raw/oxlint.sarif.json'],
      },
    ])
  })

  /**
   * A repo can declare a tool without configuring it — `typescript` in
   * `devDependencies` and no `tsconfig.json` — and then the tool runs on our
   * bundled config. Its findings say `default-config`, and the tool record
   * saying `repo-config` made the two halves of one report disagree.
   */
  it('reports the config the runner honoured, not merely that a tool was detected', () => {
    const detection = {
      reason: 'dependency' as const,
      configFiles: [],
      installed: true,
      version: '7.0.2',
    }
    const declared: RunRecord = {
      tool: 'tsc',
      category: 'types',
      scope: 'js-ts',
      project: '.',
      repoWide: false,
      rollupOnly: false,
      pinnedVersion: '7.0.2',
      detection,
      result: { state: 'ok', findings: [], rawFiles: [], configOwned: false },
      durationMs: 7,
      standby: false,
    }

    const [tool] = buildReport(input({ runs: [{ record: declared, raw: [] }] })).tools
    expect(tool?.provenance).toBe('default-config')
    // The declared dependency is still on the record — that is why tsc ran.
    expect(tool?.detection).toEqual({ ...detection, configFiles: [], ownedVia: null })
  })

  it('falls back to detection for a runner that says nothing about its config', () => {
    const owned: RunRecord = {
      ...record(),
      detection: { reason: 'config', configFiles: ['.oxlintrc.json'], installed: true },
    }
    const [tool] = buildReport(input({ runs: [{ record: owned, raw: [] }] })).tools
    expect(tool?.provenance).toBe('repo-config')
  })

  it('quarantines everything non-deterministic under timings', () => {
    const report = buildReport(input({ runs: [{ record: record(), raw: [] }] }))
    expect(report.timings).toEqual({
      generatedAt: '2024-01-01T00:00:00.000Z',
      durationMs: 42,
      tools: [{ tool: 'oxlint', durationMs: 12 }],
    })
    // Nothing outside `timings` may carry a clock reading.
    expect(normalizeReport(serializeReport(report))).not.toContain('durationMs')
  })
})

/**
 * The per-project half of the schema. The top-level categories/metrics/findings
 * keep their meaning — they are the rollup — and everything here is beside them.
 */
describe('buildReport projects', () => {
  const api = projectAt('packages/api')
  const web = projectAt('packages/web')

  it('always reports at least one project, with all eight category states', () => {
    const [project, ...rest] = buildReport(input()).projects
    expect(rest).toEqual([])
    expect(project?.path).toBe('.')
    expect(Object.keys(project?.categories ?? {})).toEqual([...CATEGORIES])
  })

  it('grades each project on its own, ordered by path whatever order it was given', () => {
    const report = buildReport(
      input({
        // Deliberately not in path order: ordering is the report's job.
        projects: [
          makeProjectScan({ project: web, categories: allGraded('D') }),
          makeProjectScan({ project: api, categories: allGraded('A') }),
        ],
      }),
    )
    expect(report.projects.map((project) => project.path)).toEqual(['packages/api', 'packages/web'])
    expect(report.projects.map((project) => project.categories.lint)).toEqual([
      { status: 'graded', grade: 'A' },
      { status: 'graded', grade: 'D' },
    ])
    // The rollup is untouched by any of it.
    expect(report.categories.lint).toEqual({
      status: 'not-assessed',
      reason: 'no tool available for this category',
    })
  })

  it('carries a repo-scoped category through as the project’s own state', () => {
    const [project] = buildReport(
      input({
        projects: [
          makeProjectScan({
            project: api,
            categories: { ...allNotAssessed(), security: REPO_SCOPED },
          }),
        ],
      }),
    ).projects
    expect(project?.categories.security).toEqual(REPO_SCOPED)
  })

  it('records each project’s manifests, languages and owned toolchain', () => {
    const owned: RunRecord = {
      ...record(),
      project: 'packages/web',
      detection: {
        reason: 'config+dependency',
        configFiles: ['packages/web/.oxlintrc.json', '.oxlintrc.json'],
        ownedVia: 'packages/web/.oxlintrc.json',
        installed: true,
        version: '1.70.0',
      },
    }
    const [project] = buildReport(
      input({
        projects: [makeProjectScan({ project: web })],
        runs: [
          { record: owned, raw: [] },
          { record: record(), raw: [] },
        ],
      }),
    ).projects

    expect(project?.manifests).toEqual(['packages/web/package.json'])
    expect(project?.languages).toEqual(['js-ts'])
    // The root project's run is not this project's, and neither is a tool
    // nothing detected.
    expect(project?.toolchain).toEqual([
      {
        tool: 'oxlint',
        category: 'lint',
        reason: 'config+dependency',
        ownedVia: 'packages/web/.oxlintrc.json',
        configFiles: ['.oxlintrc.json', 'packages/web/.oxlintrc.json'],
        installed: true,
        version: '1.77.0',
      },
    ])
  })

  it('keeps the base scan’s runs out of a head project’s toolchain', () => {
    const owned: RunRecord = {
      ...record(),
      detection: { reason: 'config', configFiles: ['.oxlintrc.json'], installed: true },
    }
    const [project] = buildReport(
      input({
        runs: [
          { record: owned, raw: [], side: 'base' },
          { record: owned, raw: [], side: 'head' },
        ],
      }),
    ).projects
    expect(project?.toolchain.map((tool) => tool.tool)).toEqual(['oxlint'])
    expect(project?.toolchain[0]?.ownedVia).toBeNull()
  })

  it('attributes findings to their project without touching their identity', () => {
    const finding = makeFinding({ file: 'packages/web/src/a.ts', project: 'packages/web' })
    const [written] = buildReport(input({ findings: [finding] })).findings
    expect(written?.project).toBe('packages/web')
    expect(written?.id).toBe(finding.id)
  })

  it('records a workspace-shell root as a note rather than as a project', () => {
    const report = buildReport(
      input({
        projects: [makeProjectScan({ project: api }), makeProjectScan({ project: web })],
        rootShell: { declaredBy: ['pnpm-workspace.yaml', 'package.json'] },
      }),
    )
    expect(report.rootShell).toEqual({ declaredBy: ['package.json', 'pnpm-workspace.yaml'] })
    expect(report.projects.map((project) => project.path)).not.toContain('.')
  })

  it('has no rootShell key at all when the root is a real project', () => {
    expect('rootShell' in buildReport(input())).toBe(false)
  })

  /**
   * `"repo"` is a directory name a package may have, so the attribution string
   * alone cannot say whether a run spanned the repo. The flag is additive and
   * emitted only where it is true.
   */
  it('marks the runs that spanned the repo, and only those', () => {
    const report = buildReport(
      input({
        runs: [
          { record: { ...record(), repoWide: false, project: 'repo' }, raw: [] },
          {
            record: {
              ...record(),
              tool: 'gitleaks',
              category: 'security',
              scope: 'common',
              repoWide: true,
              project: 'repo',
            },
            raw: [],
          },
        ],
      }),
    )

    expect(report.tools.map((tool) => [tool.tool, tool.project, tool.repoWide])).toEqual([
      ['gitleaks', 'repo', true],
      ['oxlint', 'repo', undefined],
    ])
    expect('repoWide' in (report.tools.at(-1) ?? {})).toBe(false)
  })

  /**
   * The renderers collapse the rows a reader cannot tell apart; the data does
   * not. `report.json` is the record of what actually ran, so every run keeps
   * its row and its attribution however alike two rows read.
   */
  it('keeps a row per run, whatever the renderers collapse', () => {
    const projects = ['packages/api', 'packages/web', 'packages/z']
    const report = buildReport(
      input({ runs: projects.map((project) => ({ record: { ...record(), project }, raw: [] })) }),
    )
    expect(report.tools.map((tool) => [tool.tool, tool.project])).toEqual(
      projects.map((project) => ['oxlint', project]),
    )
  })

  /** …and a package called `repo/` does not own the repo's secrets scanner. */
  it('keeps a repo-spanning run out of every project’s toolchain', () => {
    const spanning: RunRecord = {
      ...record(),
      tool: 'gitleaks',
      category: 'security',
      scope: 'common',
      repoWide: true,
      project: 'repo',
      detection: { reason: 'config', configFiles: ['.gitleaks.toml'], installed: true },
    }
    const [project] = buildReport(
      input({
        projects: [makeProjectScan({ project: projectAt('packages/web') })],
        runs: [{ record: { ...spanning, project: 'packages/web' }, raw: [] }],
      }),
    ).projects

    expect(project?.toolchain).toEqual([])
  })

  /**
   * Under `--project` the rollup covers the selection rather than the repo, and
   * nothing else in the report says so — a reader (or a renderer) would take the
   * top-level grades for the whole tree's.
   */
  it('records the --project selection the rollup was computed over', () => {
    const scoped = buildReport(input({ scopedTo: ['packages/web', 'packages/api'] }))
    expect(scoped.scopedTo).toEqual(['packages/api', 'packages/web'])
    expect(Object.keys(scoped).indexOf('scopedTo')).toBe(
      Object.keys(scoped).indexOf('selected') + 1,
    )
  })

  it('has no scopedTo key at all when every project was scanned', () => {
    expect('scopedTo' in buildReport(input())).toBe(false)
  })

  /**
   * The determinism contract (spec §6) across the project dimension: the same
   * scan described in a different order is the same bytes.
   */
  it('serializes a multi-project scan to the same bytes whatever order it came in', () => {
    const findings = [
      makeFinding({ id: 'w', file: 'packages/web/src/a.ts', project: 'packages/web' }),
      makeFinding({ id: 'a', file: 'packages/api/api/main.py', project: 'packages/api' }),
    ]
    const runs = [
      { record: { ...record(), project: 'packages/api' }, raw: [] },
      { record: { ...record(), project: 'packages/web' }, raw: [] },
    ]
    const projects = [makeProjectScan({ project: api }), makeProjectScan({ project: web })]

    // Findings are ordered by the orchestrator, which is what the pipeline
    // hands over; projects and runs are ordered here.
    const one = buildReport(input({ projects, findings: sortFindings(findings), runs }))
    const other = buildReport(
      input({
        projects: projects.toReversed(),
        findings: sortFindings(findings.toReversed()),
        runs: runs.toReversed(),
      }),
    )
    expect(serializeReport(other)).toBe(serializeReport(one))
  })
})

describe('serializeReport', () => {
  it('writes indented JSON with a trailing newline', () => {
    const json = serializeReport(buildReport(input()))
    expect(json.endsWith('}\n')).toBe(true)
    expect(json).toContain('\n  "schemaVersion": 2,')
  })
})

/**
 * The rows a reader sees, deduplicated. Two rows a reader cannot tell apart say
 * nothing twice, so only the first of them is rendered — the companion unit to
 * the rendered-output assertions in `report-md.test.ts` and below.
 */
describe('collapseToolRows', () => {
  it('collapses nothing when there is nothing to collapse', () => {
    expect(collapseToolRows([])).toEqual([])
  })

  it('keeps the first of the rows that render identically, in the order given', () => {
    const first = toolRow({ project: 'packages/web' })
    const gitleaks = toolRow({ tool: 'gitleaks', reason: 'gitleaks is not on PATH' })
    const collapsed = collapseToolRows([
      first,
      gitleaks,
      toolRow({ project: 'packages/api' }),
      toolRow({ project: 'packages/cli' }),
    ])
    // The survivor is the first occurrence, and nothing was re-sorted — and it
    // carries the projects it now stands in for, in that same order.
    expect(collapsed).toEqual([
      { ...first, projects: ['packages/web', 'packages/api', 'packages/cli'] },
      { ...gitleaks, projects: ['packages/web'] },
    ])
  })

  /** The four fields no tool table renders: they cannot keep two rows apart. */
  it('excludes project, repoWide, detection and raw from the key, as a set', () => {
    const collapsed = collapseToolRows([
      toolRow(),
      toolRow({ project: 'packages/api' }),
      toolRow({ repoWide: true }),
      toolRow({
        detection: {
          reason: 'dependency',
          configFiles: [],
          ownedVia: 'package.json',
          installed: true,
          version: null,
        },
      }),
      toolRow({ raw: ['raw/packages/api/opengrep.json'] }),
    ])
    expect(collapsed).toEqual([{ ...toolRow(), projects: ['packages/web', 'packages/api'] }])
  })

  /** …and every field a tool table does render keeps two rows apart. */
  const KEYED: readonly (readonly [string, Partial<ReportTool>])[] = [
    ['tool', { tool: 'gitleaks' }],
    ['category', { category: 'lint' }],
    ['scope', { scope: 'js-ts' }],
    ['side', { side: 'base' }],
    ['state', { state: 'error' }],
    ['reason', { reason: 'no tsconfig.json under packages/api' }],
    ['execution', { execution: 'repo-installed' }],
    ['provenance', { provenance: 'repo-config' }],
    ['version', { version: '1.26.0' }],
    ['pinned', { pinned: '1.27.0' }],
  ]

  it.each(KEYED)('keeps two rows apart when %s differs', (_field, difference) => {
    expect(
      collapseToolRows([toolRow(), toolRow({ project: 'packages/api', ...difference })]),
    ).toHaveLength(2)
  })

  /**
   * A reason carrying a project-local path is a different sentence, so it is a
   * different row however alike the two runs otherwise are — and each row then
   * stands in for its own project and no one else's.
   */
  it('keeps two rows apart when only their reason names a different project', () => {
    const rows = [
      toolRow({
        tool: 'tsc',
        project: 'packages/web',
        reason: 'no tsconfig.json under packages/web',
      }),
      toolRow({
        tool: 'tsc',
        project: 'packages/api',
        reason: 'no tsconfig.json under packages/api',
      }),
    ]
    expect(collapseToolRows(rows)).toEqual([
      { ...rows[0], projects: ['packages/web'] },
      { ...rows[1], projects: ['packages/api'] },
    ])
  })

  /**
   * The repo-wide duplication pass renders as its per-project runs do — and
   * contributes no project to the list, because `repo` is not one.
   */
  it('collapses a repo-wide row into the per-project row it renders as', () => {
    const perProject = toolRow({
      tool: 'jscpd',
      category: 'duplication',
      state: 'ok',
      reason: null,
    })
    const repoWide = { ...perProject, project: 'repo', repoWide: true }
    expect(collapseToolRows([perProject, repoWide])).toEqual([
      { ...perProject, projects: ['packages/web'] },
    ])
  })

  /** A row no per-project run stands behind names no project at all. */
  it('lists no project for a group of repo-spanning rows', () => {
    const repoWide = toolRow({ project: 'repo', repoWide: true })
    expect(collapseToolRows([repoWide, repoWide])).toEqual([{ ...repoWide, projects: [] }])
  })
})

/**
 * What `--only` left out, as the renderers ask it: read off `report.selected`,
 * never off the reason the orchestrator wrote into the states it skipped.
 */
describe('unselectedCategories', () => {
  it('names the categories --only left out, in priority order', () => {
    expect(unselectedCategories(buildReport(input({ selected: ['lint'] })))).toEqual([
      'security',
      'types',
      'dead-code',
      'complexity',
      'duplication',
      'format',
      'test-quality',
    ])
  })

  it('names none when every category was selected', () => {
    expect(unselectedCategories(buildReport(input()))).toEqual([])
  })

  /**
   * Structural, not textual: a state whose reason says something else is still
   * unselected, and one that only *reads* like a skip is not.
   */
  it('reads the selection, not the reason a category went ungraded', () => {
    const report = buildReport(
      input({
        selected: ['lint', 'security'],
        categories: {
          ...allNotAssessed(),
          security: { status: 'not-assessed', reason: 'not selected by --only' },
        },
      }),
    )
    expect(unselectedCategories(report)).not.toContain('security')
  })

  it('names them under one fixed lead, in the same order', () => {
    expect(notSelectedNote(unselectedCategories(buildReport(input({ selected: ['lint'] }))))).toBe(
      'Not assessed: not selected by `--only` — security, types, dead code, complexity, ' +
        'duplication, format, test quality',
    )
  })

  /** The `--only types` selection of the same rule: a different sentence. */
  it('names lint among them when lint is the one left out', () => {
    expect(notSelectedNote(unselectedCategories(buildReport(input({ selected: ['types'] }))))).toBe(
      'Not assessed: not selected by `--only` — security, dead code, complexity, ' +
        'duplication, lint, format, test quality',
    )
  })
})

describe('renderTerminal', () => {
  const report = buildReport(
    input({
      categories: {
        ...allNotAssessed(),
        lint: { status: 'graded', grade: 'F' },
        types: { status: 'error', reason: 'tsc crashed' },
      },
      findings: [
        makeFinding({ id: 'a', severity: 'error', file: 'src/a.js', rule: 'no-const-assign' }),
        makeFinding({ id: 'b', gradeScope: false, file: 'src/b.js', rule: 'no-spread' }),
      ],
    }),
  )

  const paths = { markdown: '/out/report.md', agent: '/out/agent.md', json: '/out/report.json' }

  it('lists every category with its grade or its reason', () => {
    const text = renderTerminal(report, paths, { color: false })
    for (const label of ['security', 'types', 'dead code', 'complexity', 'test quality']) {
      expect(text).toContain(label)
    }
    expect(text).toMatch(/lint\s+F\s+1 graded, 1 advisory findings/)
    expect(text).toMatch(/types\s+error\s+tsc crashed/)
  })

  /** Spec §9: a run writes four artifacts, and the glance names all of them. */
  it('points at every artifact the run wrote', () => {
    const text = renderTerminal(report, paths, { color: false })
    expect(text).toContain('/out/report.md')
    expect(text).toContain('/out/agent.md')
    expect(text).toContain('/out/report.json')
  })

  it('marks advisory findings so nobody grades themselves on them', () => {
    const text = renderTerminal(report, paths, { color: false })
    expect(text).toContain('src/b.js:1:1')
    expect(text).toContain('[advisory]')
  })

  it('caps the finding list and says how many are left', () => {
    const text = renderTerminal(report, paths, { color: false, maxFindings: 1 })
    expect(text).toContain('… 1 more in report.json')
  })

  /**
   * A grade that came from our default config because the repo's own tool could
   * not run is a grade the reader has to be told about, and the terminal glance
   * is the only surface most runs are read through.
   */
  it('surfaces the run’s warnings', () => {
    const warned = buildReport(
      input({
        warnings: [
          'oxlint: graded lint on its default config because eslint reported not-available',
        ],
      }),
    )
    expect(renderTerminal(warned, paths, { color: false })).toContain(
      'warning: oxlint: graded lint on its default config because eslint reported not-available',
    )
  })

  /**
   * A tool that completed can still have something the reader has to know —
   * gitleaks suppressing hits outside the inventory, osv-scanner unable to read
   * Central Package Management. `report.md` has printed those notes all along;
   * the terminal is the surface most runs are read through, and dropping them
   * there is what makes a partial scan read as a clean one.
   */
  it('prints a tool that completed with something to say', () => {
    const text = renderTerminal(
      buildReport(
        input({
          runs: [
            {
              record: {
                ...record(),
                tool: 'gitleaks',
                category: 'security',
                scope: 'common',
                result: {
                  state: 'ok',
                  findings: [],
                  rawFiles: [],
                  reason: '2 raw hits in paths outside the analyzed inventory — suppressed',
                },
              },
              raw: [],
            },
          ],
        }),
      ),
      paths,
      { color: false },
    )

    const [, notes = ''] = text.split('Tool notes')
    expect(notes).toContain(
      '  ok gitleaks: 2 raw hits in paths outside the analyzed inventory — suppressed\n',
    )
  })

  /** A tool with nothing to say is not news, and the block is not a roll call. */
  it('says nothing about a tool that completed with nothing to say', () => {
    const text = renderTerminal(buildReport(input()), paths, { color: false })
    expect(text).not.toContain('Tool notes')
    expect(text).not.toContain('oxlint')
  })

  /**
   * The glance is a glance: one missing scanner is one line, however many
   * projects it was planned in.
   */
  it('names a tool that did not complete once, however many projects it ran in', () => {
    const missing = (project: string): { record: RunRecord; raw: string[] } => ({
      record: {
        ...record(),
        tool: 'opengrep',
        category: 'security',
        scope: 'common',
        project,
        result: {
          state: 'not-available',
          findings: [],
          rawFiles: [],
          reason: 'opengrep is not on PATH',
        },
      },
      raw: [],
    })
    const text = renderTerminal(
      buildReport(
        input({ runs: [missing('packages/api'), missing('packages/web'), missing('packages/z')] }),
      ),
      paths,
      { color: false },
    )

    const [, degraded = ''] = text.split('Tool notes')
    expect(degraded.split('\n').filter((line) => line.includes('opengrep'))).toEqual([
      '  not-available opengrep: opengrep is not on PATH',
    ])
  })

  /**
   * …but the one line says whose packages it is about. Collapsing four rows
   * into one is only honest if the survivor still names the four: "opengrep is
   * not on PATH" over two packages of five is a different fact from over all
   * five, and the reader cannot tell which without the list.
   */
  it('names the projects a collapsed row stands in for, in a monorepo', () => {
    const missing = (project: string): { record: RunRecord; raw: string[] } => ({
      record: {
        ...record(),
        tool: 'opengrep',
        category: 'security',
        scope: 'common',
        project,
        result: {
          state: 'not-available',
          findings: [],
          rawFiles: [],
          reason: 'opengrep is not on PATH',
        },
      },
      raw: [],
    })
    const text = renderTerminal(
      buildReport(
        input({
          projects: [
            makeProjectScan({ project: projectAt('packages/api') }),
            makeProjectScan({ project: projectAt('packages/web') }),
          ],
          runs: [missing('packages/api'), missing('packages/web')],
        }),
      ),
      paths,
      { color: false },
    )

    const [, degraded = ''] = text.split('Tool notes')
    expect(degraded.split('\n').filter((line) => line.includes('opengrep'))).toEqual([
      '  not-available opengrep: opengrep is not on PATH (packages/api, packages/web)',
    ])
  })

  /**
   * A single-project repo has no such ambiguity: every row is that project's,
   * and naming it would be a tautology on every line.
   */
  it('names no project where the repo has only one', () => {
    const text = renderTerminal(
      buildReport(
        input({
          runs: [
            {
              record: {
                ...record(),
                tool: 'opengrep',
                category: 'security',
                scope: 'common',
                result: {
                  state: 'not-available',
                  findings: [],
                  rawFiles: [],
                  reason: 'opengrep is not on PATH',
                },
              },
              raw: [],
            },
          ],
        }),
      ),
      paths,
      { color: false },
    )
    expect(text).toContain('  not-available opengrep: opengrep is not on PATH\n')
  })

  it('emits no escape sequences when colour is off, and some when it is on', () => {
    expect(renderTerminal(report, paths, { color: false })).not.toContain('\u001B[')
    expect(renderTerminal(report, paths, { color: true })).toContain('\u001B[')
  })
})

/**
 * The glance under `--only` (spec §9): the categories nobody asked about are
 * one line under the ones that were, not seven rows of "not assessed" pushing
 * the findings off the screen.
 */
describe('renderTerminal under --only', () => {
  const paths = { markdown: '/out/report.md', agent: '/out/agent.md', json: '/out/report.json' }
  const NOTE =
    '  Not assessed: not selected by `--only` — security, types, dead code, complexity, ' +
    'duplication, format, test quality'

  const onlyLint = buildReport(
    input({
      selected: ['lint'],
      categories: { ...allNotAssessed(), lint: { status: 'graded', grade: 'B' } },
    }),
  )

  it('lists the selected categories and names the rest in one line under them', () => {
    const block = categoryBlock(renderTerminal(onlyLint, paths, { color: false }))
    expect(block).toHaveLength(2)
    expect(block.at(0)).toMatch(/^ {2}lint\s+B\s+no findings$/)
    expect(block.at(-1)).toBe(NOTE)
  })

  /** Dimmed, with the indent inside the dim: the {@link rootShellNote} precedent. */
  it('dims that line, and emits no escape sequences when colour is off', () => {
    expect(renderTerminal(onlyLint, paths, { color: false })).not.toContain(CSI)
    expect(renderTerminal(onlyLint, paths, { color: true })).toContain(`${CSI}2m${NOTE}${CSI}22m`)
  })

  it('says nothing about --only when every category was selected', () => {
    const text = renderTerminal(buildReport(input({ categories: allGraded() })), paths, {
      color: false,
    })
    expect(categoryBlock(text)).toHaveLength(CATEGORIES.length)
    expect(text).not.toContain('not selected by `--only`')
  })
})

/** The ANSI control sequence introducer, the mark of a coloured cell. */
const CSI = `${String.fromCodePoint(27)}[`

/** The category block of the glance: the lines between the header and the next blank. */
function categoryBlock(text: string): string[] {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.includes('crank-health')) + 2
  const end = lines.indexOf('', start)
  return lines.slice(start, end)
}

/**
 * The glance in a monorepo: the rollup as it always was, then the projects
 * under it. A single-project repo *is* the rollup, so the block is not there —
 * which is the whole of "a one-project repo renders as it did before".
 */
describe('renderTerminal projects', () => {
  const paths = { markdown: '/out/report.md', agent: '/out/agent.md', json: '/out/report.json' }

  const monorepo = buildReport(
    input({
      categories: { ...allNotAssessed(), lint: { status: 'graded', grade: 'D' } },
      projects: [
        makeProjectScan({
          project: projectAt('packages/web'),
          categories: { ...allNotAssessed(), lint: { status: 'graded', grade: 'F' } },
        }),
        makeProjectScan({
          project: projectAt('packages/api'),
          categories: {
            ...allNotAssessed(),
            security: REPO_SCOPED,
            types: { status: 'error', reason: 'mypy crashed' },
            lint: { status: 'graded', grade: 'A' },
          },
        }),
      ],
      rootShell: { declaredBy: ['package.json', 'pnpm-workspace.yaml'] },
    }),
  )

  it('lists the projects under the rollup, in path order', () => {
    const lines = renderTerminal(monorepo, paths, { color: false }).split('\n')
    const heading = lines.indexOf('Projects')
    expect(heading).toBeGreaterThan(lines.findIndex((line) => line.includes('lint')))
    expect(lines.filter((line) => line.startsWith('  packages/'))).toEqual([
      '  packages/api  types error · lint A · 6 not assessed',
      '  packages/web  lint F · 7 not assessed',
    ])
  })

  it('says the root is a workspace shell rather than grading it', () => {
    const lines = renderTerminal(monorepo, paths, { color: false }).split('\n')
    expect(lines).toContain(
      '  The repo root is a workspace shell (declared by package.json, pnpm-workspace.yaml): it holds no source of its own, so it is not graded as a project.',
    )
    expect(lines.some((line) => line.startsWith('  repo root'))).toBe(false)
  })

  it('adds nothing at all to a single-project repo', () => {
    const single = buildReport(input({ projects: [makeProjectScan({ categories: allGraded() })] }))
    expect(renderTerminal(single, paths, { color: false })).not.toContain('Projects')
  })

  /**
   * …unless its root is a shell. One package in a workspace is still not the
   * repo root, and the note is the only place that says so.
   */
  it('still says the root is a shell when the workspace holds one package', () => {
    const onePackage = buildReport(
      input({
        projects: [
          makeProjectScan({ project: projectAt('packages/web'), categories: allGraded() }),
        ],
        rootShell: { declaredBy: ['pnpm-workspace.yaml'] },
      }),
    )
    const rendered = renderTerminal(onePackage, paths, { color: false })

    expect(rendered).toContain(
      'The repo root is a workspace shell (declared by pnpm-workspace.yaml)',
    )
    expect(rendered).toContain('  packages/web')
  })
})

const input = makeReportInput

/** One tool row a monorepo repeats: a missing scanner, once per project. */
function toolRow(overrides: Partial<ReportTool> = {}): ReportTool {
  return {
    tool: 'opengrep',
    category: 'security',
    scope: 'common',
    project: 'packages/web',
    execution: 'ephemeral-pinned',
    provenance: 'default-config',
    version: null,
    pinned: '1.26.0',
    detection: null,
    state: 'not-available',
    reason: 'opengrep is not on PATH',
    raw: [],
    ...overrides,
  }
}

function record(): RunRecord {
  return {
    tool: 'oxlint',
    category: 'lint',
    scope: 'js-ts',
    project: '.',
    repoWide: false,
    rollupOnly: false,
    pinnedVersion: '1.77.0',
    detection: null,
    result: { state: 'ok', findings: [], rawFiles: [], toolVersion: '1.77.0' },
    durationMs: 12,
    standby: false,
  }
}
