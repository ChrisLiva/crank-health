import type { PendingFinding } from '../core/types.ts'
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  byLocation,
  compare,
  repoRelative,
} from './support.ts'

/**
 * The mutation-testing-elements report schema — the `mutation-report.json`
 * every Stryker writes, whichever language it mutated. StrykerJS's `json`
 * reporter (`jsts/stryker.ts`) and Stryker.NET's `--reporter json`
 * (`csharp/stryker-net.ts`) emit the same document, so the schema is decoded
 * once here: two parsers would be two chances to disagree about what
 * `Survived` means. The only tool-specific fact in a mutant finding is which
 * tool reported it, and that is the one parameter
 * {@link toPendingFindings} takes.
 */

/** The rule ids mutant findings report under. */
export const SURVIVED_RULE = 'stryker/survived-mutant'
export const NO_COVERAGE_RULE = 'stryker/no-coverage-mutant'
export const TIMEOUT_RULE = 'stryker/timeout-mutant'

/**
 * Survived mutants listed as findings. Every one of them is a real gap, and a
 * repo with a weak suite has thousands: the grade is the score, the findings
 * are the evidence, and a reader needs enough of it to start rather than all of
 * it. The rest stay in the restaged raw report.
 */
export const SURVIVED_FINDING_LIMIT = 50

/** The same, for the advisory kinds (not covered, timed out). */
export const ADVISORY_FINDING_LIMIT = 25

/** One mutant, as the mutation-testing-elements report describes it. */
export interface Mutant {
  /** Repo-relative posix path of the file the mutant is in. */
  readonly file: string
  /** The mutator, e.g. `ArithmeticOperator`, `ConditionalExpression`. */
  readonly mutatorName: string
  /** The source the mutator substituted in, when the report carries it. */
  readonly replacement: string
  readonly status: MutantStatus
  readonly startLine: number
  readonly startCol: number
  readonly endLine: number
  readonly endCol: number
}

/**
 * The statuses of the mutation-testing-elements schema. `Killed` and `Timeout`
 * are *detected* (the suite noticed), `Survived` and `NoCoverage` are not; the
 * rest are mutants that never got a verdict and are outside the score entirely.
 */
export type MutantStatus =
  | 'Killed'
  | 'Survived'
  | 'NoCoverage'
  | 'Timeout'
  | 'CompileError'
  | 'RuntimeError'
  | 'Ignored'
  | 'Pending'

/**
 * Parses a `mutation-report.json` (mutation-testing-elements schema, the format
 * Stryker's `json` reporters write). Exported so a format shift fails a test
 * instead of silently emptying the score (plan M9 checks).
 *
 * @throws {Error} when the payload is not a mutation report
 */
export function parseMutationReport(text: string, repoRoot = ''): Mutant[] {
  const files = asRecord(asRecord(JSON.parse(text))?.['files'])
  if (files === undefined) throw new Error('no files object in the mutation report')

  const mutants: Mutant[] = []
  for (const [name, entry] of Object.entries(files)) {
    const file = repoRelative(name, repoRoot)
    for (const raw of asArray(asRecord(entry)?.['mutants']) ?? []) {
      const mutant = asRecord(raw)
      const status = asString(mutant?.['status'])
      if (mutant === undefined || status === undefined) continue

      const location = asRecord(mutant['location'])
      const start = asRecord(location?.['start'])
      const end = asRecord(location?.['end'])
      const startLine = asNumber(start?.['line']) ?? 1
      const startCol = asNumber(start?.['column']) ?? 1
      mutants.push({
        file,
        mutatorName: asString(mutant['mutatorName']) ?? 'unknown',
        replacement: asString(mutant['replacement']) ?? '',
        status: status as MutantStatus,
        startLine,
        startCol,
        endLine: asNumber(end?.['line']) ?? startLine,
        endCol: asNumber(end?.['column']) ?? startCol,
      })
    }
  }
  return mutants.toSorted(
    (a, b) => compare(a.file, b.file) || a.startLine - b.startLine || a.startCol - b.startCol,
  )
}

/** The two numbers the mutation score is a ratio of. */
export interface MutationCounts {
  /** Killed plus timed out: the suite noticed the change. */
  readonly detected: number
  /** Survived plus never covered: it did not. */
  readonly undetected: number
}

/**
 * Counts mutants the way the mutation-testing-elements score is defined:
 * detected over detected-plus-undetected. Mutants that never ran (compile
 * errors, ignored, pending) are in neither — they are facts about the run, not
 * about the tests.
 */
export function mutationCounts(mutants: readonly Mutant[]): MutationCounts {
  return {
    detected: mutants.filter((mutant) => mutant.status === 'Killed' || mutant.status === 'Timeout')
      .length,
    undetected: mutants.filter(
      (mutant) => mutant.status === 'Survived' || mutant.status === 'NoCoverage',
    ).length,
  }
}

/**
 * Mutants → the core's vocabulary, reported under `tool`. The grade is the
 * score (a ratio over the metrics), so `gradeScope` here is the reader's label:
 * a survived mutant is one of the things the score is made of, and the advisory
 * kinds are not.
 *
 * Each list is capped separately, because a repo with ten thousand uncovered
 * mutants would otherwise bury the fifty that have tests and beat them.
 */
export function toPendingFindings(mutants: readonly Mutant[], tool: string): PendingFinding[] {
  const survived = mutants
    .filter((mutant) => mutant.status === 'Survived')
    .map((mutant) => ({
      ...common(mutant, tool),
      rule: SURVIVED_RULE,
      severity: 'warning' as const,
      message: `Mutant survived: ${mutant.mutatorName} replaced this with ${quote(mutant.replacement)} and every test still passed`,
      gradeScope: true,
    }))
    .toSorted(byLocation)
    .slice(0, SURVIVED_FINDING_LIMIT)

  const advisory = mutants
    .filter((mutant) => mutant.status === 'NoCoverage' || mutant.status === 'Timeout')
    .map((mutant) => ({
      ...common(mutant, tool),
      rule: mutant.status === 'NoCoverage' ? NO_COVERAGE_RULE : TIMEOUT_RULE,
      severity: 'info' as const,
      message:
        mutant.status === 'NoCoverage'
          ? `No test covers this: the ${mutant.mutatorName} mutant here was never executed`
          : `The ${mutant.mutatorName} mutant here timed out — counted as detected, but a timeout can also mean a slow or hanging test`,
      gradeScope: false,
    }))
    .toSorted(byLocation)
    .slice(0, ADVISORY_FINDING_LIMIT)

  return [...survived, ...advisory].toSorted(byLocation)
}

/** The fields every mutant finding shares. Provenance is always the repo's. */
function common(mutant: Mutant, tool: string) {
  return {
    category: 'test-quality' as const,
    tool,
    file: mutant.file,
    range: {
      startLine: mutant.startLine,
      startCol: mutant.startCol,
      endLine: mutant.endLine,
      endCol: mutant.endCol,
    },
    // A Stryker only ever runs on a repo that owns it, with that repo's config.
    provenance: 'repo-config' as const,
  }
}

/** A replacement, on one line and short enough to read in a list. */
function quote(replacement: string): string {
  const text = replacement.replaceAll(/\s+/g, ' ').trim()
  if (text.length === 0) return 'nothing'
  return `\`${text.length > 60 ? `${text.slice(0, 57)}…` : text}\``
}
