import { describe, expect, it } from 'vitest'
import { inventoryOf, partitionProjects } from '../src/core/discover.ts'
import type { RunRecord } from '../src/core/orchestrator.ts'
import { sortFindings } from '../src/core/orchestrator.ts'
import type { CategoryState, Finding, Project } from '../src/core/types.ts'
import { CATEGORIES } from '../src/core/types.ts'
import { buildReport, serializeReport } from '../src/render/json.ts'
import { renderTerminal } from '../src/render/terminal.ts'
import { REPO_SCOPED_REASON } from '../src/run.ts'
import {
  allGraded,
  allNotAssessed,
  makeFinding,
  makeProjectScan,
  makeReportInput,
} from './factories.ts'
import { normalizeReport } from './support/report.ts'

/** A workspace with no source at its root: two packages, two languages. */
const MONOREPO = partitionProjects(
  inventoryOf([
    'package.json',
    'packages/api/api/main.py',
    'packages/api/pyproject.toml',
    'packages/web/package.json',
    'packages/web/src/a.ts',
    'pnpm-workspace.yaml',
  ]),
)

const REPO_SCOPED: CategoryState = { status: 'not-assessed', reason: REPO_SCOPED_REASON }

function projectAt(path: string): Project {
  const found = MONOREPO.find((project) => project.path === path)
  if (found === undefined) throw new Error(`no project at ${path}`)
  return found
}

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
      'gradeScope',
    ])
    expect(Object.keys(finding?.range ?? {})).toEqual([
      'startLine',
      'startCol',
      'endLine',
      'endCol',
    ])
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
    expect(json).toContain('\n  "schemaVersion": 1,')
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

  it('emits no escape sequences when colour is off, and some when it is on', () => {
    expect(renderTerminal(report, paths, { color: false })).not.toContain('\u001B[')
    expect(renderTerminal(report, paths, { color: true })).toContain('\u001B[')
  })
})

const input = makeReportInput

function record(): RunRecord {
  return {
    tool: 'oxlint',
    category: 'lint',
    scope: 'js-ts',
    project: '.',
    rollupOnly: false,
    pinnedVersion: '1.77.0',
    detection: null,
    result: { state: 'ok', findings: [], rawFiles: [], toolVersion: '1.77.0' },
    durationMs: 12,
    standby: false,
  }
}
