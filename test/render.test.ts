import { describe, expect, it } from 'vitest'
import type { RunRecord } from '../src/core/orchestrator.ts'
import type { Finding } from '../src/core/types.ts'
import { CATEGORIES } from '../src/core/types.ts'
import { buildReport, serializeReport } from '../src/render/json.ts'
import { renderTerminal } from '../src/render/terminal.ts'
import { allNotAssessed, makeFinding, makeReportInput } from './factories.ts'
import { normalizeReport } from './support/report.ts'

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
      pinnedVersion: '7.0.2',
      detection,
      result: { state: 'ok', findings: [], rawFiles: [], configOwned: false },
      durationMs: 7,
      standby: false,
    }

    const [tool] = buildReport(input({ runs: [{ record: declared, raw: [] }] })).tools
    expect(tool?.provenance).toBe('default-config')
    // The declared dependency is still on the record — that is why tsc ran.
    expect(tool?.detection).toEqual({ ...detection, configFiles: [] })
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
    pinnedVersion: '1.77.0',
    detection: null,
    result: { state: 'ok', findings: [], rawFiles: [], toolVersion: '1.77.0' },
    durationMs: 12,
    standby: false,
  }
}
