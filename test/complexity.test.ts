import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fallowHealthRunner, parseHealth, toHealthFindings } from '../src/adapters/jsts/fallow.ts'
import {
  FTA_ADVISORY_SCORE,
  ftaRunner,
  parseFtaJson,
  toPendingFindings,
} from '../src/adapters/jsts/fta.ts'
import { COMPLEXITY_CEILING } from '../src/core/grade.ts'

/**
 * The complexity pair. `fallow health` measures cognitive complexity per
 * function, which is exactly the ratio spec §3 grades on; fta scores whole
 * files on a different blend of metrics, so it is advisory only.
 *
 * Both captures are real output against `test/fixtures/js-basic`.
 */
const HEALTH = fileURLToPath(new URL('./captured/fallow-health-3.14.0.json', import.meta.url))
const FTA = fileURLToPath(new URL('./captured/fta-3.0.0.json', import.meta.url))

describe('parseHealth', () => {
  it('reads the function count and the per-function findings from real output', async () => {
    const report = parseHealth(await readFile(HEALTH, 'utf8'))
    expect(report.version).toBe('3.14.0')
    expect(report.functionsAnalyzed).toBe(9)
    expect(report.findings).toEqual([
      {
        file: 'src/complex.js',
        name: 'classify',
        line: 1,
        column: 7,
        cognitive: 29,
        cyclomatic: 18,
        severity: 'critical',
        exceedsCognitive: true,
      },
    ])
  })

  /**
   * fallow gates on four ceilings at once and reports a function that trips any
   * of them; spec §3 grades the cognitive one alone.
   */
  it('marks only the functions over the cognitive ceiling, not every finding', () => {
    const document = JSON.stringify({
      kind: 'health',
      version: '3.14.0',
      summary: { functions_analyzed: 4, max_cognitive_threshold: 15 },
      findings: [
        { path: 'a.ts', name: 'cognitive', line: 1, col: 1, cognitive: 29, cyclomatic: 3 },
        { path: 'a.ts', name: 'cyclomaticOnly', line: 9, col: 1, cognitive: 4, cyclomatic: 30 },
      ],
    })
    const report = parseHealth(document)
    expect(report.findings.map((finding) => [finding.name, finding.exceedsCognitive])).toEqual([
      ['cognitive', true],
      ['cyclomaticOnly', false],
    ])
  })

  it('rejects output that is not a fallow health report', () => {
    expect(() => parseHealth('{"kind":"dead-code"}')).toThrow('not a fallow health report')
    expect(() => parseHealth('nonsense')).toThrow()
  })
})

describe('toHealthFindings', () => {
  const report = {
    version: '3.14.0',
    functionsAnalyzed: 9,
    findings: [
      {
        file: 'src/complex.js',
        name: 'classify',
        line: 1,
        column: 7,
        cognitive: 29,
        cyclomatic: 18,
        severity: 'critical',
        exceedsCognitive: true,
      },
      {
        file: 'src/other.js',
        name: 'wide',
        line: 4,
        column: 1,
        cognitive: 4,
        cyclomatic: 30,
        severity: 'high',
        exceedsCognitive: false,
      },
    ],
  }

  /** `critical` belongs to leaked secrets in the absolute security shape. */
  it('maps fallow severities onto the vocabulary without minting a critical', () => {
    expect(toHealthFindings(report, false).map((finding) => finding.severity)).toEqual([
      'error',
      'warning',
    ])
  })

  it('marks the functions that drive the grade, and anchors on the function name', () => {
    const findings = toHealthFindings(report, false)
    expect(findings.map((finding) => [finding.anchor, finding.gradeScope])).toEqual([
      ['classify', true],
      ['wide', false],
    ])
    expect(findings[0]?.message).toContain(String(COMPLEXITY_CEILING))
    expect(findings.every((finding) => finding.category === 'complexity')).toBe(true)
  })
})

describe('the fallow health runner', () => {
  it('reports the complexity category and runs as a default (nothing owns it)', () => {
    expect(fallowHealthRunner.category).toBe('complexity')
    expect(fallowHealthRunner.repoOwnedOnly).toBeUndefined()
  })
})

describe('parseFtaJson', () => {
  it('reads per-file scores from real output', async () => {
    const scores = parseFtaJson(await readFile(FTA, 'utf8'))
    expect(scores[0]).toEqual({
      file: 'src/complex.js',
      score: 36.939838720908924,
      cyclomatic: 19,
      lineCount: 39,
      assessment: 'OK',
    })
    expect(scores.map((score) => score.file)).toContain('src/index.js')
  })

  it('rejects output that is not fta’s array of file scores', () => {
    expect(() => parseFtaJson('{"oops":true}')).toThrow('not an array')
    expect(() => parseFtaJson('nonsense')).toThrow()
  })
})

describe('fta toPendingFindings', () => {
  const scores = [
    { file: 'src/fine.ts', score: 20, cyclomatic: 2, lineCount: 10, assessment: 'OK' },
    {
      file: 'src/rough.ts',
      score: 62.5,
      cyclomatic: 20,
      lineCount: 200,
      assessment: 'Needs improvement',
    },
    {
      file: 'src/awful.ts',
      score: 88,
      cyclomatic: 40,
      lineCount: 600,
      assessment: 'Needs improvement',
    },
  ]

  it('reports only the files worth a reader’s attention', () => {
    expect(toPendingFindings(scores, false).map((finding) => finding.file)).toEqual([
      'src/awful.ts',
      'src/rough.ts',
    ])
    expect(FTA_ADVISORY_SCORE).toBe(60)
  })

  /**
   * fta scores files; spec §3's complexity grade is "% of functions over
   * cognitive 15". Different unit, so this signal is never graded — fallow
   * health supplies the ratio.
   */
  it('never grades: a file score is not the ratio the spec grades on', () => {
    expect(toPendingFindings(scores, false).every((finding) => finding.gradeScope)).toBe(false)
  })

  it('escalates severity with the score, and anchors file-level', () => {
    const bySeverity = new Map(
      toPendingFindings(scores, false).map((finding) => [finding.file, finding.severity]),
    )
    expect(bySeverity.get('src/rough.ts')).toBe('info')
    expect(bySeverity.get('src/awful.ts')).toBe('warning')
    expect(toPendingFindings(scores, false).every((finding) => finding.anchor === '')).toBe(true)
  })
})

describe('the fta runner', () => {
  it('reports the complexity category as a second, advisory signal', () => {
    expect(ftaRunner.category).toBe('complexity')
    expect(ftaRunner.repoOwnedOnly).toBeUndefined()
  })
})
