import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  SURVIVED_FINDING_LIMIT,
  buildStrykerOverrides,
  mutateScope,
  mutationCounts,
  parseMutationReport,
  renderStrykerConfig,
  strykerRunner,
  toPendingFindings,
} from '../src/adapters/jsts/stryker.ts'
import type { Mutant } from '../src/adapters/jsts/stryker.ts'
import type { RunContext } from '../src/core/types.ts'
import { makeProject } from './factories.ts'

/**
 * StrykerJS wrapper: the captured `mutation-report.json` a real 9.6.1 run of the
 * `js-weak-tests` fixture produced, the config crank-health generates for it,
 * and the PR scoping. Everything here is a pure function over bytes or options,
 * so a format or flag shift fails a test instead of corrupting a grade.
 */

const CAPTURED = fileURLToPath(new URL('./captured/stryker-9.6.1.json', import.meta.url))

const CONTEXT: RunContext = {
  repoRoot: '/repo',
  project: makeProject(['src/calc.js', 'src/other.ts', 'test/calc.test.js', 'README.md']),
  files: ['src/calc.js', 'src/other.ts', 'test/calc.test.js', 'README.md'],
  scratch: '/scratch',
  runScratch: '/scratch',
  detection: null,
  timeoutMs: 1_000,
  deep: true,
}

describe('parsing a mutation report', () => {
  it('reads every mutant, with its file, mutator, status and location', async () => {
    const mutants = parseMutationReport(await readFile(CAPTURED, 'utf8'))

    expect(mutants).toHaveLength(25)
    expect(new Set(mutants.map((entry) => entry.file))).toEqual(new Set(['src/calc.js']))
    expect(mutants[0]).toMatchObject({
      file: 'src/calc.js',
      mutatorName: 'BlockStatement',
      startLine: 1,
    })
    // Stable order: file, then position — never the order Stryker reported.
    const positions = mutants.map((entry) => [entry.startLine, entry.startCol])
    expect(positions).toEqual([...positions].toSorted((a, b) => a[0]! - b[0]! || a[1]! - b[1]!))
  })

  it('counts the fixture’s weak suite as 7 detected and 18 undetected', async () => {
    const counts = mutationCounts(parseMutationReport(await readFile(CAPTURED, 'utf8')))
    expect(counts).toEqual({ detected: 7, undetected: 18 })
  })

  it('rejects a payload that is not a mutation report', () => {
    expect(() => parseMutationReport('{"mutants": []}')).toThrow(/files/)
  })

  it('scores detected over detected-plus-undetected, ignoring mutants with no verdict', () => {
    const counts = mutationCounts([
      mutant({ status: 'Killed' }),
      mutant({ status: 'Timeout' }),
      mutant({ status: 'Survived' }),
      mutant({ status: 'NoCoverage' }),
      mutant({ status: 'CompileError' }),
      mutant({ status: 'Ignored' }),
    ])
    expect(counts).toEqual({ detected: 2, undetected: 2 })
  })
})

describe('mutants as findings', () => {
  it('grades survived mutants and keeps the other kinds advisory', async () => {
    const findings = toPendingFindings(parseMutationReport(await readFile(CAPTURED, 'utf8')))

    expect(findings).toHaveLength(18)
    expect(findings.every((finding) => finding.category === 'test-quality')).toBe(true)
    expect(findings.every((finding) => finding.provenance === 'repo-config')).toBe(true)
    expect(findings.every((finding) => finding.rule === 'stryker/survived-mutant')).toBe(true)
    expect(findings.every((finding) => finding.gradeScope)).toBe(true)
    expect(findings[0]?.message).toMatch(/^Mutant survived: \w+ replaced this with/)
  })

  it('names the mutator and the replacement, and keeps the message on one line', () => {
    const [finding] = toPendingFindings([
      mutant({
        status: 'Survived',
        mutatorName: 'ArithmeticOperator',
        replacement: 'a -\n  b',
      }),
    ])
    expect(finding?.message).toBe(
      'Mutant survived: ArithmeticOperator replaced this with `a - b` and every test still passed',
    )
  })

  it('reports uncovered and timed-out mutants as advisory, never as graded', () => {
    const findings = toPendingFindings([
      mutant({ status: 'NoCoverage', startLine: 3 }),
      mutant({ status: 'Timeout', startLine: 4 }),
    ])
    expect(findings.map((finding) => [finding.rule, finding.severity, finding.gradeScope])).toEqual(
      [
        ['stryker/no-coverage-mutant', 'info', false],
        ['stryker/timeout-mutant', 'info', false],
      ],
    )
  })

  it('caps the survived list so one weak file cannot bury the report', () => {
    const many = Array.from({ length: SURVIVED_FINDING_LIMIT + 25 }, (_, index) =>
      mutant({ status: 'Survived', startLine: index + 1 }),
    )
    const findings = toPendingFindings(many)
    expect(findings).toHaveLength(SURVIVED_FINDING_LIMIT)
    // The cap keeps the first ones by position, so it is the same 50 every run.
    expect(findings.at(-1)?.range.startLine).toBe(SURVIVED_FINDING_LIMIT)
  })
})

