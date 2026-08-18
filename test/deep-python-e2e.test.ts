import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HealthScanResult } from '../src/run.ts'
import { runHealthScan } from '../src/run.ts'
import type { FixtureRepo } from './support/fixture.ts'
import { createFixtureRepo } from './support/fixture.ts'
import { reportFindings } from '../src/render/json.ts'

/**
 * `--deep` against the real cosmic-ray and coverage.py, on the
 * `py-weak-tests` fixture.
 *
 * **Gated for the same reason as `deep-e2e.test.ts`**: both tools only ever run
 * from the project's own virtualenv, so the test has to build one (`uv venv` +
 * `uv pip install`). Run it with:
 *
 * ```
 * CRANK_DEEP_E2E=1 npx vitest run test/deep-python-e2e.test.ts
 * ```
 *
 * What it is really here to prove is the part no unit test can: that the
 * generated TOML config, the baseline-then-init-then-exec sequence and the
 * session dump line up with the tool as installed — and that a mutation run
 * which edits files in place leaves the target byte-identical afterwards.
 */

const ENABLED = process.env['CRANK_DEEP_E2E'] === '1'

/** Roomy: building a virtualenv, then a mutation run over every mutant. */
const DEEP_TIMEOUT_MS = 600_000

describe.runIf(ENABLED)('--deep on a Python repo with a weak test suite', () => {
  let fixture: FixtureRepo
  let out: string
  let deep: HealthScanResult

  beforeAll(async () => {
    fixture = await createFixtureRepo('py-weak-tests')
    out = await mkdtemp(join(tmpdir(), 'crank-deep-py-out-'))
    const uv = (args: string[]) => execa('uv', args, { cwd: fixture.root })
    await uv(['venv', '--quiet', '.venv'])
    await uv([
      'pip',
      'install',
      '--quiet',
      '--python',
      '.venv/bin/python',
      'cosmic-ray',
      'coverage',
      'pytest',
    ])

    deep = await runHealthScan({ path: fixture.root, out, only: ['test-quality'], deep: true })
  }, DEEP_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
    await rm(out, { recursive: true, force: true })
  })

  it('grades test quality from cosmic-ray’s mutation score', () => {
    const score = deep.report.metrics['test-quality']?.mutationScore
    expect(score).toBeDefined()
    expect(score).toBeGreaterThan(0)
    /*
     * The fixture's counts, hand-checked against the captured run in
     * `test/captured/cosmic-ray-8.7.0.jsonl`, which mutates the same `add` and
     * `classify`: 27 mutants there, 13 killed by the two assertions in
     * `test_calc.py` (48%). `shipping`, which no test calls, adds at least 15
     * more surviving mutants of its own (5 comparison-operator mutants on
     * `weight > 20`, plus 2 `NumberReplacer` mutants for each of its five
     * literals), so the score is at most 13/42 = 31%. spec §3's band table
     * puts anything under 35% at F.
     */
    expect(score).toBeLessThan(35)
    expect(deep.report.categories['test-quality']).toEqual({ status: 'graded', grade: 'F' })
  })

  it('reports the surviving mutants, in the mutated module', () => {
    const survived = reportFindings(deep.report).filter(
      (finding) => finding.rule === 'cosmic-ray/survived-mutant',
    )
    expect(survived.length).toBeGreaterThan(0)
    expect(survived.every((finding) => finding.file === 'pkg/calc.py')).toBe(true)
    expect(survived.every((finding) => finding.gradeScope)).toBe(true)
  })

  it('measures coverage alongside it, as context rather than as a grade', () => {
    const coverage = deep.report.tools.find((tool) => tool.tool === 'coverage')
    expect(coverage?.state).toBe('ok')

    // Coverage is measured and reported beside the mutation score…
    const metrics = deep.report.metrics['test-quality']
    expect(metrics?.lineCoveragePercent).toBeDefined()
    // …and never moves the grade, which is the mutation score's band alone.
    expect(metrics?.mutationScore).toBeDefined()
    // Whole-repo runs report no per-line findings; only a PR does.
    expect(reportFindings(deep.report).filter((finding) => finding.tool === 'coverage')).toEqual([])
  })

  it('leaves the target untouched, mutated files restored and no caches written', async () => {
    expect(await fixture.status()).toBe('')
    const entries = await readdir(fixture.root)
    expect(entries).not.toContain('.pytest_cache')
    expect(entries).not.toContain('__pycache__')
    expect(entries).not.toContain('.coverage')
    expect(await readdir(join(fixture.root, 'pkg'))).toEqual(['__init__.py', 'calc.py'])
  })
})
