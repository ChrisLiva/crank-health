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
 *
 * **Calibration (v0.1.0).** Every constant below was probed against three
 * pinned OSS repos plus this one, and none moved. The measurements, so the next
 * person to reach for a number starts from evidence rather than from taste:
 *
 * | repo | KLOC | lint | format | types | dead | cplx | dup |
 * |---|---|---|---|---|---|---|---|
 * | zustand v5.0.3 | 8.8 | — | 8.2% | — | 3.98 | 0.08% | 21.7% |
 * | requests v2.32.3 | 11.2 | 5.35 | 30.6% | 27.7 | 0.98 | 2.18% | 2.5% |
 * | datasette 0.65.1 | 39.5 | 7.97 | 53.7% | 74.6 | 0.51 | 4.10% | 2.6% |
 * | crank-health | 22.1 | 0.54 | 1.6% | 0.68 | 7.16 | 0.78% | 4.2% |
 *
 * (density categories in weighted findings/KLOC, ratio categories as their
 * percentage; `—` is a category no tool graded on that repo.)
 *
 * The bands separate these repos the way a reader would: complexity and
 * duplication discriminate cleanly, lint puts two untooled repos at C, and the
 * grades that look harsh — dead code on the two JS/TS libraries, types on the
 * two untyped Python repos — are harsh because of *which findings the tools
 * produce*, not because of where the bands sit. Widening a band to absorb a
 * tool's false positives would encode that tool's defaults into the grading
 * table and desensitize every repo where the same tool is accurate, so the
 * per-category notes below record the cause instead.
 */
export const GRADE_TABLE = {
  /**
   * Weighted findings/KLOC. A ≤1, B ≤5, C ≤15, D ≤40, else F.
   *
   * Calibration: a repo that lints in CI sits near zero (this one, 0.54 → A);
   * the two that do not landed at 5.35 and 7.97 → C, on rules a maintainer
   * would recognize (ruff F401 in re-export shims, F811 in test fixtures). F
   * still means roughly eight errors per KLOC, which nothing well-kept reaches.
   */
  lint: { shape: 'density', bands: { A: 1, B: 5, C: 15, D: 40 } },
  /**
   * Type errors only — warnings and info from a type checker are advisory.
   * Weighted the same way, so one error/KLOC scores 5. A =0, B ≤1, C ≤5, D ≤15.
   *
   * Calibration: untyped Python under `ty` measures 27.7 (requests) and 74.6
   * (datasette) — F, and no band that still distinguishes a type-clean project
   * could rescue either. That is the honest reading of "this code has no type
   * safety", so the band stays; if it should read differently, the question is
   * whether a default-config checker's findings belong in `gradeScope` at all,
   * which is a rule, not a number.
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
   *
   * Calibration: the Python side behaves — vulture's ≥90% tier measured 0.51
   * and 0.98 → B on two large repos. The JS/TS side is inflated by *default*
   * knip and fallow, which have no entry points to reason from: all 35 of
   * zustand's findings (3.98 → C) are its own public entry modules, its tests
   * and its examples, and this repo's 7.16 → D is exports whose only consumers
   * are its own tests. The band is not what is wrong there, so it did not move;
   * the fix is to know a library's entry points, or to make default-config
   * unused-*export* findings advisory — both rules, not constants.
   */
  'dead-code': { shape: 'density', bands: { A: 0.5, B: 2, C: 5, D: 10 } },

  /**
   * % of files failing the formatter. A ≤1, B ≤10, C ≤30, D ≤60.
   *
   * Calibration: the measure is binary per file, so it is bimodal in practice —
   * a repo that formats in CI sits at 0–2% and one that does not sits high.
   * requests (30.6%) and datasette (53.7%) are both *formatted*, just by an
   * older black than ruff-format 0.16 agrees with; D is the right size of
   * complaint for that, and the 60% ceiling keeps F for repos that never format
   * at all.
   */
  format: { shape: 'ratio', bands: { A: 1, B: 10, C: 30, D: 60 } },
  /**
   * % of functions over cognitive complexity 15. A ≤2, B ≤5, C ≤10, D ≤20.
   *
   * Calibration: the cleanest discriminator of the eight — 0.08%, 0.78%, 2.18%,
   * 4.10% across the probe repos, spread neatly over A and B with room left.
   */
  complexity: { shape: 'ratio', bands: { A: 2, B: 5, C: 10, D: 20 } },
  /**
   * jscpd duplicated-token %. A ≤3, B ≤5, C ≤10, D ≤20.
   *
   * Calibration: 2.5%, 2.6% and 4.2% on three repos, and 21.7% → F on zustand,
   * where 120 of 124 clones are its test suite. The F is what the measurement
   * says; jscpd's own default CI threshold (10%) lands on our C/D edge, which is
   * the second opinion this band was checked against.
   */
  duplication: { shape: 'ratio', bands: { A: 3, B: 5, C: 10, D: 20 } },
  /** Mutation score — higher is better. A ≥80, B ≥65, C ≥50, D ≥35. */
  'test-quality': { shape: 'ratio', higherIsBetter: true, bands: { A: 80, B: 65, C: 50, D: 35 } },

  /**
   * Never normalized: one leaked secret is an F in a million-line repo.
   * Secrets are mapped to `critical` by their adapters.
   * any critical → F · any error (high) → D · zero findings → A ·
   * otherwise B while the medium/low counts stay at or under `b`, else C.
   *
   * Calibration: all four probe repos graded D, and none of them reached `b` —
   * the B/C split is the one constant here that real repos never exercised. The
   * D is the frozen rule meeting the tools' own severities (zizmor's
   * `unpinned-uses` is high on any workflow that does not hash-pin its actions;
   * bandit's B602/B608 are high), so no number below can change it. If the
   * category is to discriminate between well-kept repos, the lever is the
   * adapters' severity mapping, not this table.
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
