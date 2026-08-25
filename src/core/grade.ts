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
 *
 * **Re-probe (v0.2.0).** The three OSS repos again, at the same pinned tags,
 * after the v0.2.0 rule changes: zizmor's unpinned-* hygiene audits demoted to
 * warning, bandit's high severity gated on high confidence, a library's unused
 * *export* findings made advisory, and our default linter put on standby behind
 * a repo-owned one. No constant moved. The categories no rule touched came back
 * identical to the v0.1.0 column (requests lint 5.35 and format 30.6%,
 * datasette 7.97 and 53.7%, every complexity and duplication cell), which is
 * what says the two columns below are the rules and not the weather:
 *
 * | repo | security | dead |
 * |---|---|---|
 * | zustand v5.0.3 | D (47 graded: 1 error, 46 warning) | 3.98 |
 * | requests v2.32.3 | D (131 graded: 4 error, 127 warning) | 0.98 |
 * | datasette 0.65.1 | D (111 graded: 9 error, 102 warning) | 0.51 |
 *
 * (security is the absolute shape, so its cell is the grade and the counts it
 * was read from; dead code is weighted findings/KLOC as above. Probed on a
 * machine with none of gitleaks, opengrep or osv-scanner on PATH.)
 *
 * One measurement outside those two categories is worth recording: zustand's
 * lint, `—` in v0.1.0 because its own eslint cannot run without an install, is
 * now F — eslint errored and oxlint came off standby to grade the category on
 * our default config, which the report says in as many words.
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
   *
   * Re-probe (v0.2.0): unmoved — zustand v5.0.3 3.98, requests v2.32.3 0.98,
   * datasette 0.65.1 0.51. Making a library's unused-*export* findings advisory
   * did not touch zustand, because all 35 of its findings are knip
   * `unused-file`, whose scope turns on whether knip resolved *an* entry point,
   * not on whether the package publishes one. They are still its published
   * modules (`src/middleware.ts`, `src/shallow.ts`, `src/traditional.ts`, …),
   * its tests and its examples — the same false positive, reached by a rule the
   * library check does not cover. Still a rule, still not this constant.
   */
  // Both default dead-code tools name the same export; one symbol is one
  // graded finding. The first tool in adapter order keeps the row, unless the
  // two disagree on gradeScope: then the graded row and the advisory row both
  // stand rather than the advisory one replacing the grade.
  'dead-code': { shape: 'density', bands: { A: 0.5, B: 2, C: 5, D: 10 }, oneDefectPerAnchor: true },

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
   * any graded critical → F · any graded error (high) → D · zero findings of
   * any kind → A · otherwise B while the graded medium/low counts stay at or
   * under `b`, else C.
   *
   * Every tier but the A reads graded findings only; see {@link gradeAbsolute}
   * for why a demoted advisory stopped minting D. The probe cells below already
   * quote *graded* counts ("4 error of 131 graded"), so that change moves none
   * of the calibration recorded here.
   *
   * Calibration: all four probe repos graded D, and none of them reached `b` —
   * the B/C split is the one constant here that real repos never exercised. The
   * D is the frozen rule meeting the tools' own severities (zizmor's
   * `unpinned-uses` is high on any workflow that does not hash-pin its actions;
   * bandit's B602/B608 are high), so no number below can change it. If the
   * category is to discriminate between well-kept repos, the lever is the
   * adapters' severity mapping, not this table.
   *
   * Re-probe (v0.2.0), after that lever was pulled: all three OSS repos still
   * D, but requests v2.32.3 (4 error of 131 graded) and datasette 0.65.1 (9 of
   * 111) now hold it on bandit findings that are high severity *and* high
   * confidence — B324 weak MD5/SHA1, B602 `shell=True` — which is a D a
   * maintainer would recognize. zizmor's `unpinned-uses` no longer counts
   * toward it anywhere. What still needs an eye is zustand v5.0.3 (1 error of
   * 47): its whole D rests on one zizmor `cache-poisoning`, high severity at
   * *low* confidence, so the severity mapping has one more question in it than
   * v0.2.0 answered. No probe repo reached `b`, so the B/C split remains the
   * one constant here that a real repo has never exercised.
   */
  security: { shape: 'absolute', b: { warning: 2, info: 10 } },
} as const satisfies Readonly<Record<Category, GradeRule>>

