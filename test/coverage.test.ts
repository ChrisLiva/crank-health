import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  UNCOVERED_FINDING_LIMIT,
  coverageRunner,
  parseCoverageJson,
  toPendingFindings,
} from '../src/adapters/python/coverage.ts'
import type { CoverageReport } from '../src/adapters/python/coverage.ts'
import type { RunContext } from '../src/core/types.ts'
import { makeProject } from './factories.ts'

/**
 * coverage.py wrapper: the captured `coverage json` a real 7.15.3 run produced,
 * and the rule that coverage is context — advisory findings in a PR, a metric
 * always, and never a grade (spec §3 grades test quality on mutation score).
 */

const CAPTURED = fileURLToPath(new URL('./captured/coverage-7.15.3.json', import.meta.url))

const CONTEXT: RunContext = {
  repoRoot: '/repo',
  project: makeProject(['pkg/calc.py']),
  files: ['pkg/calc.py'],
  scratch: '/scratch',
  detection: null,
  timeoutMs: 1_000,
  deep: true,
}

describe('parsing a coverage report', () => {
  it('reads the total percentage and the uncovered lines per file', async () => {
    const report = parseCoverageJson(await readFile(CAPTURED, 'utf8'))

    expect(report.linePercent).toBeCloseTo(76.923, 2)
    expect(report.missingLines.get('calcpkg/calc.py')).toEqual([8, 9, 10])
    // Files with full coverage carry no entry at all.
    expect(report.missingLines.has('test_calc.py')).toBe(false)
  })

  it('rejects a payload that is not a coverage report', () => {
    expect(() => parseCoverageJson('{"totals": {}}')).toThrow(/files/)
  })
})

describe('uncovered lines as findings', () => {
  const report: CoverageReport = {
    linePercent: 50,
    missingLines: new Map([
      ['pkg/calc.py', [4, 2]],
      ['pkg/untouched.py', [1]],
    ]),
  }

  it('reports nothing in a whole-repo scan, where every uncovered line is old news', () => {
    expect(toPendingFindings(report, undefined, false)).toEqual([])
  })

  it('flags the uncovered lines of the changed files, advisory and in order', () => {
    const findings = toPendingFindings(report, ['pkg/calc.py'], false)

    expect(findings.map((finding) => [finding.file, finding.range.startLine])).toEqual([
      ['pkg/calc.py', 2],
      ['pkg/calc.py', 4],
    ])
    expect(findings.every((finding) => finding.gradeScope)).toBe(false)
    expect(findings.every((finding) => finding.severity === 'info')).toBe(true)
    expect(findings[0]?.rule).toBe('coverage/uncovered-line')
  })

  it('caps the list rather than printing a file’s every uncovered line', () => {
    const lines = Array.from({ length: UNCOVERED_FINDING_LIMIT + 10 }, (_, index) => index + 1)
    const findings = toPendingFindings(
      { linePercent: 0, missingLines: new Map([['pkg/calc.py', lines]]) },
      ['pkg/calc.py'],
      true,
    )
    expect(findings).toHaveLength(UNCOVERED_FINDING_LIMIT)
    expect(findings.every((finding) => finding.provenance === 'repo-config')).toBe(true)
  })
})

describe('the runner’s posture', () => {
  it('is deep-only and does not stand mutation testing down', () => {
    expect(coverageRunner).toMatchObject({
      category: 'test-quality',
      deepOnly: true,
      complementary: true,
    })
    expect(coverageRunner.repoOwnedOnly).toBeUndefined()
  })

  it('declines in the quick profile instead of executing repo code', async () => {
    const result = await coverageRunner.run({ ...CONTEXT, deep: false })
    expect(result).toMatchObject({ state: 'not-available' })
    expect(result.reason).toContain('--deep')
  })

  it('says what to install when the project has no virtualenv to run tests in', async () => {
    const result = await coverageRunner.run(CONTEXT)
    expect(result).toMatchObject({ state: 'not-available' })
    expect(result.reason).toContain('virtualenv')
  })
})
