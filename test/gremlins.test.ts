import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GREMLINS_TOOL, gremlinsOutcome, parseGremlinsReport } from '../src/adapters/go/gremlins.ts'
import { GO_COVERAGE_REASON, parseCoverageTotal } from '../src/adapters/go/go-test.ts'
import { mutationCounts } from '../src/adapters/mutation-report.ts'

/**
 * The deep tier's two Go readers, over bytes rather than a machine: gremlins'
 * machine-readable report, and the total line `go tool cover -func` prints.
 *
 * The capture is the real thing — `test/captured/gremlins-0.6.0.json` came out
 * of the pinned v0.6.0 binary on the scratch module `deep-go-e2e.test.ts`
 * builds — and {@link GREMLINS_STATUSES} is transcribed from those bytes. That
 * transcription is the point: the status strings gremlins prints are its own
 * vocabulary, and the mapping onto the shared `MutantStatus` union is only
 * trustworthy while the list it was written against is the list the tool emits.
 */

const CAPTURE = await readFile(join(import.meta.dirname, 'captured', 'gremlins-0.6.0.json'), 'utf8')

/**
 * Every distinct `status` string in the capture, transcribed from the bytes.
 * A v0.6.0 that grows a seventh status fails here rather than being silently
 * dropped into a count.
 */
const GREMLINS_STATUSES: readonly string[] = ['KILLED', 'LIVED', 'NOT COVERED']

describe('the captured gremlins report', () => {
  it('carries exactly the statuses this release was mapped against', () => {
    const document = JSON.parse(CAPTURE) as GremlinsDocument

    expect(
      [
        ...new Set(document.files.flatMap((file) => file.mutations.map((m) => m.status))),
      ].toSorted(),
    ).toEqual(GREMLINS_STATUSES)
  })

  /**
   * One mutant per reported mutation, each carrying a status from the shared
   * vocabulary — `LIVED` is a survivor, `NOT COVERED` is an uncovered mutant,
   * and neither word appears in the report crank-health writes.
   */
  it('maps every captured mutation onto the shared status vocabulary', () => {
    const parsed = parseGremlinsReport(CAPTURE)

    expect('mutants' in parsed).toBe(true)
    expect(
      mutantsOf(parsed).map((mutant) => [mutant.file, mutant.startLine, mutant.status]),
    ).toEqual([
      ['calc.go', 4, 'Survived'],
      ['calc.go', 4, 'Killed'],
      ['calc.go', 8, 'NoCoverage'],
      ['calc.go', 8, 'NoCoverage'],
      ['calc.go', 15, 'Killed'],
    ])
    expect(mutantsOf(parsed).map((mutant) => mutant.mutatorName)).toEqual([
      'CONDITIONALS_BOUNDARY',
      'CONDITIONALS_NEGATION',
      'CONDITIONALS_BOUNDARY',
      'CONDITIONALS_NEGATION',
      'ARITHMETIC_BASE',
    ])
  })

  /**
   * The counts go through the shared `mutationCounts`, so "detected" means the
   * same thing for a Go mutant as for a C# one: killed and timed out count,
   * survived and never-covered do not.
   */
  it('counts the capture the way every other mutation run is counted', () => {
    expect(mutationCounts(mutantsOf(parseGremlinsReport(CAPTURE)))).toEqual({
      detected: 2,
      undetected: 3,
    })
  })

  /** A mutant under a nested package, with a name no friendly fixture has. */
  it('keeps a hostile file name and a deep position intact', () => {
    const hostile = JSON.stringify({
      files: [
        {
          file_name: 'internal/ünïcode dir/naïve_café.go',
          mutations: [{ type: 'ARITHMETIC_BASE', status: 'KILLED', line: 98_765, column: 4321 }],
        },
      ],
    })

    expect(mutantsOf(parseGremlinsReport(hostile, 'pkg/sub'))).toEqual([
      {
        file: 'pkg/sub/internal/ünïcode dir/naïve_café.go',
        mutatorName: 'ARITHMETIC_BASE',
        replacement: '',
        status: 'Killed',
        startLine: 98_765,
        startCol: 4321,
        endLine: 98_765,
        endCol: 4321,
      },
    ])
  })

  /** Nothing to read is no mutants — never a status invented to fill a count. */
  it('reads an empty or shapeless document as no mutants at all', () => {
    for (const text of ['', '{}', 'not json at all', '{"files":[]}']) {
      expect(parseGremlinsReport(text)).toEqual({ mutants: [] })
    }
  })

  /**
   * The one thing a mutation reader must never do is guess. An unrecognised
   * status is returned as itself, and the runner turns it into an `error` that
   * names the string — not a mutant quietly outside both counts.
   */
  it('refuses an unrecognised status rather than miscounting it', () => {
    const rewritten = CAPTURE.replace('"KILLED"', '"exploded"')

    expect(parseGremlinsReport(rewritten)).toEqual({ unknownStatus: 'exploded' })
  })

  it('turns that refusal into an errored tool record naming the status', () => {
    const outcome = gremlinsOutcome(ok(), CAPTURE.replace('"KILLED"', '"exploded"'))

    expect(Array.isArray(outcome)).toBe(false)
    expect(outcome).toMatchObject({ state: 'error' })
    expect(failureOf(outcome).reason).toContain('exploded')
    expect(failureOf(outcome).reason).toContain(GREMLINS_TOOL)
  })

  /** A run that produced no mutants measured nothing — and says so. */
  it('refuses to read a run with no mutants as a score', () => {
    expect(failureOf(gremlinsOutcome(ok(), '{"files":[]}')).state).toBe('error')
    expect(failureOf(gremlinsOutcome(ok(), undefined)).state).toBe('error')
  })

  /** A non-zero exit is the run's own verdict, quoted rather than parsed over. */
  it('reports a failed gremlins run by its exit code and first stderr line', () => {
    const outcome = gremlinsOutcome(
      { stdout: '', stderr: 'go: downloading example.com/x v1.0.0\nERROR: boom\n', exitCode: 1 },
      undefined,
    )

    expect(failureOf(outcome).state).toBe('error')
    // Fetch narration is not evidence about the repo: a cold module cache must
    // not change what `report.json` says.
    expect(failureOf(outcome).reason).toContain('ERROR: boom')
    expect(failureOf(outcome).reason).not.toContain('downloading')
  })
})