describe('the generated Stryker config', () => {
  const overrides = buildStrykerOverrides({
    workingDir: '/scratch/stryker',
    reportPath: '/scratch/stryker/mutation-report.json',
  })

  it('sends every byte Stryker writes into the scratch dir (spec §7)', () => {
    expect(overrides).toMatchObject({
      reporters: ['json'],
      jsonReporter: { fileName: '/scratch/stryker/mutation-report.json' },
      tempDirName: '/scratch/stryker/stryker-tmp',
      cleanTempDir: 'always',
      // An incremental file would have to live in the target to be worth having.
      incremental: false,
      fileLogLevel: 'off',
    })
    expect(overrides.mutate).toBeUndefined()
  })

  it('inlines a JSON config so the repo’s own settings survive', () => {
    const module = renderStrykerConfig(overrides, {
      kind: 'inline',
      config: { testRunner: 'vitest', coverageAnalysis: 'perTest' },
    })
    expect(module).toContain('"testRunner": "vitest"')
    expect(module).toContain('export default { ...base, ...{')
    // Ours wins: the overrides are spread last.
    expect(module.indexOf('"testRunner"')).toBeLessThan(module.indexOf('"tempDirName"'))
  })

  it('imports a JS config from Stryker’s own process rather than ours', () => {
    const module = renderStrykerConfig(overrides, {
      kind: 'module',
      url: 'file:///repo/stryker.config.js',
    })
    expect(module).toContain('await import("file:///repo/stryker.config.js")')
    expect(module).toContain('loaded.default ?? loaded')
  })

  it('falls back to an empty base when the repo owns Stryker without a config', () => {
    expect(renderStrykerConfig(overrides, undefined)).toContain('const base = {}')
  })
})

describe('PR scoping', () => {
  it('leaves the repo’s own mutate setting alone in a whole-repo scan', () => {
    expect(mutateScope(CONTEXT)).toBeUndefined()
  })

  it('mutates only the changed source files, never the tests', () => {
    expect(
      mutateScope({
        ...CONTEXT,
        changedFiles: ['src/calc.js', 'test/calc.test.js', 'README.md', 'src/gone.ts'],
      }),
    ).toEqual(['src/calc.js'])
  })

  it('scopes to nothing when a change touched no mutable file', () => {
    expect(mutateScope({ ...CONTEXT, changedFiles: ['README.md'] })).toEqual([])
  })
})

describe('the runner’s posture', () => {
  it('is deep-only and never imposed on a repo that did not choose it', () => {
    expect(strykerRunner).toMatchObject({
      category: 'test-quality',
      deepOnly: true,
      repoOwnedOnly: true,
    })
  })

  it('declines in the quick profile instead of executing repo code', async () => {
    const result = await strykerRunner.run({ ...CONTEXT, deep: false })
    expect(result).toMatchObject({ state: 'not-available', findings: [] })
    expect(result.reason).toContain('--deep')
  })

  it('explains what to install when the repo declares Stryker but has not', async () => {
    const result = await strykerRunner.run({
      ...CONTEXT,
      detection: { reason: 'dependency', configFiles: [], installed: false },
    })
    expect(result).toMatchObject({ state: 'not-available' })
    expect(result.reason).toContain('npm install')
  })
})

function mutant(overrides: Partial<Mutant> = {}): Mutant {
  return {
    file: 'src/calc.js',
    mutatorName: 'ConditionalExpression',
    replacement: 'true',
    status: 'Survived',
    startLine: 1,
    startCol: 1,
    endLine: 1,
    endCol: 5,
    ...overrides,
  }
}
