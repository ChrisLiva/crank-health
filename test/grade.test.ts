import { describe, expect, it } from 'vitest'
import {
  compareGrades,
  failingFilePercent,
  gradeAbsolute,
  gradeCategory,
  gradeDensity,
  gradeRatio,
  isBelow,
  weightedCount,
} from '../src/core/grade.ts'
import type { Grade, Severity } from '../src/core/types.ts'
import { makeFinding, makeFindings } from './factories.ts'

/** 10 KLOC keeps the hand arithmetic trivial: weighted total / 10. */
const KLOC = 10

/** `count` security findings of one severity. */
const security = (severity: Severity, count = 1) => makeFindings(count, severity, 'security')

/** The same, reported but out of grade scope (spec §1). */
const unscoped = (severity: Severity, count = 1) =>
  makeFindings(count, severity, 'security', { gradeScope: false })

describe('density grades (lint)', () => {
  it('weights severities error x5, warning x1, info x0.2', () => {
    expect(
      weightedCount([
        makeFinding({ severity: 'error' }),
        makeFinding({ severity: 'critical' }),
        makeFinding({ severity: 'warning' }),
        makeFinding({ severity: 'info' }),
        makeFinding({ severity: 'info' }),
      ]),
    ).toBeCloseTo(11.4)
  })

  it('grades A with no findings at all', () => {
    expect(gradeDensity('lint', [], KLOC)).toBe('A')
  })

  it.each([
    // [weighted warnings, density, grade] — bands are A <=1, B <=5, C <=15, D <=40
    [10, 1, 'A'],
    [11, 1.1, 'B'],
    [50, 5, 'B'],
    [51, 5.1, 'C'],
    [150, 15, 'C'],
    [151, 15.1, 'D'],
    [400, 40, 'D'],
    [401, 40.1, 'F'],
  ])('bands %i warnings (%s/KLOC) as %s', (count, _density, grade) => {
    expect(gradeDensity('lint', makeFindings(count, 'warning'), KLOC)).toBe(grade)
  })

  it('mixes severities into one weighted density', () => {
    // 1 error (5) + 1 warning (1) + 5 info (1) = 7 weighted / 10 KLOC = 0.7 -> A
    const findings = [
      ...makeFindings(1, 'error'),
      ...makeFindings(1, 'warning'),
      ...makeFindings(5, 'info'),
    ]
    expect(gradeDensity('lint', findings, KLOC)).toBe('A')
  })

  it('counts only gradeScope findings', () => {
    const advisory = makeFindings(400, 'error', 'lint', { gradeScope: false })
    expect(gradeDensity('lint', advisory, KLOC)).toBe('A')
    expect(gradeDensity('lint', [...advisory, ...makeFindings(11, 'warning')], KLOC)).toBe('B')
  })

  it('ignores findings belonging to another category', () => {
    expect(gradeDensity('lint', makeFindings(400, 'error', 'types'), KLOC)).toBe('A')
  })

  it('treats findings with no measurable code as F, and no findings as A', () => {
    expect(gradeDensity('lint', makeFindings(1, 'info'), 0)).toBe('F')
    expect(gradeDensity('lint', [], 0)).toBe('A')
  })
})

describe('density grades (types, errors only)', () => {
  it('ignores non-error severities entirely', () => {
    const noise = [...makeFindings(50, 'warning', 'types'), ...makeFindings(50, 'info', 'types')]
    expect(gradeDensity('types', noise, KLOC)).toBe('A')
  })

  it.each([
    // bands A =0, B <=1, C <=5, D <=15 over weighted errors (x5)
    [1, 'B'], // 5 / 10 = 0.5
    [2, 'B'], // 1.0
    [3, 'C'], // 1.5
    [10, 'C'], // 5.0
    [11, 'D'], // 5.5
    [30, 'D'], // 15.0
    [31, 'F'], // 15.5
  ])('bands %i type errors as %s', (count, grade) => {
    expect(gradeDensity('types', makeFindings(count, 'error', 'types'), KLOC)).toBe(grade)
  })

  it('counts critical type findings with error weight', () => {
    expect(gradeDensity('types', makeFindings(31, 'critical', 'types'), KLOC)).toBe('F')
  })
})

describe('density grades (dead code)', () => {
  it.each([
    [1, 'A'], // 5 / 10 = 0.5, the A boundary
    [2, 'B'], // 1.0
    [4, 'B'], // 2.0
    [5, 'C'], // 2.5
    [10, 'C'], // 5.0
    [11, 'D'], // 5.5
    [20, 'D'], // 10.0
    [21, 'F'], // 10.5
  ])('bands %i dead-code errors as %s', (count, grade) => {
    expect(gradeDensity('dead-code', makeFindings(count, 'error', 'dead-code'), KLOC)).toBe(grade)
  })
})