/**
 * `go tool cover -func` prints one line per function and a `total:` line last.
 * The total is the only number the report keeps, and it is addressed by its
 * label — a positional read of the last line would break the first time the
 * toolchain appended a note after it.
 */
describe('the go test coverage total', () => {
  it('reads the total percentage, including a floor of zero', () => {
    expect(parseCoverageTotal('total:\t\t\t\t(statements)\t0.0%\n')).toBe(0)
    expect(parseCoverageTotal('total:\t\t\t\t(statements)\t83.3%\n')).toBe(83.3)
  })

  it('reads the total, not the first function line above it', () => {
    const output = [
      'example.com/weaklib/calc.go:3:\tIsPositive\t100.0%',
      'example.com/weaklib/calc.go:7:\tMax\t\t0.0%',
      'total:\t\t\t\t(statements)\t40.0%',
      '',
    ].join('\n')

    expect(parseCoverageTotal(output)).toBe(40)
  })

  it('has no answer when nothing measured', () => {
    expect(parseCoverageTotal('')).toBeUndefined()
    expect(
      parseCoverageTotal('example.com/weaklib/calc.go:3:\tIsPositive\t100.0%\n'),
    ).toBeUndefined()
  })

  /** The honesty sentence a reader of `lineCoveragePercent` needs. */
  it('says which coverage Go actually measured', () => {
    expect(GO_COVERAGE_REASON).toBe(
      'Go reports statement coverage; recorded as the shared line-coverage context metric',
    )
  })
})

interface GremlinsDocument {
  readonly files: { readonly mutations: { readonly status: string }[] }[]
}

function ok() {
  return { stdout: '', stderr: '', exitCode: 0 }
}

function mutantsOf(parsed: ReturnType<typeof parseGremlinsReport>) {
  if (!('mutants' in parsed)) throw new Error(`unexpected unknown status: ${parsed.unknownStatus}`)
  return parsed.mutants
}

function failureOf(outcome: ReturnType<typeof gremlinsOutcome>) {
  if (Array.isArray(outcome)) throw new Error('expected a failure, got mutants')
  return outcome
}