/**
 * Cognitive-complexity ceiling a function must exceed to count (spec §3).
 *
 * One honesty note: the ceiling is documented as **cognitive** complexity, and
 * that is what the JS/TS and Python tools (fta, complexipy) measure — but C#'s
 * CA1502 reports **cyclomatic** complexity, and the two metrics are not
 * interchangeable: cyclomatic counts branches wherever they sit, so it skews
 * lenient on deeply-nested code that cognitive complexity penalizes extra.
 * C# grades against this shared ceiling anyway, deliberately, so that one
 * letter means one thing across a mixed repo; the cost is that a C# function
 * just under 15 cyclomatic may read harder than the same grade suggests.
 */
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
  | {
      readonly shape: 'density'
      readonly bands: Bands
      readonly severities?: readonly Severity[]
      readonly oneDefectPerAnchor?: true
    }
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
 * Whether this category counts one defect per source anchor, so a second tool
 * naming a symbol the first already named adds no finding. The rule lives in
 * {@link GRADE_TABLE} and the union that carries it is module-local, so callers
 * outside this file read the answer as a boolean rather than the shape.
 */
export function dedupesByAnchor(category: Category): boolean {
  const rule: GradeRule = GRADE_TABLE[category]
  return rule.shape === 'density' && rule.oneDefectPerAnchor === true
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
 * Security, never normalized (spec §3): any graded secret or critical → F; any
 * graded high → at best D; else A/B/C by the medium/low counts, and **A means
 * zero findings of any kind**.
 *
 * **Why the tiers count graded findings only.** They did not always. Under
 * schema 1 every finding lived in one `findings[]` array behind a `gradeScope`
 * boolean, so "the grade ignored it" and "the report barely mentioned it" were
 * nearly the same thing — and a category reading `security: A` above a listed
 * critical was the failure this whole shape exists to prevent. Reading every
 * severity was the cheap guard against that.
 *
 * It bought the guard at a price the guard did not need to cost. A finding is
 * demoted for exactly one kind of reason: the work does not exist or nobody is
 * exposed — a dependency no published version fixes, a vulnerable package the
 * module never imports (`adapters/common/govulncheck.ts`), a dev-only one. A D
 * minted from those says "someone is exposed here" over evidence saying the
 * opposite, and — this is the part that made it a defect rather than a
 * conservative choice — *no amount of real work could clear it*. A grade nobody
 * can move is not a grade; it is a permanent mark, and readers learn to ignore
 * the category rather than act on it.
 *
 * Schema 2 removed the reason for the old guard. Graded rows are `findings[]`
 * and demoted ones are `advisories[]`, each with its receipt — the missing fix,
 * the reachability verdict — in its own message. The honest record is the
 * `advisories[]` entry, not a letter that misdescribes it.
 *
 * What survives unchanged is the floor the guard was really protecting: **A is
 * reserved for a category with nothing in it at all**, and that check still
 * reads every finding whatever its scope. A repo with advisory findings and no
 * graded ones lands at B — something was found, and the grade must not read the
 * same as a clean scan. A secret is never demoted by any runner, so a leaked
 * credential still arrives here graded and still mints F.
 */
export function gradeAbsolute(category: Category, findings: readonly Finding[]): Grade {
  const rule = ruleOfShape(category, 'absolute')
  const inCategory = findings.filter((finding) => finding.category === category)
  const counted = graded(findings, category)
  if (counted.some((finding) => finding.severity === 'critical')) return 'F'
  if (counted.some((finding) => finding.severity === 'error')) return 'D'
  // Deliberately every finding, not the graded ones: see above.
  if (inCategory.length === 0) return 'A'
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
