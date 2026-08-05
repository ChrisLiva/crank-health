import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseDeadCode, toDeadCodeFindings } from '../src/adapters/jsts/fallow.ts'
import { parseKnipJson, toPendingFindings } from '../src/adapters/jsts/knip.ts'

/**
 * The dead-code pair: fallow and knip answer the same question independently
 * (spec "fallow dead-code + knip cross-check"), and both apply spec §3's
 * "high-confidence only" rule through `gradeScope`.
 *
 * Captured raw output: fallow against `test/fixtures/ts-owned`, knip against
 * `test/fixtures/js-basic`.
 */
const FALLOW = fileURLToPath(new URL('./captured/fallow-dead-code-3.14.0.json', import.meta.url))
const KNIP = fileURLToPath(new URL('./captured/knip-6.31.0.json', import.meta.url))

describe('parseDeadCode', () => {
  it('reads entry points, unused files and unused exports from real output', async () => {
    const report = parseDeadCode(await readFile(FALLOW, 'utf8'))
    expect(report.version).toBe('3.14.0')
    expect(report.entryPoints).toBe(2)
    expect(report.unusedFiles).toEqual(['src/lint.js'])
    expect(report.unusedExports).toEqual([
      { file: 'src/util.ts', name: 'unusedHelper', line: 5, column: 16 },
    ])
    expect(report.unusedDependencies).toEqual([])
  })

  it('rejects output that is not a fallow dead-code report', () => {
    expect(() => parseDeadCode('{"kind":"health"}')).toThrow('not a fallow dead-code report')
    expect(() => parseDeadCode('nonsense')).toThrow()
  })
})

describe('toDeadCodeFindings', () => {
  const report = {
    version: '3.14.0',
    entryPoints: 2,
    unusedFiles: ['src/dead.ts'],
    unusedExports: [{ file: 'src/util.ts', name: 'unusedHelper', line: 5, column: 16 }],
    unusedDependencies: ['left-pad'],
  }

  it('grades unused exports, and anchors them on the symbol name', () => {
    const finding = toDeadCodeFindings(report, false).find(
      (candidate) => candidate.rule === 'fallow/unused-export',
    )
    expect(finding).toMatchObject({
      category: 'dead-code',
      severity: 'warning',
      gradeScope: true,
      file: 'src/util.ts',
      anchor: 'unusedHelper',
    })
  })

  it('grades unused files when fallow had an entry point to start from', () => {
    const finding = toDeadCodeFindings(report, false).find(
      (candidate) => candidate.rule === 'fallow/unused-file',
    )
    expect(finding).toMatchObject({ severity: 'warning', gradeScope: true, anchor: '' })
  })

  /**
   * With no entry point every file is trivially unreachable — a library with no
   * `main` would otherwise grade F for having no `main`.
   */
  it('keeps unused files advisory when fallow found no entry point at all', () => {
    const findings = toDeadCodeFindings({ ...report, entryPoints: 0 }, false)
    const file = findings.find((candidate) => candidate.rule === 'fallow/unused-file')
    expect(file?.gradeScope).toBe(false)
    expect(file?.message).toContain('advisory')
    // The exports are still high-confidence, entry point or not.
    expect(
      findings.find((candidate) => candidate.rule === 'fallow/unused-export')?.gradeScope,
    ).toBe(true)
  })

  it('tags provenance from whose config decided the result', () => {
    expect(toDeadCodeFindings(report, true).every((f) => f.provenance === 'repo-config')).toBe(true)
    expect(toDeadCodeFindings(report, false).every((f) => f.provenance === 'default-config')).toBe(
      true,
    )
  })
})

describe('parseKnipJson', () => {
  it('reads unused exports out of knip’s per-file records', async () => {
    const issues = parseKnipJson(await readFile(KNIP, 'utf8'))
    expect(issues.unusedFiles).toEqual([])
    expect(issues.unusedExports).toEqual([
      { file: 'src/clean.js', name: 'subtract', line: 5, column: 17, kind: 'exports' },
    ])
    expect(issues.unusedDependencies).toEqual([])
  })

  it('reads every issue kind it knows about', () => {
    const document = JSON.stringify({
      issues: [
        {
          file: 'src/a.ts',
          files: [{ name: 'src/dead.ts' }],
          exports: [{ name: 'helper', line: 3, col: 8 }],
          types: [{ name: 'Options', line: 9, col: 13 }],
          dependencies: [{ name: 'left-pad' }],
          devDependencies: [{ name: 'jest' }],
        },
      ],
    })
    const issues = parseKnipJson(document)
    expect(issues.unusedFiles).toEqual(['src/dead.ts'])
    expect(issues.unusedExports.map((symbol) => [symbol.name, symbol.kind])).toEqual([
      ['helper', 'exports'],
      ['Options', 'types'],
    ])
    expect(issues.unusedDependencies.map((dependency) => dependency.name)).toEqual([
      'left-pad',
      'jest',
    ])
  })

  it('rejects output that is not knip’s issues envelope', () => {
    expect(() => parseKnipJson('{"oops":true}')).toThrow('no issues array')
    expect(() => parseKnipJson('nonsense')).toThrow()
  })
})

describe('knip toPendingFindings', () => {
  const issues = {
    unusedFiles: ['src/dead.ts'],
    unusedExports: [{ file: 'src/util.ts', name: 'helper', line: 3, column: 8, kind: 'exports' }],
    unusedDependencies: [{ file: 'package.json', name: 'left-pad', kind: 'dependencies' }],
  }

  it('grades exports, grades files when an entry point resolved, never grades deps', () => {
    const graded = new Map(
      toPendingFindings(issues, false, 4).map((finding) => [finding.rule, finding.gradeScope]),
    )
    expect(graded.get('knip/unused-exports')).toBe(true)
    expect(graded.get('knip/unused-file')).toBe(true)
    expect(graded.get('knip/unused-dependencies')).toBe(false)
  })

  it('maps the three kinds onto the severity vocabulary', () => {
    const severities = new Map(
      toPendingFindings(issues, false, 4).map((finding) => [finding.rule, finding.severity]),
    )
    expect(severities.get('knip/unused-exports')).toBe('warning')
    expect(severities.get('knip/unused-file')).toBe('warning')
    expect(severities.get('knip/unused-dependencies')).toBe('info')
  })

  /** Every analyzed file "unused" means knip never resolved an entry point. */
  it('keeps unused files advisory when knip found every file unused', () => {
    const everything = { ...issues, unusedFiles: ['a.ts', 'b.ts'] }
    const findings = toPendingFindings(everything, false, 2).filter(
      (finding) => finding.rule === 'knip/unused-file',
    )
    expect(findings.every((finding) => finding.gradeScope)).toBe(false)
    expect(findings[0]?.message).toContain('advisory')
  })

  it('anchors symbol findings on the symbol and file findings on nothing', () => {
    const findings = toPendingFindings(issues, false, 4)
    expect(findings.find((f) => f.rule === 'knip/unused-exports')?.anchor).toBe('helper')
    expect(findings.find((f) => f.rule === 'knip/unused-file')?.anchor).toBe('')
  })
})
