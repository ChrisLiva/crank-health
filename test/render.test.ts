import { describe, expect, it } from 'vitest'
import type { RunRecord } from '../src/core/orchestrator.ts'
import type { Category, CategoryState, Finding, ToolMetrics } from '../src/core/types.ts'
import { CATEGORIES } from '../src/core/types.ts'
import type { ReportInput } from '../src/render/json.ts'
import { buildReport, serializeReport } from '../src/render/json.ts'
import { renderTerminal } from '../src/render/terminal.ts'
import { makeFinding } from './factories.ts'
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

  it('lists every category with its grade or its reason', () => {
    const text = renderTerminal(report, '/out/report.json', { color: false })
    for (const label of ['security', 'types', 'dead code', 'complexity', 'test quality']) {
      expect(text).toContain(label)
    }
    expect(text).toMatch(/lint\s+F\s+1 graded, 1 advisory findings/)
    expect(text).toMatch(/types\s+error\s+tsc crashed/)
    expect(text).toContain('/out/report.json')
  })

  it('marks advisory findings so nobody grades themselves on them', () => {
    const text = renderTerminal(report, '/out/report.json', { color: false })
    expect(text).toContain('src/b.js:1:1')
    expect(text).toContain('[advisory]')
  })

  it('caps the finding list and says how many are left', () => {
    const text = renderTerminal(report, '/out/report.json', { color: false, maxFindings: 1 })
    expect(text).toContain('… 1 more in report.json')
  })

  it('emits no escape sequences when colour is off, and some when it is on', () => {
    expect(renderTerminal(report, '/out/report.json', { color: false })).not.toContain('\u001B[')
    expect(renderTerminal(report, '/out/report.json', { color: true })).toContain('\u001B[')
  })
})

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    repoPath: '/repo',
    commit: 'abc123',
    profile: 'quick',
    selected: CATEGORIES,
    categories: allNotAssessed(),
    metrics: noMetrics(),
    runs: [],
    findings: [],
    warnings: [],
    generatedAt: '2024-01-01T00:00:00.000Z',
    durationMs: 42,
    ...overrides,
  }
}

function allNotAssessed(): Record<Category, CategoryState> {
  const states = {} as Record<Category, CategoryState>
  for (const category of CATEGORIES) {
    states[category] = { status: 'not-assessed', reason: 'no tool available for this category' }
  }
  return states
}

function noMetrics(): Record<Category, ToolMetrics> {
  const metrics = {} as Record<Category, ToolMetrics>
  for (const category of CATEGORIES) metrics[category] = {}
  return metrics
}

function record(): RunRecord {
  return {
    tool: 'oxlint',
    category: 'lint',
    scope: 'js-ts',
    pinnedVersion: '1.77.0',
    detection: null,
    result: { state: 'ok', findings: [], rawFiles: [], toolVersion: '1.77.0' },
    durationMs: 12,
  }
}
