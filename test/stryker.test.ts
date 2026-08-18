import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  STRYKER_TOOL,
  buildStrykerOverrides,
  mutateScope,
  renderStrykerConfig,
  strykerRunner,
} from '../src/adapters/jsts/stryker.ts'
import type { StrykerBaseConfig } from '../src/adapters/jsts/stryker.ts'
import {
  SURVIVED_FINDING_LIMIT,
  mutationCounts,
  parseMutationReport,
  toPendingFindings,
} from '../src/adapters/mutation-report.ts'
import type { Mutant } from '../src/adapters/mutation-report.ts'
import type { RunContext } from '../src/core/types.ts'
import { makeProject } from './factories.ts'

/**
 * StrykerJS wrapper: the captured `mutation-report.json` a real 10.0.0 run of
 * the `js-weak-tests` fixture produced, the config crank-health generates for
 * it, and the PR scoping. Everything here is a pure function over bytes or
 * options, so a format or flag shift fails a test instead of corrupting a grade.
 */

const CAPTURED = fileURLToPath(new URL('./captured/stryker-10.0.0.json', import.meta.url))

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
    const findings = toPendingFindings(
      parseMutationReport(await readFile(CAPTURED, 'utf8')),
      STRYKER_TOOL,
    )

    expect(findings).toHaveLength(18)
    expect(findings.every((finding) => finding.tool === STRYKER_TOOL)).toBe(true)
    expect(findings.every((finding) => finding.category === 'test-quality')).toBe(true)
    expect(findings.every((finding) => finding.provenance === 'repo-config')).toBe(true)
    expect(findings.every((finding) => finding.rule === 'stryker/survived-mutant')).toBe(true)
    expect(findings.every((finding) => finding.gradeScope)).toBe(true)
    expect(findings[0]?.message).toMatch(/^Mutant survived: \w+ replaced this with/)
  })

  /**
   * A replacement is arbitrary source: it can span lines and it can be a whole
   * function body. Neither may break a finding list, so the quoted form is
   * flattened to one line and elided past 60 characters.
   */
  it('flattens a multi-line replacement and elides an over-long one', () => {
    const [multiline] = toPendingFindings(
      [mutant({ status: 'Survived', replacement: 'a -\n  b' })],
      STRYKER_TOOL,
    )
    expect(multiline?.message).toContain('`a - b`')
    expect(multiline?.message).not.toContain('\n')

    const [overlong] = toPendingFindings(
      [
        mutant({
          status: 'Survived',
          replacement: '0123456789012345678901234567890123456789012345678901234567890123456789',
        }),
      ],
      STRYKER_TOOL,
    )
    expect(overlong?.message).toContain(
      '`012345678901234567890123456789012345678901234567890123456…`',
    )
  })

  it('reports uncovered and timed-out mutants as advisory, never as graded', () => {
    const findings = toPendingFindings(
      [mutant({ status: 'NoCoverage', startLine: 3 }), mutant({ status: 'Timeout', startLine: 4 })],
      STRYKER_TOOL,
    )
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
    const findings = toPendingFindings(many, STRYKER_TOOL)
    expect(findings).toHaveLength(SURVIVED_FINDING_LIMIT)
    // The cap keeps the first ones by position, so it is the same 50 every run.
    expect(findings.at(-1)?.range.startLine).toBe(SURVIVED_FINDING_LIMIT)
  })
})

/**
 * The generated config is only ever read by Node: Stryker imports the module we
 * write and uses whatever object it exports. So the tests below write it to a
 * real `.mjs` and import it the same way, and assert the config Stryker would
 * actually receive rather than the text it was spelled with.
 */
describe('the generated Stryker config', () => {
  const overrides = buildStrykerOverrides({
    workingDir: '/scratch/stryker',
    reportPath: '/scratch/stryker/mutation-report.json',
  })

  let dir: string
  let written = 0

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'crank-stryker-config-'))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** Renders the module, writes it, and returns the config object Stryker gets. */
  async function generatedConfig(
    base: StrykerBaseConfig | undefined,
  ): Promise<Record<string, unknown>> {
    const path = join(dir, `generated-${(written += 1)}.mjs`)
    await writeFile(path, renderStrykerConfig(overrides, base), 'utf8')
    const loaded: { default: Record<string, unknown> } = await import(pathToFileURL(path).href)
    return loaded.default
  }

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

  it('inlines a JSON config so the repo’s own settings survive', async () => {
    const config = await generatedConfig({
      kind: 'inline',
      config: {
        testRunner: 'vitest',
        coverageAnalysis: 'perTest',
        // The settings we impose: theirs must not win these two.
        tempDirName: '.stryker-tmp',
        reporters: ['html', 'progress'],
      },
    })

    expect(config).toMatchObject({ testRunner: 'vitest', coverageAnalysis: 'perTest' })
    expect(config).toMatchObject({
      tempDirName: '/scratch/stryker/stryker-tmp',
      reporters: ['json'],
    })

    // A repo that owns Stryker without a config contributes nothing: the
    // generated module is the overrides and only the overrides.
    expect(await generatedConfig(undefined)).toEqual(overrides)
  })

  it('imports a JS config from Stryker’s own process rather than ours', async () => {
    const base = join(dir, 'stryker.config.mjs')
    await writeFile(base, 'export default { testRunner: "jest", tempDirName: ".stryker-tmp" }\n')

    const config = await generatedConfig({ kind: 'module', url: pathToFileURL(base).href })

    expect(config).toMatchObject({
      testRunner: 'jest',
      tempDirName: '/scratch/stryker/stryker-tmp',
      reporters: ['json'],
    })
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

  /**
   * An empty scope is not "mutate everything": the runner has to stop before it
   * spawns Stryker, or a docs-only PR would mutate the whole repo.
   */
  it('scopes to nothing when a change touched no mutable file', async () => {
    const result = await strykerRunner.run({
      ...CONTEXT,
      detection: {
        reason: 'config',
        configFiles: ['stryker.config.json'],
        installed: true,
        binPath: '/repo/node_modules/.bin/stryker',
      },
      changedFiles: ['README.md'],
    })

    expect(result).toMatchObject({ state: 'not-available', findings: [], rawFiles: [] })
    expect(result.reason).toBe(
      'this change touched no JavaScript or TypeScript file Stryker could mutate',
    )
  })
})

describe('the runner’s posture', () => {
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
