import type { Category, Finding, Grade, Severity } from './types.ts'
import { GRADES } from './types.ts'

/**
 * THE grade constant table (spec §3). Every threshold in crank-health lives
 * here; changing one is a version bump. Formula *shapes* are fixed, the numbers
 * are calibrated first guesses.
 *
 * Three shapes:
 * - `density` — weighted findings per KLOC, banded `<=`.
 * - `ratio` — a percentage, banded `<=` (or `>=` when higher is better).
 * - `absolute` — security only; counts, never normalized.
 *
 * Only findings with `gradeScope: true` ever count (spec §1): on default
 * configs the style/pedantic rules stay advisory, and low-confidence tiers
 * (vulture 60%) are advisory too.
 */
export const GRADE_TABLE = {
  /** Weighted findings/KLOC. A ≤1, B ≤5, C ≤15, D ≤40, else F. */
  lint: { shape: 'density', bands: { A: 1, B: 5, C: 15, D: 40 } },
  /**
   * Type errors only — warnings and info from a type checker are advisory.
   * Weighted the same way, so one error/KLOC scores 5. A =0, B ≤1, C ≤5, D ≤15.
   */
  types: {
    shape: 'density',
    bands: { A: 0, B: 1, C: 5, D: 15 },
    severities: ['critical', 'error'],
  },
  /**
   * High-confidence dead code only; the low-confidence tier arrives with
   * `gradeScope: false` and is filtered before we get here.
   * A ≤0.5, B ≤2, C ≤5, D ≤10.
   */
  'dead-code': { shape: 'density', bands: { A: 0.5, B: 2, C: 5, D: 10 } },

  /** % of files failing the formatter. A ≤1, B ≤10, C ≤30, D ≤60. */
  format: { shape: 'ratio', bands: { A: 1, B: 10, C: 30, D: 60 } },
  /** % of functions over cognitive complexity 15. A ≤2, B ≤5, C ≤10, D ≤20. */
  complexity: { shape: 'ratio', bands: { A: 2, B: 5, C: 10, D: 20 } },
  /** jscpd duplicated-token %. A ≤3, B ≤5, C ≤10, D ≤20. */
  duplication: { shape: 'ratio', bands: { A: 3, B: 5, C: 10, D: 20 } },
  /** Mutation score — higher is better. A ≥80, B ≥65, C ≥50, D ≥35. */
  'test-quality': { shape: 'ratio', higherIsBetter: true, bands: { A: 80, B: 65, C: 50, D: 35 } },

  /**
   * Never normalized: one leaked secret is an F in a million-line repo.
   * Secrets are mapped to `critical` by their adapters.
   * any critical → F · any error (high) → D · zero findings → A ·
   * otherwise B while the medium/low counts stay at or under `b`, else C.
   */
  security: { shape: 'absolute', b: { warning: 2, info: 10 } },
} as const satisfies Readonly<Record<Category, GradeRule>>

/** Cognitive-complexity ceiling a function must exceed to count (spec §3). */
export const COMPLEXITY_CEILING = 15

/** Weights for the density shape. `critical` shares the error weight. */
export const SEVERITY_WEIGHTS: Readonly<Record<Severity, number>> = {
  critical: 5,
  error: 5,
  warning: 1,
  info: 0.2,
}

type Bands = { readonly A: number; readonly B: number; readonly C: number; readonly D: number }

type GradeRule =
  | { readonly shape: 'density'; readonly bands: Bands; readonly severities?: readonly Severity[] }
  | { readonly shape: 'ratio'; readonly bands: Bands; readonly higherIsBetter?: boolean }
  | {
      readonly shape: 'absolute'
      readonly b: Readonly<Record<'warning' | 'info', number>>
    }

/** The measurement a category needs, shaped like that category's formula. */
export type GradeInput =
  | { readonly shape: 'density'; readonly findings: readonly Finding[]; readonly kloc: number }
  | { readonly shape: 'ratio'; readonly percent: number }
  | { readonly shape: 'absolute'; readonly findings: readonly Finding[] }

/**
 * Grades one category. The input's shape must match the category's shape in
 * {@link GRADE_TABLE} — a mismatch is a programming error, not a data error.
 *
 * @throws {Error} when the input shape does not match the category
 */