describe('ratio grades', () => {
  it.each([
    [0, 'A'],
    [1, 'A'],
    [1.1, 'B'],
    [10, 'B'],
    [10.1, 'C'],
    [30, 'C'],
    [30.1, 'D'],
    [60, 'D'],
    [60.1, 'F'],
  ])('bands %s%% of files failing format as %s', (percent, grade) => {
    expect(gradeRatio('format', percent)).toBe(grade)
  })

  it.each([
    [3, 'A'],
    [3.1, 'B'],
    [5, 'B'],
    [5.1, 'C'],
    [10, 'C'],
    [10.1, 'D'],
    [20, 'D'],
    [20.1, 'F'],
  ])('bands %s%% duplicated tokens as %s', (percent, grade) => {
    expect(gradeRatio('duplication', percent)).toBe(grade)
  })

  it.each([
    [2, 'A'],
    [2.1, 'B'],
    [20, 'D'],
    [20.1, 'F'],
  ])('bands %s%% over-complex functions as %s', (percent, grade) => {
    expect(gradeRatio('complexity', percent)).toBe(grade)
  })

  it.each([
    // test quality is inverted: mutation score, higher is better
    [100, 'A'],
    [80, 'A'],
    [79.9, 'B'],
    [65, 'B'],
    [64.9, 'C'],
    [50, 'C'],
    [49.9, 'D'],
    [35, 'D'],
    [34.9, 'F'],
    [0, 'F'],
  ])('bands a mutation score of %s as %s', (percent, grade) => {
    expect(gradeRatio('test-quality', percent)).toBe(grade)
  })
})

describe('failingFilePercent', () => {
  it('counts each failing file once and ignores advisory findings', () => {
    const findings = [
      makeFinding({ category: 'format', file: 'a.ts' }),
      makeFinding({ category: 'format', file: 'a.ts' }),
      makeFinding({ category: 'format', file: 'b.ts' }),
      makeFinding({ category: 'format', file: 'c.ts', gradeScope: false }),
    ]
    expect(failingFilePercent(findings, 'format', 8)).toBe(25)
    expect(gradeRatio('format', failingFilePercent(findings, 'format', 8))).toBe('C')
  })

  it('is 0% when there are no files to format', () => {
    expect(failingFilePercent([], 'format', 0)).toBe(0)
  })
})

describe('absolute grades (security)', () => {
  it('grades A on zero findings', () => {
    expect(gradeAbsolute('security', [])).toBe('A')
  })

  it('grades F for a secret or any critical finding, whatever else is present', () => {
    expect(gradeAbsolute('security', security('critical'))).toBe('F')
    expect(gradeAbsolute('security', [...security('critical'), ...security('info', 50)])).toBe('F')
  })

  it('caps at D when a high-severity finding is present', () => {
    expect(gradeAbsolute('security', security('error'))).toBe('D')
    expect(gradeAbsolute('security', [...security('error'), ...security('warning', 20)])).toBe('D')
  })

  it('splits B and C on medium/low counts', () => {
    expect(gradeAbsolute('security', security('warning', 2))).toBe('B')
    expect(gradeAbsolute('security', security('warning', 3))).toBe('C')
    expect(gradeAbsolute('security', security('info', 10))).toBe('B')
    expect(gradeAbsolute('security', security('info', 11))).toBe('C')
  })

  /**
   * The one place advisory findings still decide a grade. Spec §3's absolute
   * shape says "any secret or critical → F" with no qualifier, and a report
   * reading `security: A` above a listed critical finding is the failure mode
   * this whole category exists to prevent. The tiers read every finding; only
   * the B/C split — how much low-grade noise is tolerable — counts graded ones.
   */
  it('grades the severity tiers on every finding, advisory or not', () => {
    expect(gradeAbsolute('security', unscoped('critical'))).toBe('F')
    expect(gradeAbsolute('security', unscoped('error'))).toBe('D')
  })

  /** A is a clean scan, not a scan whose findings nobody graded. */
  it('reserves A for a category with no findings at all', () => {
    expect(gradeAbsolute('security', unscoped('info'))).toBe('B')
    expect(gradeAbsolute('security', unscoped('warning', 9))).toBe('B')
  })

  it('counts only graded findings for the B/C split', () => {
    // Three graded mediums is a C; three advisory ones leave the count at zero.
    expect(gradeAbsolute('security', security('warning', 3))).toBe('C')
    expect(gradeAbsolute('security', unscoped('warning', 3))).toBe('B')
  })

  it('ignores findings from other categories', () => {
    expect(gradeAbsolute('security', makeFindings(1, 'critical', 'lint'))).toBe('A')
  })
})

describe('gradeCategory', () => {
  it('dispatches each shape', () => {
    expect(gradeCategory('lint', { shape: 'density', findings: [], kloc: KLOC })).toBe('A')
    expect(gradeCategory('duplication', { shape: 'ratio', percent: 12 })).toBe('D')
    expect(
      gradeCategory('security', {
        shape: 'absolute',
        findings: makeFindings(1, 'error', 'security'),
      }),
    ).toBe('D')
  })

  it('rejects an input whose shape does not match the category', () => {
    expect(() => gradeCategory('lint', { shape: 'ratio', percent: 1 })).toThrow(/density/)
    expect(() => gradeCategory('security', { shape: 'ratio', percent: 1 })).toThrow(/absolute/)
  })
})

describe('grade ordering', () => {
  it('ranks A best and F worst', () => {
    expect(compareGrades('A', 'F')).toBeLessThan(0)
    expect(compareGrades('C', 'C')).toBe(0)
    const grades: Grade[] = ['F', 'A', 'C']
    expect(grades.toSorted(compareGrades)).toEqual(['A', 'C', 'F'])
  })

  it('answers the --fail-under question', () => {
    expect(isBelow('C', 'B')).toBe(true)
    expect(isBelow('B', 'B')).toBe(false)
    expect(isBelow('A', 'B')).toBe(false)
    expect(isBelow('F', 'E')).toBe(true)
  })
})