export function gradeCategory(category: Category, input: GradeInput): Grade {
  const rule: GradeRule = GRADE_TABLE[category]
  if (rule.shape !== input.shape) {
    throw new Error(
      `category "${category}" grades on ${rule.shape} input, got ${input.shape} input`,
    )
  }
  switch (input.shape) {
    case 'density':
      return gradeDensity(category, input.findings, input.kloc)
    case 'ratio':
      return gradeRatio(category, input.percent)
    case 'absolute':
      return gradeAbsolute(category, input.findings)
  }
}

/**
 * Weighted findings per KLOC, banded. Advisory findings and (for `types`)
 * out-of-scope severities drop out first.
 *
 * With no in-scope findings the grade is A regardless of size; with findings
 * but no measurable code (kloc ≤ 0) the density is unbounded, so F.
 */
export function gradeDensity(
  category: Category,
  findings: readonly Finding[],
  kloc: number,
): Grade {
  const rule = ruleOfShape(category, 'density')
  const counted = graded(findings, category).filter(
    (finding) => rule.severities === undefined || rule.severities.includes(finding.severity),
  )
  if (counted.length === 0) return 'A'
  if (kloc <= 0) return 'F'
  return band(weightedCount(counted) / kloc, rule.bands, false)
}

/** Sum of severity weights. Exported so reports can show the raw measure. */
export function weightedCount(findings: readonly Finding[]): number {
  return findings.reduce((total, finding) => total + SEVERITY_WEIGHTS[finding.severity], 0)
}

/**
 * Bands a percentage. `test-quality` is inverted (mutation score: higher is
 * better); every other ratio category is "percent bad, lower is better".
 */
export function gradeRatio(category: Category, percent: number): Grade {
  const rule = ruleOfShape(category, 'ratio')
  return band(percent, rule.bands, rule.higherIsBetter === true)
}

/**
 * Security, never normalized (spec §3): any critical (secrets map to critical)
 * → F; any error/high → D; zero graded findings → A; otherwise B or C by the
 * medium/low counts.
 */
export function gradeAbsolute(category: Category, findings: readonly Finding[]): Grade {
  const rule = ruleOfShape(category, 'absolute')
  const counted = graded(findings, category)
  if (counted.some((finding) => finding.severity === 'critical')) return 'F'
  if (counted.some((finding) => finding.severity === 'error')) return 'D'
  if (counted.length === 0) return 'A'
  const warnings = counted.filter((finding) => finding.severity === 'warning').length
  const infos = counted.filter((finding) => finding.severity === 'info').length
  return warnings <= rule.b.warning && infos <= rule.b.info ? 'B' : 'C'
}

/**
 * Share of files that fail, as a percentage — the `format` denominator. Files
 * are counted once no matter how many findings they carry.
 */
export function failingFilePercent(
  findings: readonly Finding[],
  category: Category,
  totalFiles: number,
): number {
  if (totalFiles <= 0) return 0
  const failing = new Set(graded(findings, category).map((finding) => finding.file))
  return (failing.size / totalFiles) * 100
}

/** Rank of a grade, best (0) to worst. */
export function gradeRank(grade: Grade): number {
  return GRADES.indexOf(grade)
}

/** Negative when `a` is better than `b`. Sorts worst-first with `-compare`. */
export function compareGrades(a: Grade, b: Grade): number {
  return gradeRank(a) - gradeRank(b)
}

/** The `--fail-under <threshold>` test: is this grade strictly worse? */
export function isBelow(grade: Grade, threshold: Grade): boolean {
  return gradeRank(grade) > gradeRank(threshold)
}

/** In-scope findings for a category: graded ones only, and only this category. */
function graded(findings: readonly Finding[], category: Category): readonly Finding[] {
  return findings.filter((finding) => finding.gradeScope && finding.category === category)
}

function band(value: number, bands: Bands, higherIsBetter: boolean): Grade {
  for (const letter of ['A', 'B', 'C', 'D'] as const) {
    const threshold = bands[letter]
    if (higherIsBetter ? value >= threshold : value <= threshold) return letter
  }
  return 'F'
}

function ruleOfShape<S extends GradeRule['shape']>(
  category: Category,
  shape: S,
): Extract<GradeRule, { shape: S }> {
  const rule: GradeRule = GRADE_TABLE[category]
  if (rule.shape !== shape) {
    throw new Error(`category "${category}" is not graded on ${shape} input`)
  }
  return rule as Extract<GradeRule, { shape: S }>
}
